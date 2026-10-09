#!/usr/bin/env -S node --experimental-strip-types
// Blocks Edit and Write tool calls that land in the main repo working tree.
// All file changes must go through a worktree (ADLC mandatory worktree rule).
//
// AUTHORIZE ON THE FILE, NOT THE SESSION CWD
//
// The question this hook answers is "is this write landing in a linked
// worktree?", not "is this session sitting in one?". Runners routinely keep the
// session root on one tree while Edit/Write targets another, and judging by
// process cwd inverts the guard in both directions: a session in a worktree
// could write into main (fail open), and a session on main could not write
// into its own worktree (fail closed). So the tool call is read from stdin
// and the decision is anchored on the target path.
//
// Detection: `git rev-parse --git-dir` returns ".git" (relative) in the main
// working tree and an absolute path ending in .git/worktrees/<name> in any
// linked worktree created by `git worktree add`.
//
// Known assumption: detection relies on git's internal convention that linked
// worktree git-dirs are always under .git/worktrees/. Repos using
// --separate-git-dir with a path that happens to contain "/worktrees/" would
// be treated as a linked worktree (false negative). This is not expected in
// standard ADLC setups.
//
// To bypass in an emergency: set ALLOW_MAIN_EDIT=1 in the environment.
// Cursor Cloud (/exec-daemon + /workspace) is also allowed: the VM is the
// isolation boundary, Write/Edit stay rooted at /workspace, and requiring a
// linked worktree bricks the session (Titan PR 7122). Laptop / Claude Code
// isolation is unchanged. Both exceptions process.exit(0) before resolution
// ever runs, so a resolution failure can never reach them.
//
// Ported from the original Bash implementation per
// docs/code/bash-to-ts-conversion-recipe.md (the pilot conversion). Same
// control flow, same stdin/exit-code contract, same diagnostics wording —
// proven identical by the black-box test suite in
// test/worktree-edit-guard.test.ts, which stayed unmodified across the
// conversion.
//
// DESTINATION RESOLUTION (not just nearest existing ancestor)
//
// The target string is not itself the write's physical destination: its
// final component may be a symlink (direct, relative, or a chain of them),
// and a dangling leaf link still names a real destination because open()
// CREATES the link's target. Resolution runs in two stages before the
// existing /worktrees/ authorization test:
//
//   Stage 1 (resolveSymlinkChain) walks the leaf's symlink chain with
//   lstat/readlink, joining a relative link target against the REAL
//   (realpathSync'd) directory containing the link -- not lexically -- so a
//   symlinked ancestor cannot make a lexical `..` diverge from what the
//   kernel would actually do. It stops at the first non-symlink (which may
//   not exist yet: that not-yet-existing path IS the destination). The hop
//   cap is 40, matching Linux's ELOOP limit (macOS's is 32), so the hook is
//   never STRICTER than the kernel -- a chain long enough to fail on macOS
//   but not Linux is still resolved and judged here, and merely fails at
//   open() on macOS, which is harmless. A leaf cycle cannot be detected via
//   ELOOP (lstat on a cyclic link succeeds and reports a symlink -- lstat
//   never touches the final component), so the chain is walked manually
//   under the hop cap to see it at all.
//
//   Stage 2 (resolveExistingPrefix) realpaths the deepest existing prefix of
//   whatever Stage 1 produced, retains the unresolved suffix (the
//   not-yet-created path components), and anchors on that resolved
//   directory (or its parent, if the fully-resolved path is itself an
//   existing file/other-non-directory). One rule -- anchor on the resolved
//   path if it is a directory, else on its parent -- covers an existing
//   file, an existing directory, a deep new path, and a prefix that hits a
//   plain file, with no per-shape branching. This also closes a latent
//   fail-open: Write to an existing directory path used to anchor on that
//   directory's PARENT (via dirname(target)) instead of the directory
//   itself.
//
// RESOLUTION-FAILURE SEMANTICS: an unresolvable destination fails CLOSED
// (BLOCK, exit 2, through deny() so the diagnostic names what happened); a
// resolved destination that turns out to sit outside any git repository
// still fails OPEN (unchanged -- "not a git repo, nothing to enforce").
// ENOENT/ENOTDIR on a path component is not a failure -- it is peeled and
// resolution continues, because that is the ordinary new-file/new-directory
// case. Every other errno (EACCES, EPERM, ENAMETOOLONG, ...) and a tripped
// symlink-hop cap (chain-too-long or a genuine cycle) are resolution
// failures and BLOCK, matching the file's existing fail-closed posture for
// an unreadable stdin payload and an unhandled exception.

import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isatty } from 'node:tty';
import { isCursorCloud } from './cursor-cloud.ts';

// macOS's ELOOP cap is 32 hops; Linux's is 40. Taking the larger bound
// guarantees this hook is never stricter than the kernel it is protecting:
// a chain long enough to trip macOS but not Linux is still resolved and
// judged on its merits here, and merely fails (harmlessly) at open() time on
// macOS. Only a chain that would exceed even Linux's cap -- or an actual
// cycle, which loops forever until some cap stops it -- reaches the
// resolution-failure path below.
const MAX_SYMLINK_HOPS = 40;

/** Resolution succeeded with this destination, or failed at this path for this reason. */
type Resolution =
  | { ok: true; destination: string; anchor: string }
  | { ok: false; at: string; reason: string };

/**
 * Stage 1: follow the TARGET'S OWN leaf symlink chain (not just its
 * ancestors) to the first non-symlink path -- which may not exist. Returns
 * that path, or a failure if the chain cannot be resolved (an unreadable
 * intermediate, or the hop cap tripping on a cycle/excessively long chain).
 */
function resolveSymlinkChain(target: string): { ok: true; path: string } | { ok: false; at: string; reason: string } {
  let p = resolve(process.cwd(), target);
  for (let hops = 0; ; hops++) {
    if (hops > MAX_SYMLINK_HOPS) {
      return { ok: false, at: p, reason: `symlink chain exceeded ${MAX_SYMLINK_HOPS} hops (cycle or excessively long chain)` };
    }
    let st;
    try {
      st = lstatSync(p);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        break; // p does not exist (or a component isn't a dir) -- p IS the destination
      }
      return { ok: false, at: p, reason: code ?? 'unknown error' };
    }
    if (!st.isSymbolicLink()) {
      break; // p is the destination
    }
    let link: string;
    let linkDirReal: string;
    try {
      link = readlinkSync(p);
      // A relative link target is resolved by the kernel against the
      // PHYSICAL directory containing the link, not the lexical one -- so
      // realpath the containing directory before joining. dirname(p) is
      // guaranteed to exist here (p itself was just lstat'd successfully).
      linkDirReal = realpathSync(dirname(p));
    } catch (error) {
      return { ok: false, at: p, reason: (error as NodeJS.ErrnoException).code ?? 'unknown error' };
    }
    p = resolve(linkDirReal, link);
  }
  return { ok: true, path: p };
}

/**
 * Stage 2: realpath the deepest existing prefix of `p`, retaining the
 * unresolved suffix (path components that do not exist yet -- the normal
 * new-file/new-directory case). Anchors on the resolved directory itself,
 * or its parent when the fully-resolved path is an existing non-directory.
 */
function resolveExistingPrefix(p: string): Resolution {
  const suffix: string[] = [];
  let probe = p;
  let real: string;
  for (;;) {
    try {
      real = realpathSync(probe);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        const parent = dirname(probe);
        if (parent === probe) {
          return { ok: false, at: p, reason: 'no existing ancestor' };
        }
        suffix.unshift(basename(probe));
        probe = parent;
        continue;
      }
      return { ok: false, at: probe, reason: code ?? 'unknown error' }; // fail closed
    }
  }
  const destination = suffix.length > 0 ? join(real, ...suffix) : real;

  let anchor: string;
  try {
    anchor = statSync(real).isDirectory() ? real : dirname(real);
  } catch (error) {
    return { ok: false, at: real, reason: (error as NodeJS.ErrnoException).code ?? 'unknown error' }; // fail closed
  }

  return { ok: true, destination, anchor };
}

/**
 * Resolve the write's physical destination: Stage 1 follows the leaf's own
 * symlink chain (which nearestExistingAncestor-style ancestor walks never
 * touch), Stage 2 resolves the deepest existing prefix of whatever Stage 1
 * produced. Returns the resolved destination and the existing directory to
 * authorize on (`anchor`), or a failure naming where resolution stalled and
 * why.
 */
function resolveDestination(target: string): Resolution {
  const chain = resolveSymlinkChain(target);
  if (!chain.ok) {
    return chain;
  }
  return resolveExistingPrefix(chain.path);
}

interface ToolInput {
  file_path?: unknown;
  path?: unknown;
  notebook_path?: unknown;
}

interface PreToolUsePayload {
  tool_input?: ToolInput;
}

/** Read succeeded and here is the payload, or the read failed and why. */
type StdinRead = { ok: true; data: string } | { ok: false; reason: string };

const STDIN_DEADLINE_MS = 10_000;
// Generous: a Write envelope legitimately carries a whole file body, and
// every step below is linear in its size.
const STDIN_MAX_BYTES = 64 * 1024 * 1024;
const STDIN_CHUNK_BYTES = 65_536;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the whole PreToolUse envelope before deciding anything; a partial
 * read would leave the Runner writing into a closed pipe. No piped input
 * (an interactive TTY on stdin) reads as no payload — mirrors the Bash
 * script's `[ ! -t 0 ]` guard, which never blocks waiting on a terminal.
 *
 * isatty(0), NOT process.stdin.isTTY: touching the process.stdin getter
 * constructs libuv's stream for fd 0, and for a pipe that sets O_NONBLOCK on
 * the descriptor, which made the read below fail with EAGAIN on any envelope
 * larger than the pipe buffer (65536 bytes) — routine for a Write, whose
 * envelope carries the whole file body. The failure was swallowed and read as
 * "no target", so the guard fell back to the session cwd and allowed writes
 * into the main tree.
 */
function readStdin(): StdinRead {
  if (isatty(0)) {
    return { ok: true, data: '' };
  }
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(STDIN_CHUNK_BYTES);
  const deadline = Date.now() + STDIN_DEADLINE_MS;
  let total = 0;
  for (;;) {
    let count: number;
    try {
      count = readSync(0, buffer, 0, STDIN_CHUNK_BYTES, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') {
        if (Date.now() >= deadline) {
          return { ok: false, reason: `stdin delivered no complete payload within ${STDIN_DEADLINE_MS}ms` };
        }
        if (code !== 'EINTR') {
          sleepMs(1);
        }
        continue;
      }
      if (code === 'EOF') {
        break;
      }
      return { ok: false, reason: `stdin read failed (${code ?? 'unknown error'})` };
    }
    if (count === 0) {
      break;
    }
    total += count;
    if (total > STDIN_MAX_BYTES) {
      return { ok: false, reason: `stdin payload exceeded ${STDIN_MAX_BYTES} bytes` };
    }
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return { ok: true, data: Buffer.concat(chunks).toString('utf8') };
}

/** Target extracted (possibly empty), or the envelope could not be read. */
type TargetRead = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Write uses tool_input.file_path; some Runners spell Edit's target as
 * tool_input.path; NotebookEdit spells its target as
 * tool_input.notebook_path. Every field missing/empty yields no target and
 * falls back to the session cwd, same as the Bash script's `jq` failure
 * fallback — but a NON-EMPTY envelope that will not parse is a failure, not a
 * fallback: the fallback authorizes on the cwd, which for a worktree session
 * allows every main-tree write, so an envelope this hook cannot read must
 * BLOCK instead.
 */
function extractTarget(payload: string): TargetRead {
  if (payload.trim() === '') {
    return { ok: true, target: '' };
  }
  let parsed: PreToolUsePayload;
  try {
    parsed = JSON.parse(payload) as PreToolUsePayload;
  } catch {
    return { ok: false, reason: 'the envelope on stdin is not valid JSON' };
  }
  const { file_path: filePath, path, notebook_path: notebookPath } = parsed.tool_input ?? {};
  if (typeof filePath === 'string' && filePath !== '') {
    return { ok: true, target: filePath };
  }
  if (typeof path === 'string' && path !== '') {
    return { ok: true, target: path };
  }
  if (typeof notebookPath === 'string' && notebookPath !== '') {
    return { ok: true, target: notebookPath };
  }
  return { ok: true, target: '' };
}

/**
 * Existence check succeeded (`isRepo` says which way), or git could not be
 * invoked at all to find out.
 */
type GitRepoCheck = { ok: true; isRepo: boolean } | { ok: false; reason: string };

/**
 * Existence check, separate from the value capture below. Distinguishes two
 * very different failure shapes of the same `execFileSync` call (F6): git
 * RAN and reported a definite verdict (`isRepo:
 * false` on the ordinary, expected "not a git repository" exit -- editing
 * outside any repository at all is legitimate, so this must stay ALLOW) vs.
 * git could not be INVOKED at all (ENOENT: no `git` executable anywhere on
 * PATH, or another spawn-level failure) -- which tells this hook nothing
 * about whether the target is a worktree, so it must fail closed (`ok:
 * false`) rather than collapse into the same silent ALLOW as the first case.
 * A process that ran to completion always has a numeric `status` (0 on
 * success or the failing exit code); a spawn failure never gets that far, so
 * `status` stays non-numeric (`null`) -- that's the distinguishing signal.
 */
function isGitRepo(cwd: string): GitRepoCheck {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' });
    return { ok: true, isRepo: true };
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number | null }).status;
    if (typeof status === 'number') {
      // git ran and exited non-zero (typically 128, "not a git repository
      // (or any of the parent directories)") -- a normal, expected verdict.
      return { ok: true, isRepo: false };
    }
    return { ok: false, reason: (error as NodeJS.ErrnoException).code ?? 'unknown error' };
  }
}

/**
 * Separate from isGitRepo() above so a transient git error here doesn't
 * silently allow an edit: a failure yields "", which fails the
 * "/worktrees/" match below and falls through to the fail-safe BLOCK path,
 * exactly like the Bash script's unguarded `$(... 2>/dev/null)` capture.
 */
function gitDirValue(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Denial diagnostics + the harness's BLOCK exit code. Exit code 2 (not 1) is
 * what the Claude Code hook harness treats as BLOCK for PreToolUse; exit 1 is
 * non-blocking and the harness proceeds with the tool call anyway.
 */
function deny(headline: string, detail: string): never {
  console.error(`WORKTREE VIOLATION: ${headline}`);
  console.error(detail);
  console.error('Create a worktree first:');
  console.error('  adlc-cli git worktree add --branch <branch-name>');
  console.error('If that fails because the parent directory is not writable (e.g. Cursor Cloud):');
  console.error('  ADLC_CLI_WORKTREE_SHAPE=in-repo adlc-cli git worktree add --branch <branch-name>');
  console.error('Do not use the in-repo location when the parent is writable — sibling stays the default there.');
  console.error('Then cd into the worktree and retry, addressing files by that worktree\'s absolute path (Cursor Write/Edit stay rooted at the main checkout).');
  console.error('Emergency bypass (use sparingly): set ALLOW_MAIN_EDIT=1');
  process.exit(2);
}

function main(): void {
  if (process.env.ALLOW_MAIN_EDIT === '1') {
    process.exit(0);
  }

  // Cursor Cloud: single-tenant ephemeral checkout already on a feature
  // branch. Write/Edit stay rooted at /workspace even after `cd` into an
  // in-repo worktree, so requiring a linked worktree bricks the session
  // instead of isolating it. Laptop / Claude Code isolation is unchanged.
  if (isCursorCloud()) {
    process.exit(0);
  }

  const stdin = readStdin();
  if (!stdin.ok) {
    deny(
      `the tool call could not be read (${stdin.reason}), so this edit cannot be cleared.`,
      'Blocked target: <unknown — the tool call could not be read>',
    );
  }
  const extracted = extractTarget(stdin.data);
  if (!extracted.ok) {
    deny(
      `the tool call could not be read (${extracted.reason}), so this edit cannot be cleared.`,
      'Blocked target: <unknown — the tool call could not be read>',
    );
  }
  const target = extracted.target;

  // No target in the envelope: unchanged — resolution is skipped, anchor
  // stays the session cwd, and the diagnostic string below is unchanged.
  let anchor = '.';
  let destination = target;
  if (target) {
    const resolution = resolveDestination(target);
    if (!resolution.ok) {
      deny(
        `the edit destination could not be resolved (${resolution.reason}), so this edit cannot be cleared.`,
        `Blocked target: ${target}\nUnresolved at: ${resolution.at} (${resolution.reason})`,
      );
    }
    anchor = resolution.anchor;
    destination = resolution.destination;
  }

  const repoCheck = isGitRepo(anchor);
  if (!repoCheck.ok) {
    deny(
      `git could not be invoked to determine whether this location is inside a repository (${repoCheck.reason}), so this edit cannot be cleared.`,
      `Blocked target: ${target || `<no path in tool call; used cwd ${process.cwd()}>`}`,
    );
  }
  if (!repoCheck.isRepo) {
    // Not a git repo — nothing to enforce.
    process.exit(0);
  }

  const gitDir = gitDirValue(anchor);

  // In a linked worktree, git-dir is an absolute path ending in
  // .git/worktrees/<name>.
  if (gitDir.includes('/worktrees/')) {
    process.exit(0);
  }

  // Main working tree — block the edit. Name the resolved destination too,
  // in addition to the submitted target, whenever a symlink (or a chain of
  // them) made the two differ — the target the caller wrote is not the same
  // string as where the write would actually land.
  const blockedTargetLine = `Blocked target: ${target || `<no path in tool call; used cwd ${process.cwd()}>`}`;
  const detail =
    target && destination !== target ? `${blockedTargetLine}\nResolved destination: ${destination}` : blockedTargetLine;
  deny('file edits are not allowed in the main repo working tree.', detail);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Exit code 2 (not 1) is what the Claude Code hook harness treats as BLOCK
  // for PreToolUse; exit 1 is non-blocking and the harness proceeds with the
  // tool call anyway. An unhandled crash here must fail closed, not open.
  process.exit(2);
}
