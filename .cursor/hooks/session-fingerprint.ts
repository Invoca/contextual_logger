#!/usr/bin/env -S node --experimental-strip-types
// Committed Cursor session-fingerprint wrapper. Deployed to `.cursor/hooks/`
// so `sessionEnd` still has an invocable path when the `adlc/` symlink is
// missing (an unbootstrapped Cursor consumer clone, or a consumer Cursor
// Cloud VM — no Homebrew).
//
// If `adlc/methods/hooks/session-fingerprint.ts` exists, exec it with the
// same stdin (inherited, never piped — the framework hook reads its payload
// off fd 0 directly via readFileSync). There is no JSON envelope and no mode
// argv here, same as the worktree-edit wrapper this mirrors — the payload
// passes through byte-agnostic. Cursor's `workspace_roots` and nullable
// `transcript_path` differences are handled inside session-fingerprint.ts
// itself (resolveWorkingDir() and the transcript_path existence guard), not
// in this wrapper.
//
// One deliberate divergence from the worktree-edit wrapper: this always
// exits 0, never propagating the wrapped hook's exit status. `sessionEnd`
// has no block semantic — there is nothing downstream that a non-zero exit
// could stop — so the wrapped hook's own unconditional-exit-0 contract is
// preserved rather than reinterpreted as pass/fail.
//
// If the framework hook is not reachable, exit 0 silently. Never fail-closed
// on a missing framework tree — that is the Titan PR 7122 brick (the hook
// *path* errors, so Cursor blocks the tool).
//
// setup.sh / consumer sync copies this file to .cursor/hooks/session-fingerprint.ts.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_REL = join('adlc', 'methods', 'hooks', 'session-fingerprint.ts');

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

function main(): void {
  const hook = frameworkHookPath();
  if (!hook) {
    process.exit(0);
  }
  spawnSync(process.execPath, ['--experimental-strip-types', hook, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  // The child's outcome (error, non-zero exit, anything) is deliberately
  // never inspected: `sessionEnd` cannot block, so there is nothing
  // downstream an exit code could affect either way. See the file header's
  // "One deliberate divergence" note.
  process.exit(0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`cursor-session-fingerprint: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
}
