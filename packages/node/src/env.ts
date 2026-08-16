import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Structurally what process.env is, without the ambient type: a partial object
// literal satisfies this, so callers do not need a cast.
type EnvLike = Record<string, string | undefined>;

// worker.mts parsed .env.local properly while agent-worker.mts and the resolver
// below each used a bare `^KEY\s*=\s*(\S+)` regex. The regexes disagree with the
// parser on a quoted value or a commented line, so the parser wins.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Trailing `# comment` on an unquoted value. Only unquoted: worker.mts
      // stripped it unconditionally, which truncated a quoted value that
      // legitimately contained " #".
      const hash = value.indexOf(" #");
      if (hash > 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvLocal(dir: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(resolve(dir, ".env.local"), "utf8"));
  } catch {
    return {};
  }
}

// CONVEX_URL wins; then .env.local; then derive it from the deployment name.
// `dir` is the repo root: worker.mts used process.cwd() here, which only worked
// when it happened to be launched from the repo root.
export function resolveConvexUrl(dir: string, env: EnvLike = process.env): string | null {
  if (env.CONVEX_URL) return env.CONVEX_URL;
  const fromFile = loadEnvLocal(dir).CONVEX_URL;
  if (fromFile) return fromFile;
  const match = env.CONVEX_DEPLOYMENT?.match(/^(?:dev|prod):(.+)$/);
  return match ? `https://${match[1]}.convex.cloud` : null;
}
