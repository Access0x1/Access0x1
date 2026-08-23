/**
 * load-local-env.mts — make standalone scripts see `web/.env.local`.
 *
 * WHY: the Next server loads `.env.local` itself, but the standalone tsx scripts
 * (`npm run fund`, `npm run mvp-presentation`) read only `process.env` — so a key
 * an operator carefully set in `.env.local` was invisible to exactly the scripts
 * that need it, and the loop fell back to an ephemeral wallet every run.
 *
 * Deliberately minimal and safe:
 *   - fills ONLY keys that are unset/empty in `process.env` (a var you export in
 *     the shell always wins);
 *   - parses `KEY=value`, ignoring blanks/comments, stripping matched quotes and
 *     trailing ` #` comments on unquoted values (same dialect as env:doctor);
 *   - returns the NAMES it loaded — values never leave `process.env`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load `web/.env.local` (or an explicit path) into unset process.env keys. */
export function loadLocalEnv(
  path: string = resolve(HERE, "..", ".env.local"),
): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue; // a blank slot is "unset", not an empty override
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
