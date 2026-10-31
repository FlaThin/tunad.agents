import { readFileSync } from "fs";
import { parse } from "yaml";

interface IndexEntry {
  pattern: string;
  glob: string;
}

interface Config {
  index: IndexEntry[];
}

const EXCLUDE_DIRS = [
  "node_modules", ".git", "dist", "build", "bin", "obj",
  ".next", "vendor", "coverage", "__pycache__", ".venv",
];

function globToIncludes(glob: string): string[] {
  const filename = glob.split("/").pop() ?? glob;
  const braceMatch = filename.match(/^\*\.{(.+)}$/);
  if (braceMatch) {
    return braceMatch[1]!.split(",").map((ext) => `*.${ext.trim()}`);
  }
  return [filename];
}

function runGrep(pattern: string, glob: string): string[] {
  const includes = globToIncludes(glob).flatMap((inc) => ["--include", inc]);
  const excludes = EXCLUDE_DIRS.flatMap((dir) => ["--exclude-dir", dir]);

  const proc = Bun.spawnSync(["grep", "-rnE", pattern, ".", ...includes, ...excludes], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!proc.stdout) return [];
  return new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
}

function formatLine(line: string): string {
  const match = line.match(/^\.?\/?(.+?):(\d+):(.+)$/);
  if (!match) return line;
  return `${match[1]}:${match[2]} :: ${match[3]!.trim()}`;
}

async function main() {
  const configPath = process.argv[2] ?? "tunad.agents.yml";

  let config: Config;
  try {
    config = parse(readFileSync(configPath, "utf-8")) as Config;
  } catch (err) {
    throw new Error(`Não foi possível ler ${configPath}: ${err}`);
  }

  if (!Array.isArray(config.index) || config.index.length === 0) {
    throw new Error(`Nenhuma entrada em 'index' no ${configPath}`);
  }

  const seen = new Set<string>();
  const results: string[] = [];

  for (const entry of config.index) {
    const lines = runGrep(entry.pattern, entry.glob);
    for (const line of lines) {
      const formatted = formatLine(line);
      if (!seen.has(formatted)) {
        seen.add(formatted);
        results.push(formatted);
      }
    }
  }

  const output = results.join("\n");
  await Bun.write(".tunad-index.txt", output);

  console.log(`Indexados ${results.length} símbolos → .tunad-index.txt`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
