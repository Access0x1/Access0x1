/**
 * load-local-env.test.ts — the standalone-script env loader.
 *
 * Pins the three properties that make it safe: it fills only UNSET process.env
 * keys (an exported shell var always wins), a blank slot is "unset" (never an
 * empty-string override), and a missing file is a clean no-op. This is the seam
 * that makes `npm run fund` / `npm run mvp-presentation` see the same
 * `web/.env.local` the operator filled for the app.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalEnv } from "../../scripts/load-local-env.mts";

const TOUCHED = ["T_LLE_A", "T_LLE_B", "T_LLE_BLANK", "T_LLE_QUOTED"] as const;
let dir: string | undefined;

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function envFile(content: string): string {
  dir = mkdtempSync(join(tmpdir(), "lle-"));
  const p = join(dir, ".env.local");
  writeFileSync(p, content);
  return p;
}

describe("loadLocalEnv", () => {
  it("fills unset keys and reports their NAMES", () => {
    const p = envFile("T_LLE_A=hello # trail\n# comment\nT_LLE_QUOTED='q v'\n");
    const loaded = loadLocalEnv(p);
    expect(process.env.T_LLE_A).toBe("hello");
    expect(process.env.T_LLE_QUOTED).toBe("q v");
    expect(loaded.sort()).toEqual(["T_LLE_A", "T_LLE_QUOTED"]);
  });

  it("never overrides a var already set in the shell", () => {
    process.env.T_LLE_B = "shell-wins";
    const p = envFile("T_LLE_B=file-value\n");
    const loaded = loadLocalEnv(p);
    expect(process.env.T_LLE_B).toBe("shell-wins");
    expect(loaded).toEqual([]);
  });

  it("treats a blank slot as unset — no empty-string override", () => {
    const p = envFile("T_LLE_BLANK=\n");
    const loaded = loadLocalEnv(p);
    expect(process.env.T_LLE_BLANK).toBeUndefined();
    expect(loaded).toEqual([]);
  });

  it("is a clean no-op when the file does not exist", () => {
    expect(loadLocalEnv("/nonexistent/nowhere/.env.local")).toEqual([]);
  });
});
