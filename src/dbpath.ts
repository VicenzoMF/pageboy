import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the default database path so the CLI (`add`, run from your shell) and
 * the MCP server (`serve`, spawned by the editor) agree on the *same* file
 * regardless of which working directory they happen to start in.
 *
 * The old default — `./data/pageboy.db` relative to cwd — silently diverged
 * whenever `add` and `serve` ran from different directories. This anchors the
 * DB to a stable, discoverable location instead.
 *
 * Priority:
 *   1. PAGEBOY_DB — explicit override always wins.
 *   2. An existing `data/pageboy.db` in cwd or any ancestor — reuse a project's
 *      DB even when invoked from a subdirectory.
 *   3. `data/pageboy.db` at the nearest git repo root — anchors a fresh project
 *      to one spot no matter where inside it pageboy runs.
 *   4. `~/.pageboy/pageboy.db` — per-user fallback when not inside any project.
 */
export function resolveDefaultDb(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PAGEBOY_DB) return resolve(env.PAGEBOY_DB);

  let dir = resolve(cwd);
  let gitRoot: string | null = null;
  while (true) {
    if (existsSync(join(dir, "data", "pageboy.db"))) {
      return join(dir, "data", "pageboy.db");
    }
    if (gitRoot === null && existsSync(join(dir, ".git"))) {
      gitRoot = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (gitRoot) return join(gitRoot, "data", "pageboy.db");
  return join(homedir(), ".pageboy", "pageboy.db");
}
