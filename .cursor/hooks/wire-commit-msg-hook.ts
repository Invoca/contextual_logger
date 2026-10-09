#!/usr/bin/env -S node --experimental-strip-types
// Committed Cursor commit-msg-hook wiring wrapper. Deployed to
// `.cursor/hooks/` so `sessionStart` still has an invocable path when the
// `adlc/` symlink is missing (an unbootstrapped Cursor consumer clone, or a
// consumer Cursor Cloud VM — no Homebrew).
//
// If `adlc/methods/hooks/wire-commit-msg-hook.ts` exists, exec it with the
// same stdin (inherited, never piped — the framework hook reads its payload
// off fd 0 directly). There is no mode argv here, same as the
// session-fingerprint wrapper this mirrors — the payload passes through
// byte-agnostic.
//
// Always exits 0, never propagating the wrapped hook's exit status:
// `sessionStart` is best-effort and non-blocking, and the wrapped hook's own
// unconditional-exit-0 contract is preserved rather than reinterpreted as
// pass/fail.
//
// If the framework hook is not reachable, exit 0 silently. Never fail-closed
// on a missing framework tree — that is the Titan PR 7122 brick (the hook
// *path* errors, so Cursor blocks the tool).
//
// setup.sh / consumer sync copies this file to .cursor/hooks/wire-commit-msg-hook.ts.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_REL = join('adlc', 'methods', 'hooks', 'wire-commit-msg-hook.ts');

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
  // The child's outcome is deliberately never inspected: `sessionStart`
  // cannot block, so there is nothing downstream an exit code could affect
  // either way.
  process.exit(0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`cursor-wire-commit-msg-hook: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
}
