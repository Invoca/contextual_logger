#!/usr/bin/env -S node --experimental-strip-types
// Committed Cursor version-check wrapper. Deployed to `.cursor/hooks/` so
// Edit/Write still have an invocable path when the `adlc/` symlink is
// missing (consumer Cursor Cloud VMs — no Homebrew).
//
// If `adlc/methods/hooks/check-adlc-version.ts` exists, exec it with the
// same stdin and remaining argv. If it does not, allow: PreToolUse emits
// permissionDecision allow; SessionStart is silent. Never fail-closed on a
// missing framework tree — that is the Titan PR 7122 brick (the hook *path*
// errors, so Cursor blocks the tool). The framework script itself would
// no-op via isSelfOrUnmanaged() if it could run.
//
// setup.sh / consumer sync copies this file to .cursor/hooks/check-adlc-version.ts.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK_REL = join('adlc', 'methods', 'hooks', 'check-adlc-version.ts');

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

function allowMissingFramework(): never {
  const mode = (process.argv[2] ?? '').toLowerCase();
  if (mode === 'pretooluse') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      }) + '\n',
    );
  }
  process.exit(0);
}

function main(): void {
  const hook = frameworkHookPath();
  if (!hook) {
    allowMissingFramework();
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', hook, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (result.error) {
    allowMissingFramework();
  }
  process.exit(result.status ?? 0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`cursor-check-adlc-version: ${error instanceof Error ? error.message : String(error)}\n`);
  allowMissingFramework();
}
