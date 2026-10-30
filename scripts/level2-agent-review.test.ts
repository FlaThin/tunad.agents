import { describe, it, expect } from "bun:test";

describe("extractSection", () => {
  it("extracts content between markdown headings", () => {
    const body = `## Contexto\nTexto do contexto\n## Critérios de Aceite\n- item 1\n## Fora do Escopo\nnada`;

    const lines = body.split("\n");
    let capturing = false;
    const result: string[] = [];
    const heading = "Contexto";

    for (const line of lines) {
      if (line.trim().startsWith("##") && line.toLowerCase().includes(heading.toLowerCase())) {
        capturing = true;
        continue;
      }
      if (capturing && line.trim().startsWith("##")) break;
      if (capturing) result.push(line);
    }

    expect(result.join("\n").trim()).toBe("Texto do contexto");
  });

  it("returns empty string when heading not found", () => {
    const body = `## Outro Heading\nconteúdo`;
    const heading = "Inexistente";

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

    expect(result.join("\n").trim()).toBe("");
  });
});

describe("extractIssueNumber", () => {
  it("extracts issue number from PR body", () => {
    const body = "Closes #42";
    const match = body.match(/[Cc]loses\s+#(\d+)/);
    expect(match?.[1]).toBe("42");
  });

  it("handles lowercase 'closes'", () => {
    const body = "closes #7";
    const match = body.match(/[Cc]loses\s+#(\d+)/);
    expect(match?.[1]).toBe("7");
  });

  it("returns null when no reference found", () => {
    const body = "some PR without issue reference";
    const match = body.match(/[Cc]loses\s+#(\d+)/);
    expect(match).toBeNull();
  });
});
