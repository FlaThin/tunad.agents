import Anthropic from "@anthropic-ai/sdk";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const PR_NUMBER = process.env.PR_NUMBER!;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY!;

const MAX_PATCH_CHARS = 8000;
const MAX_TOTAL_CHARS = 30000;

interface GitHubFile {
  filename: string;
  status: string;
  patch?: string;
}

interface GitHubComment {
  id: number;
  user: { login: string };
  body: string;
}

interface CriterionResult {
  criterion: string;
  status: "PASSOU" | "FALHOU" | "INCERTO";
  justification: string;
}

interface ReviewResult {
  verdict: "APROVADO" | "REPROVADO" | "INCERTO";
  summary: string;
  criteria_results: CriterionResult[];
  issues_found: string[];
  suggestions: string[];
}

function validateEnv(): { owner: string; repo: string } {
  const required = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "PR_NUMBER", "GITHUB_REPOSITORY"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
  }
  const [owner, repo] = GITHUB_REPOSITORY.split("/") as [string, string];
  if (!owner || !repo) throw new Error(`GITHUB_REPOSITORY inválido: ${GITHUB_REPOSITORY}`);
  return { owner, repo };
}

const { owner, repo } = validateEnv();

async function githubFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body !== undefined;
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${path}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function extractIssueNumber(prBody: string): number | null {
  const match = prBody.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return match?.[1] ? parseInt(match[1]) : null;
}

function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  let capturing = false;
  const result: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith("#") && line.toLowerCase().includes(heading.toLowerCase())) {
      capturing = true;
      continue;
    }
    if (capturing && line.trim().startsWith("#")) break;
    if (capturing) result.push(line);
  }
  return result.join("\n").trim();
}

function applyTotalBudget(files: GitHubFile[]): Array<{ filename: string; status: string; patch: string | null }> {
  let totalChars = 0;
  return files.map((f) => {
    if (totalChars >= MAX_TOTAL_CHARS) {
      return { filename: f.filename, status: f.status, patch: "[omitido: limite total atingido]" };
    }
    if (!f.patch) return { filename: f.filename, status: f.status, patch: null };
    const patch = f.patch.length > MAX_PATCH_CHARS
      ? f.patch.slice(0, MAX_PATCH_CHARS) + "\n[... truncated ...]"
      : f.patch;
    totalChars += patch.length;
    return { filename: f.filename, status: f.status, patch };
  });
}

function buildComment(review: ReviewResult, issueNumber: number): string {
  const verdictIcon: Record<ReviewResult["verdict"], string> = {
    APROVADO: "✅",
    REPROVADO: "❌",
    INCERTO: "⚠️",
  };

  const statusIcon: Record<CriterionResult["status"], string> = {
    PASSOU: "✅",
    FALHOU: "❌",
    INCERTO: "⚠️",
  };

  const criteriaRows = review.criteria_results
    .map((r) => `| ${r.criterion} | ${statusIcon[r.status]} ${r.status} | ${r.justification} |`)
    .join("\n");

  const issuesList = review.issues_found.length
    ? `\n### Problemas Encontrados\n${review.issues_found.map((i) => `- ${i}`).join("\n")}`
    : "";

  const suggestionsList = review.suggestions.length
    ? `\n### Sugestões\n${review.suggestions.map((s) => `- ${s}`).join("\n")}`
    : "";

  return `## ${verdictIcon[review.verdict]} Agent Review — Nível 2

**Veredicto:** ${review.verdict}
${review.summary}

### Critérios de Aceite

| Critério | Status | Justificativa |
|----------|--------|---------------|
${criteriaRows}
${issuesList}
${suggestionsList}

---
*Review automático baseado no Issue #${issueNumber} · Modelo: claude-sonnet-4-6*`;
}

function normalizeReview(raw: unknown): ReviewResult {
  const r = raw as Record<string, unknown>;
  return {
    verdict: (["APROVADO", "REPROVADO", "INCERTO"].includes(r["verdict"] as string)
      ? r["verdict"]
      : "INCERTO") as ReviewResult["verdict"],
    summary: typeof r["summary"] === "string" ? r["summary"] : "Revisão concluída.",
    criteria_results: Array.isArray(r["criteria_results"]) ? r["criteria_results"] as CriterionResult[] : [],
    issues_found: Array.isArray(r["issues_found"]) ? r["issues_found"] as string[] : [],
    suggestions: Array.isArray(r["suggestions"]) ? r["suggestions"] as string[] : [],
  };
}

async function deleteOldReviewComments(prNumber: string): Promise<void> {
  const comments = await githubFetch<GitHubComment[]>(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
  );

  const botComments = comments.filter(
    (c) => c.user.login === "github-actions[bot]" && c.body.includes("Agent Review — Nível 2")
  );

  await Promise.all(
    botComments.map((c) =>
      githubFetch(`/repos/${owner}/${repo}/issues/comments/${c.id}`, {
        method: "DELETE",
      }).catch(() => {})
    )
  );
}

async function postComment(prNumber: string, body: string): Promise<void> {
  await githubFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function main() {
  const pr = await githubFetch<{ body: string | null }>(
    `/repos/${owner}/${repo}/pulls/${PR_NUMBER}`
  );

  const issueNumber = extractIssueNumber(pr.body ?? "");
  if (!issueNumber) {
    console.log("Nenhuma referência de issue encontrada no PR. Pulando agent review.");
    process.exit(0);
  }

  const [issue, files] = await Promise.all([
    githubFetch<{ title: string; body: string | null }>(
      `/repos/${owner}/${repo}/issues/${issueNumber}`
    ),
    githubFetch<GitHubFile[]>(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}/files`),
  ]);

  const truncatedFiles = applyTotalBudget(files);

  const issueBody = issue.body ?? "";
  const context = extractSection(issueBody, "Contexto");
  const criteria = extractSection(issueBody, "Critérios de Aceite");
  const outOfScope = extractSection(issueBody, "Fora do Escopo");

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `Você é um revisor de código. Verifique se o PR implementa corretamente os critérios da tarefa abaixo.

## Issue #${issueNumber}: ${issue.title}

### Contexto
${context}

### Critérios de Aceite
${criteria}

### Fora do Escopo
${outOfScope}

## Diff do PR
${JSON.stringify(truncatedFiles, null, 2)}

## Instrução
Analise o diff e verifique cada critério de aceite. Responda APENAS com um bloco JSON dentro de \`\`\`json ... \`\`\`, neste formato:
{
  "verdict": "APROVADO" | "REPROVADO" | "INCERTO",
  "summary": "frase curta com o veredicto geral",
  "criteria_results": [
    { "criterion": "texto", "status": "PASSOU" | "FALHOU" | "INCERTO", "justification": "razão objetiva" }
  ],
  "issues_found": ["problema concreto encontrado, se houver"],
  "suggestions": ["sugestão opcional"]
}

Baseie-se apenas no que está no diff. Não invente problemas.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = response.content[0]?.type === "text" ? response.content[0].text : "";

  // Prefer JSON inside code fence, fall back to first bare object
  const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fencedMatch?.[1] ?? rawText.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) {
    throw new Error(`Claude retornou resposta sem JSON válido:\n${rawText}`);
  }

  const review = normalizeReview(JSON.parse(jsonStr));
  const comment = buildComment(review, issueNumber);

  await deleteOldReviewComments(PR_NUMBER);
  await postComment(PR_NUMBER, comment);

  console.log(`Agent Review: ${review.verdict} — ${review.summary}`);

  if (review.verdict === "REPROVADO") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
