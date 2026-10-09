#!/usr/bin/env -S node --experimental-strip-types
// Committed Cursor worktree-edit wrapper. Deployed to `.cursor/hooks/` so
// Edit/Write still have an invocable path when the `adlc/` symlink is
// missing (consumer Cursor Cloud VMs — no Homebrew).
//
// If `adlc/methods/hooks/check-worktree-edit.ts` exists, exec it with the
// same stdin (inherited, never piped — the guard reads its PreToolUse
// envelope off fd 0 directly) and propagate its exit code unchanged: 0
// allows, 2 blocks. There is no JSON envelope and no mode argv here — the
// guard signals exit-code-only, unlike the version-check wrapper it mirrors.
// If the framework hook is not reachable, allow silently (exit 0). Never
// fail-closed on a missing framework tree — that is the Titan PR 7122 brick
// (the hook *path* errors, so Cursor blocks the tool).
//
// Once the framework hook has been found, any outcome other than a verdict
// it actually produced — a spawn failure, or the child dying to a signal
// instead of exiting — fails closed (exit 2, the guard's own block code).
// A found-but-unexecuted guard is not the "framework tree absent" case this
// wrapper exists to allow through.
//
// setup.sh / consumer sync copies this file to .cursor/hooks/check-worktree-edit.ts.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FRAMEWORK_REL = join('adlc', 'methods', 'hooks', 'check-worktree-edit.ts');

// Cursor runs hooks with cwd at the workspace root; the deployed copy lives
// at .cursor/hooks/, two levels below it. No candidate is resolved relative
// to this file's canonical location under adlc/methods/cloud/ — that would
// let the framework checkout's own hook mask a missing consumer adlc/.
function frameworkHookPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(process.cwd(), FRAMEWORK_REL), join(here, '..', '..', FRAMEWORK_REL)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Once the framework hook has been found, any outcome other than a verdict
// it actually produced fails closed (exit 2, the guard's own block code): a
// spawn failure (`result.error` — EACCES, ENOMEM, a TOCTOU race between the
// existence check and the spawn), or the child dying to a signal instead of
// exiting (`result.status === null` with no `error`). A found-but-unexecuted
// guard is not the "framework tree absent" case this wrapper exists to allow
// through. Exported so the fail-closed decision itself is unit-testable
// without spawning a process into each failure mode.
export function exitCodeForSpawnResult(result: { error?: Error | null; status: number | null }): number {
  if (result.error) return 2;
  if (result.status === null) return 2;
  return result.status;
}

function main(): void {
  const hook = frameworkHookPath();
  if (!hook) {
    process.exit(0);
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', hook, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(exitCodeForSpawnResult(result));
}

// True when this file is running as the invoked script (direct exec or
// `node ... this-file`), false when a test imports it for its exports.
// Importing must never trigger main()'s process.exit side effects.
function invokedAsCli(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(argv1).href === import.meta.url || argv1.endsWith('check-worktree-edit.ts');
  } catch {
    return argv1.endsWith('check-worktree-edit.ts');
  }
}

if (invokedAsCli()) {
  try {
    main();
  } catch (error) {
    // An unanticipated throw is also an unresolved verdict, so it fails closed
    // for the same reason the spawn-failure and signal-death paths do. The one
    // allow-through case remains `if (!hook)` inside main(): framework tree
    // genuinely absent.
    process.stderr.write(`cursor-check-worktree-edit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
