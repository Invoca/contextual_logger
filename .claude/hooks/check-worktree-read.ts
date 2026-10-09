#!/usr/bin/env -S node --experimental-strip-types
// Blocks Read (and NotebookRead) tool calls whose target resolves into a
// DIFFERENT, tracked git tree than the session's own — the read-side
// counterpart to check-worktree-edit.ts's worktree isolation guard.
//
// WHY THIS IS NOT A MIRROR OF check-worktree-edit.ts'S PREDICATE
//
// check-worktree-edit.ts asks a TARGET-anchored question: "does this write
// land in the main working tree?" — correct for writes, because a write into
// main is wrong regardless of who makes it. A Read is different: this repo's
// own `adlc/` is itself routinely a symlink into a wholly separate MAIN
// working tree (e.g. a Homebrew Cellar checkout). Naively applying the
// edit guard's "target resolves into a main tree -> block" rule to Read
// would block every agent everywhere from reading its own role-definition
// doc under `adlc/`, because that doc's real location is a main tree that
// has nothing to do with the session at hand.
//
// Read legitimacy instead depends on the PAIR: who is reading (is the
// session itself in a linked worktree?) and what they are reading (does the
// target resolve to a DIFFERENT tree OF THE SAME REPO, and is it actually
// tracked there?). A read is blocked only when ALL of:
//   (a) the session dir is inside a linked worktree,
//   (b) the target is in the same repo as the session,
//   (c) the target resolves to a different tree than the session's own, and
//   (d) the target is tracked in that target tree (checked LAST, so an
//       untracked file — .env, .task, briefing.md, build output — is always
//       readable even across trees).
// Every other shape (same-tree reads, a main session reading a worktree,
// cross-repo reads, untracked targets) is legitimate and must ALLOW.
//
// To bypass in an emergency: set ALLOW_CROSS_TREE_READ=1 in the environment.
//
// This file's own hook directory (adlc/methods/hooks/) cannot import from
// lib/: the mirror-sync CI invariant requires this file to be byte-identical
// to its .claude/hooks/ counterpart, which sits at a different relative
// depth, so any import path into a shared lib/ would diverge between the two
// copies. A flat, mirrored sibling import (this file importing directly from
// check-worktree-edit.ts, which lives right next to it in both locations) is
// possible, but deliberately not used here: the two files' symlink-resolution
// logic is instead copied verbatim into each, so this file stays fully
// self-contained (no relative import back into any sibling).
//
// readStdin, extractTarget's shape, and the top-level try/catch exit-2
// fail-closed wrapper are adapted from check-worktree-edit.ts; see that file
// for the fuller rationale on each. resolveDestination/resolveSymlinkChain/
// resolveExistingPrefix/MAX_SYMLINK_HOPS below are copied verbatim from that
// same file.

import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lstatSync, readSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isatty } from 'node:tty';

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
 * Resolve the read's physical destination: Stage 1 follows the leaf's own
 * symlink chain (which an ancestor walk never touches), Stage 2 resolves the
 * deepest existing prefix of whatever Stage 1 produced. Returns the resolved
 * destination and the existing directory to authorize on (`anchor`), or a
 * failure naming where resolution stalled and why.
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
  cwd?: unknown;
  tool_input?: ToolInput;
}

/** Read succeeded and here is the payload, or the read failed and why. */
type StdinRead = { ok: true; data: string } | { ok: false; reason: string };

const STDIN_DEADLINE_MS = 10_000;
// Much smaller than check-worktree-edit.ts's 64MB: a Read (or NotebookRead)
// envelope carries no file body, only a path and some options, so a huge
// payload here is itself a signal something is wrong rather than a
// legitimate large write.
const STDIN_MAX_BYTES = 1 * 1024 * 1024;
const STDIN_CHUNK_BYTES = 65_536;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the whole PreToolUse envelope before deciding anything; a partial
 * read would leave the Runner writing into a closed pipe. No piped input
 * (an interactive TTY on stdin) reads as no payload — mirrors the Bash-era
 * `[ ! -t 0 ]` guard, which never blocks waiting on a terminal.
 *
 * isatty(0), NOT process.stdin.isTTY — see check-worktree-edit.ts's readStdin
 * for why touching the process.stdin getter is unsafe here.
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

/** Target + session dir extracted, or the envelope could not be read. */
type EnvelopeRead = { ok: true; target: string; sessionDir: string } | { ok: false; reason: string };

/**
 * Read uses tool_input.file_path; NotebookRead uses tool_input.notebook_path
 * — and the `Read` matcher in .claude/settings.json is an unanchored regex,
 * so it also matches the tool name `NotebookRead`. `.path` is checked too,
 * matching some Runners' spelling of Edit's target (kept for parity with
 * check-worktree-edit.ts's extractTarget).
 *
 * An empty envelope (no piped stdin) or one with no target field yields no
 * target -> nothing to enforce (exit 0, see main()). A NON-EMPTY envelope
 * that will not parse as JSON is a failure, not a fallback: falling back to
 * "no target" here would authorize on the session cwd for a call this hook
 * could not actually inspect, so it must BLOCK instead (same posture as
 * check-worktree-edit.ts's extractTarget).
 */
function parseEnvelope(payload: string): EnvelopeRead {
  if (payload.trim() === '') {
    return { ok: true, target: '', sessionDir: process.cwd() };
  }
  let parsed: PreToolUsePayload;
  try {
    parsed = JSON.parse(payload) as PreToolUsePayload;
  } catch {
    return { ok: false, reason: 'the envelope on stdin is not valid JSON' };
  }
  const { file_path: filePath, path, notebook_path: notebookPath } = parsed.tool_input ?? {};
  let target = '';
  if (typeof filePath === 'string' && filePath !== '') {
    target = filePath;
  } else if (typeof path === 'string' && path !== '') {
    target = path;
  } else if (typeof notebookPath === 'string' && notebookPath !== '') {
    target = notebookPath;
  }
  const sessionDir = typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : process.cwd();
  return { ok: true, target, sessionDir };
}

interface AnchorInfo {
  /** Always absolute — `git rev-parse --show-toplevel`'s own guarantee. */
  topLevel: string;
  /** Raw `--git-dir` output; used only for the `/worktrees/` shape check. */
  gitDir: string;
  /** `--git-common-dir`, resolved to an absolute, realpath'd string — the
   *  one value that's identical across the main tree and every linked
   *  worktree of the same repo, so it doubles as a same-repo identity. */
  commonDirResolved: string;
}

/**
 * One `git rev-parse` per anchor, exactly as prescribed: `--show-toplevel`
 * for same/different-tree, `--git-dir`'s `/worktrees/` shape (same
 * convention check-worktree-edit.ts already uses) to tell a linked worktree
 * from the main tree, and `--git-common-dir` (resolved + realpath'd) to tell
 * whether two anchors belong to the same repo at all.
 *
 * Returns null on ANY failure (not a git repo, `dir` doesn't exist, git not
 * on PATH, malformed output) — the caller fails OPEN on that, not closed;
 * see main()'s comment on why.
 */
function anchorInfo(dir: string): AnchorInfo | null {
  try {
    const raw = execFileSync('git', ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .split('\n');
    const topLevel = raw[0] ?? '';
    const gitCommonDirRaw = raw[1] ?? '';
    const gitDir = raw[2] ?? '';
    if (!topLevel || !gitCommonDirRaw || !gitDir) {
      return null;
    }
    const commonDirAbs = isAbsolute(gitCommonDirRaw) ? gitCommonDirRaw : resolve(dir, gitCommonDirRaw);
    let commonDirResolved = commonDirAbs;
    try {
      commonDirResolved = realpathSync(commonDirAbs);
    } catch {
      // Leave it lexically resolved rather than failing the whole anchor —
      // a common-dir that itself can't be realpath'd is unusual but not, on
      // its own, a reason to fail open here.
      //
      // Known narrow gap: commonDirResolved is used for a same-repo equality
      // check against the OTHER anchor's commonDirResolved (see main()'s
      // "same repo" condition). If realpathSync throws for exactly one side
      // of that comparison but succeeds for the other, the two sides can end
      // up compared as lexical-vs-realpath'd, which could in theory make an
      // actual same-repo pair compare as different-repo. This requires a
      // directory to vanish mid-check between the two anchorInfo() calls —
      // consistent with this file's fail-open posture, this is a known,
      // accepted narrow gap, not an oversight.
    }
    return { topLevel, gitDir, commonDirResolved };
  } catch {
    console.error(`check-worktree-read: git rev-parse failed for anchor ${dir}`);
    return null;
  }
}

/** True iff `target` is tracked by git in the tree rooted at `treeRoot`. */
function isTrackedInTree(treeRoot: string, target: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', target], {
      cwd: treeRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    console.error(`check-worktree-read: git ls-files failed for ${target} in ${treeRoot}`);
    return false;
  }
}

/**
 * Denial diagnostics + the harness's BLOCK exit code. Exit code 2 (not 1) is
 * what the Claude Code hook harness treats as BLOCK for PreToolUse; exit 1
 * is non-blocking and the harness proceeds with the tool call anyway.
 */
function deny(headline: string, detail: string): never {
  console.error(`WORKTREE VIOLATION: ${headline}`);
  console.error(detail);
  console.error('Read from the correct worktree, or the file you need from its own tree.');
  console.error('Emergency bypass (use sparingly): set ALLOW_CROSS_TREE_READ=1');
  process.exit(2);
}

function main(): void {
  if (process.env.ALLOW_CROSS_TREE_READ === '1') {
    process.exit(0);
  }

  const stdin = readStdin();
  if (!stdin.ok) {
    deny(
      `the tool call could not be read (${stdin.reason}), so this read cannot be cleared.`,
      'Blocked target: <unknown — the tool call could not be read>',
    );
  }

  const envelope = parseEnvelope(stdin.data);
  if (!envelope.ok) {
    deny(
      `the tool call could not be read (${envelope.reason}), so this read cannot be cleared.`,
      'Blocked target: <unknown — the tool call could not be read>',
    );
  }

  const { target, sessionDir } = envelope;
  if (target === '') {
    // No target in the envelope -- nothing to enforce.
    process.exit(0);
  }

  // Resolution failure fails CLOSED (deny, exit 2): an unresolvable
  // destination (a symlink cycle, or a resolution errno other than "does not
  // exist yet") cannot be cleared, same posture as check-worktree-edit.ts.
  const resolution = resolveDestination(target);
  if (!resolution.ok) {
    deny(
      `the read target could not be resolved (${resolution.reason}), so this read cannot be cleared.`,
      `Blocked target: ${target}\nUnresolved at: ${resolution.at} (${resolution.reason})`,
    );
  }
  const resolvedTarget = resolution.destination;

  const lexicalSessionDir = resolve(sessionDir);
  let resolvedSessionDir = lexicalSessionDir;
  try {
    resolvedSessionDir = realpathSync(lexicalSessionDir);
  } catch {
    // Leave it lexically resolved -- a session dir that no longer exists (a
    // deleted worktree) is handled by anchorInfo()'s own fail-open below, not
    // here.
  }

  // Lexical fast path FIRST, before any git subprocess: a target inside the
  // session's own directory is always legitimate, and this is the common
  // case, so it exits at zero git cost. Both sides are now the physically
  // resolved path (symlinks followed), not the lexical string, so a
  // worktree-local symlink pointing outside the worktree cannot clear this
  // path merely because its OWN path lexically starts with the session dir.
  if (resolvedTarget === resolvedSessionDir || resolvedTarget.startsWith(resolvedSessionDir + sep)) {
    process.exit(0);
  }

  const targetAnchor = resolution.anchor;

  const sessionInfo = anchorInfo(resolvedSessionDir);
  if (!sessionInfo) {
    // Fail OPEN on a git failure here (e.g. a deleted-worktree cwd, or the
    // session dir not being a git repo at all) -- this is specifically about
    // a missing/gone tree, not an unreadable tool-call envelope, so it is
    // deliberately NOT the fail-closed posture the top-level catch-all
    // below uses.
    process.exit(0);
  }

  // (a) session dir is inside a linked worktree. Checked before computing
  // targetInfo (below): every other case (a main session, or a session
  // already in the main tree) exits right here, so there is no reason to
  // pay for a second `git rev-parse` subprocess on the target anchor until
  // this condition has passed.
  const sessionIsLinkedWorktree = sessionInfo.gitDir.includes('/worktrees/');
  if (!sessionIsLinkedWorktree) {
    process.exit(0);
  }

  const targetInfo = anchorInfo(targetAnchor);
  if (!targetInfo) {
    // Fail OPEN for the same reason as sessionInfo above -- a missing/gone
    // target tree, not an unreadable tool-call envelope.
    process.exit(0);
  }

  // (b) target is in the same repo as the session.
  const sameRepo = sessionInfo.commonDirResolved === targetInfo.commonDirResolved;
  if (!sameRepo) {
    process.exit(0);
  }

  // (c) target resolves to a DIFFERENT tree than the session's own.
  const differentTree = sessionInfo.topLevel !== targetInfo.topLevel;
  if (!differentTree) {
    process.exit(0);
  }

  // (d) target is tracked in the target tree -- checked LAST, so an
  // untracked file (.env, .task, briefing.md, build output) always ALLOWs
  // even when every other condition above would otherwise BLOCK.
  if (!isTrackedInTree(targetInfo.topLevel, resolvedTarget)) {
    process.exit(0);
  }

  deny(
    "reads must stay inside the session's own worktree; this target is tracked in a different tree of the same repo.",
    `Blocked target: ${resolvedTarget}\nSession tree: ${sessionInfo.topLevel}\nTarget tree: ${targetInfo.topLevel}`,
  );
}

try {
  main();
} catch {
  console.error('check-worktree-read: unexpected internal error; failing closed.');
  // Exit code 2 (not 1) is what the Claude Code hook harness treats as
  // BLOCK for PreToolUse; exit 1 is non-blocking and the harness proceeds
  // with the tool call anyway. An unhandled crash here must fail closed,
  // not open.
  process.exit(2);
}
