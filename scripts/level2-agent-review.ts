import Anthropic from "@anthropic-ai/sdk";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const PR_NUMBER = process.env.PR_NUMBER!;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY!;

const [owner, repo] = GITHUB_REPOSITORY.split("/") as [string, string];

const MAX_PATCH_CHARS = 8000;

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

async function githubFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${path}`);
  }
  return response.json() as Promise<T>;
}

function extractIssueNumber(prBody: string): number | null {
  const match = prBody.match(/[Cc]loses\s+#(\d+)/);
  return match?.[1] ? parseInt(match[1]) : null;
}

function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  let capturing = false;
  const result: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith("##") && line.toLowerCase().includes(heading.toLowerCase())) {
      capturing = true;
      continue;
    }
    if (capturing && line.trim().startsWith("##")) break;
    if (capturing) result.push(line);
  }
  return result.join("\n").trim();
}

function truncatePatch(patch: string | undefined): string | null {
  if (!patch) return null;
  return patch.length > MAX_PATCH_CHARS
    ? patch.slice(0, MAX_PATCH_CHARS) + "\n[... truncated ...]"
    : patch;
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

async function deleteOldReviewComments(prNumber: string): Promise<void> {
  const comments = await githubFetch<GitHubComment[]>(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments`
  );

  const botComments = comments.filter(
    (c) =>
      c.user.login === "github-actions[bot]" &&
      c.body.includes("Agent Review — Nível 2")
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
    console.log("Nenhuma referência de issue encontrada no PR (Closes #N). Pulando agent review.");
    process.exit(0);
  }

  const [issue, files] = await Promise.all([
    githubFetch<{ title: string; body: string | null }>(
      `/repos/${owner}/${repo}/issues/${issueNumber}`
    ),
    githubFetch<GitHubFile[]>(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}/files`),
  ]);

  const truncatedFiles = files.map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: truncatePatch(f.patch),
  }));

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
Analise o diff e verifique cada critério de aceite. Responda APENAS com JSON válido neste formato:
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

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude retornou resposta sem JSON válido:\n${rawText}`);
  }

  const review = JSON.parse(jsonMatch[0]) as ReviewResult;
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
