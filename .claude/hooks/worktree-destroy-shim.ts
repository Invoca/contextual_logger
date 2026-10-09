#!/usr/bin/env -S node --experimental-strip-types
// worktree-destroy-shim.ts — PreToolUse (Bash) dispatch shim in front of the
// worktree-destroy guard.
//
// WHY THIS EXISTS
//
// Prefer `adlc-cli hook worktree-destroy` (auto-updates via Homebrew,
// version-floor-gated) over ever re-implementing worktree-destroy detection
// as a locally-committed regex parser. This repo no longer owns
// ANY local fallback for that detection logic — the former
// check-worktree-destroy.ts (a regex-based command parser, ported as-is from
// adlc-cli's own known-bug baseline pending a future upstream redesign) was
// deleted by explicit, informed operator override, ahead of two things that
// would normally have gated the deletion: that upstream redesign shipping, and
// guaranteed adlc-cli availability across every bootstrap path. This file's
// job changed accordingly: it no longer decides which of two detectors to
// run — there is only one, external, detector left. Its job now is to
// verify that detector meets the required version floor and dispatch to it,
// or, if it doesn't, refuse to guess and BLOCK instead.
//
// FAIL-CLOSED version-floor probe, UNCHANGED from this shim's earlier
// design: the mirror image of adlc-cli-prefer-hook.ts's FAIL-OPEN `verbPresent()`. That hook's
// job is optional command redirection (raw `gh`/`git` is always a safe
// fallback), so any uncertainty about the fast path there falls OPEN. This
// hook's probe still evaluates the identical uncertainty set the same way —
// spawn error, non-zero exit, unparseable JSON, a missing verb, a
// below-floor version, a probe that hangs past a bounded timeout — all
// treated as "floor not verified." What changed is ONLY what happens
// next on that outcome (see below), not how the outcome itself is decided.
//
// Floor: 0.20.0 — NOT the release `hook worktree-destroy` first shipped in
// (that was 0.16.0). 0.16.0 through 0.19.x carry the verb but run its
// original regex-based destructive-intent classifier — the exact
// bug-for-bug port of this repo's own former check-worktree-destroy.ts that
// this repo's own investigation found had 35+ live bypasses across
// quote/escape-blanking, path-normalization, and redirect-truncation bug
// families. `Invoca/ADLC-cli` 0.20.0 is the version where
// `hook worktree-destroy`'s internal logic was redesigned onto a genuine
// AST-based store-path-touch detector (`src/shell-ast.ts`), closing those
// bypasses per that release's own notes. A floor of 0.16.0 verifies only
// that the verb NAME exists, not that the safe implementation is behind it
// — that gap is why the floor moved to 0.20.0 (see this repo's own spec
// history for the dated record of this change).
//
// ON A VERIFIED FLOOR (unchanged): exec `adlc-cli hook worktree-destroy`,
// with this process's own stdin/stdout/stderr file descriptors handed
// DIRECTLY to the child (`stdio: 'inherit'`) — the shim never reads,
// buffers, or re-encodes the PreToolUse envelope itself, and the child's
// exit code becomes this process's exit code exactly: a byte-for-byte
// mirror by construction. `adlc-cli hook worktree-destroy`'s own exit code
// is ALWAYS 0 (both BLOCK and ALLOW) — the deny signal is the
// `hookSpecificOutput.permissionDecision` field in its stdout JSON, which
// Claude Code reads for this hook type. Emergency bypass:
// ALLOW_WORKTREE_DESTROY=1 is honored by `adlc-cli hook worktree-destroy`
// itself — duplicating that check here would itself be worktree-destroy
// logic, which this file must not own.
//
// ON A FAILED/BELOW-FLOOR PROBE: BLOCK, not allow. There is no local
// fallback left to dispatch to, and — after direct team pushback on an
// earlier fail-open draft of this file — the deliberate choice is to refuse
// the command rather than let a potentially-destructive worktree operation
// through unchecked just because the preferred detector is unavailable. The
// shim cannot distinguish a destructive command from a benign one once
// adlc-cli is unreachable (it owns no detection logic of its own), so this
// BLOCKS every command the `Bash` PreToolUse matcher hands it in that state
// — not only genuinely destructive ones — until adlc-cli is
// installed/upgraded. See MESSAGE below for the exact, actionable stderr
// text; it is written to make "install/upgrade adlc-cli" immediately
// obvious as the fix, not read as "your command was flagged as
// destructive." This reintroduces, deliberately, the same
// availability-dependent blocking window this repo's Tier-2 worktree-guard
// history already knows about, accepted because an availability gap should
// read as "engineer must act" rather than as a silent, exploitable ALLOW.
//
// Cursor Cloud is the documented exception: those VMs have no Homebrew, and a fail-closed
// probe bricks every Bash tool call (including `git`, installs, and tests).
// Detection is /exec-daemon + /workspace (see cursor-cloud.ts). On Cloud we
// allow so the session can proceed; once the floor is met this branch is unused.
// Laptop isolation is unchanged.
//
// This is DIFFERENT from, and does not reopen, the Gate 1 problem (a Claude
// Code hook failing open when the hook COMMAND ITSELF fails to execute —
// crash, missing interpreter, timeout, spawn error, before any of this
// file's own logic runs at all). That is a platform-level ceiling this file
// cannot control. What this file DOES control is what IT decides once IT is
// running successfully and has merely discovered its preferred dependency
// (adlc-cli) is unavailable — that is an ordinary code choice, and the
// choice here is BLOCK everywhere except Cursor Cloud.
//
// Failure of the shim itself (an uncaught exception in the probe/dispatch
// logic, before a decision is reached) still falls CLOSED, exactly as
// before: a message to stderr and exit 2 (the code the Claude Code
// hook harness treats as PreToolUse BLOCK; exit 1 is non-blocking and the
// harness proceeds with the tool call anyway). This is cheap, unrelated to
// adlc-cli availability, and still worth keeping — an uncaught exception in
// this file's own logic is a bug in the shim, not a signal about the
// external detector's availability.

import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isCursorCloud } from './cursor-cloud.ts';
import { adlcCliLocalCheckoutRemediation, adlcCliRemediation, detectAdlcCliInstallShape } from './adlc-cli-install-shape.ts';

const FLOOR_VERSION = '0.20.0';
const PROBE_TIMEOUT_MS = 5000;
const REQUIRED_VERB = 'hook worktree-destroy';

// Resolve the adlc-cli binary THIS repo should run: its own checked-out
// adlc-cli/ mount point first -- mirroring how adlc/ itself already resolves
// a local checkout over anything on PATH -- falling back to whatever PATH
// finds when that mount point isn't there yet (a bootstrap predating the
// adlc-cli/ symlink, or a standalone adlc-cli install from before the
// fold-in). Read once per process: both the floor probe and the dispatch
// below need the same answer, not two independent PATH lookups that could
// disagree mid-invocation.
//
// VALIDATED, not just existsSync'd (found via security review): a bare
// existsSync accepts ANY file a repo happens to contain at that exact
// path -- not only the symlink createAdlcCliSymlink() actually creates --
// so an untrusted clone carrying a hostile executable there would take
// over this guard's own dispatch (verified live: a hostile plain file
// forged the fail-closed floor probe's response, then approved an
// actually-destructive rm -rf; a relative $CLAUDE_PROJECT_DIR and a
// traversal value join() would otherwise normalize through are the same
// class of bug).
//
// The fix requires BOTH: (1) adlc/ itself is a symlink -- the anchor for
// what "the trusted framework root" means here -- and (2) the candidate
// binary resolves, via realpathSync, to somewhere INSIDE that same
// external framework root AND OUTSIDE this project's own tree.
//
// KNOWN LIMIT of that anchor (security review, round 2): git stores
// symlinks as first-class objects, so repo content CAN ship adlc/ as a
// symlink pointing wherever it likes -- the anchor is not
// bootstrap-only. Condition (2) defeats the same-repo forgery (both
// symlinks resolving back into the project's own tree), but NOT a pair
// of committed symlinks pointing at an attacker-controlled path OUTSIDE
// the project (adlc -> /some/path/adlc plus adlc-cli/bin ->
// /some/path/adlc-cli/bin, with hostile content already at /some/path).
// That shape requires the attacker to have already placed a file
// outside the repository tree on this machine, a materially higher bar
// than "any clone containing a file", and someone with that access is
// usually past needing this hook. It is accepted here as a documented
// judgement call, not an oversight; an anchor the repo cannot influence
// (a framework path recorded at bootstrap time outside the repo) is the
// upgrade path if that bar is ever judged too low.
//
// The second half of the check matters as much as the first: createAdlcCliSymlink()
// symlinks the *bin/ directory itself* (not the individual adlc-cli
// file inside it), so a bare "is this exact file a symlink" check is
// both wrong -- it rejects the legitimate case -- and insufficient,
// since a clone that forges BOTH adlc/ and adlc-cli/bin/adlc-cli as
// ordinary tracked files resolving to each other, entirely within its
// own content, would satisfy a same-repo-only prefix check while never
// leaving attacker control. Requiring the resolved target sit outside
// this project's own directory is what a genuine bootstrap-created
// mount point always satisfies (it always points at an external
// checkout) and a forged same-repo pair never can.
function resolveAdlcCli(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) return 'adlc-cli';
  const local = join(projectDir, 'adlc-cli', 'bin', 'adlc-cli');
  const frameworkSymlink = join(projectDir, 'adlc');
  try {
    if (!lstatSync(frameworkSymlink).isSymbolicLink()) return 'adlc-cli';
    const frameworkRoot = dirname(realpathSync(frameworkSymlink));
    const resolvedLocal = realpathSync(local);
    const resolvedProjectDir = realpathSync(projectDir);
    if (resolvedLocal.startsWith(frameworkRoot + sep) && !resolvedLocal.startsWith(resolvedProjectDir + sep)) {
      return local;
    }
  } catch {
    // Missing/broken symlink, permission error, etc. -- fall through to PATH.
  }
  return 'adlc-cli';
}


// Built lazily (only once the floor probe has already failed) so a healthy
// dispatch never pays for a filesystem shape-detection pass it doesn't need.
//
// Takes the `CliResolution`'s `ok: false` branch and branches on WHY
// resolution gave up (see `resolveVerifiedAdlcCli()`'s own header comment for
// the 3 underlying cases this collapses into 2 message paths):
//
// - `unverifiedLocalCheckout` non-null (Case C: a local mount point RAN but
//   failed version/verb verification) — the problem is proven to be that
//   LOCAL CHECKOUT specifically, so name it directly via
//   `adlcCliLocalCheckoutRemediation()` rather than re-walking PATH at all;
//   a blind PATH walk here would report whatever happens to be installed
//   there (e.g. a separately-installed, perfectly healthy Homebrew keg) and
//   misdiagnose the actual problem as that keg needing a `brew` fix.
// - `unverifiedLocalCheckout` null (Cases A/B: no local mount point at all,
//   or one that couldn't even spawn) — PATH genuinely is the only signal
//   available, so fall back to `detectAdlcCliInstallShape()` /
//   `adlcCliRemediation()` exactly as before, giving the ONE correct fix
//   command whenever the install shape can be determined with confidence,
//   and today's generic multi-option menu only when it lands on `unknown`.
function buildMessage(resolution: Extract<CliResolution, { ok: false }>): string {
  const intro =
    'WORKTREE DESTROY BLOCKED: adlc-cli is not available or below the required version floor ' +
    `(>= ${FLOOR_VERSION}), so this command cannot be verified safe. This is an availability ` +
    'problem, not an accusation that your command is destructive — Bash commands touching the ' +
    'shared worktree store are blocked until adlc-cli is installed/upgraded.\n';
  if (resolution.unverifiedLocalCheckout !== null) {
    return intro + adlcCliLocalCheckoutRemediation(resolution.unverifiedLocalCheckout);
  }
  return intro + adlcCliRemediation(detectAdlcCliInstallShape());
}

// Semver comparator for plain `MAJOR.MINOR.PATCH` strings (no pre-release/
// build-metadata suffixes — adlc-cli's `--capabilities` version field never
// carries one). Returns NaN when either side fails to parse, so a caller
// comparing against a malformed/missing version treats it as "not >=" (i.e.
// below floor) rather than accidentally passing a string compare.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return NaN;
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na !== nb) return na - nb;
  }
  return 0;
}

function meetsFloor(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const cmp = compareVersions(version, FLOOR_VERSION);
  return Number.isFinite(cmp) && cmp >= 0;
}

interface CapabilitiesProbe {
  verbs?: Array<{ name?: unknown }>;
  version?: unknown;
}

// FAIL-CLOSED version-floor probe of ONE candidate binary. `ok: true` ONLY
// on an affirmative, well-formed confirmation that the candidate spawns, the
// probe exits 0, its JSON advertises `hook worktree-destroy` in the `hook`
// capability group, and its top-level `version` is at or above
// FLOOR_VERSION. ANY other outcome — spawn error, non-zero exit, a probe
// that hangs past PROBE_TIMEOUT_MS, unparseable JSON, a missing verb, a
// missing/invalid/below-floor version — is `ok: false`. `spawnFailed`
// distinguishes the one sub-case resolveVerifiedAdlcCli() below treats
// differently: the candidate could not be executed AT ALL (ENOENT/EACCES/
// a broken interpreter, or a hang past PROBE_TIMEOUT_MS that
// `spawnSync`'s own `timeout` option reports as an ETIMEDOUT `r.error`) as
// opposed to "ran, but is the wrong build".
type FloorProbe = { ok: true } | { ok: false; spawnFailed: boolean };

function probeFloor(candidate: string): FloorProbe {
  try {
    // stdin is 'ignore', not inherited: the probe carries no payload of its
    // own and must not consume the tool-call envelope still waiting on this
    // process's own stdin (main() needs that fd untouched for the dispatch
    // that follows a verified floor). stdout is captured for parsing;
    // stderr is ignored — a chatty probe failure is not this hook's
    // business to surface, only its pass/fail outcome is.
    const r = spawnSync(candidate, ['--capabilities', 'hook'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    if (r.error) return { ok: false, spawnFailed: true };
    if (r.status !== 0) return { ok: false, spawnFailed: false };
    const parsed = JSON.parse(r.stdout) as CapabilitiesProbe;
    if (!Array.isArray(parsed.verbs)) return { ok: false, spawnFailed: false };
    if (!parsed.verbs.some((v) => v && v.name === REQUIRED_VERB)) return { ok: false, spawnFailed: false };
    return meetsFloor(parsed.version) ? { ok: true } : { ok: false, spawnFailed: false };
  } catch {
    return { ok: false, spawnFailed: false };
  }
}

// The 3 structurally different ways resolution can give up, threaded through
// explicitly rather than collapsed into a bare `null` (round-5 review item 2):
// buildMessage() needs to know WHICH one happened, because only one of the
// three is a "the local checkout itself is the problem" diagnosis.
//   - `{ ok: true, command }` — a verified candidate to dispatch to.
//   - `{ ok: false, unverifiedLocalCheckout: string }` — a local mount point
//     RAN (spawnFailed:false) but failed version/verb verification. This is
//     the one case a PATH re-walk would misdiagnose: PATH may hold an
//     entirely unrelated, healthy install.
//   - `{ ok: false, unverifiedLocalCheckout: null }` — either no local mount
//     point exists at all, or one exists but couldn't be spawned at all
//     (ENOENT/EACCES/a broken interpreter/a hang) and the PATH fallback
//     also failed. PATH is the only signal available in both sub-cases, so
//     they share the same `null` — the caller re-walks PATH exactly as
//     before.
type CliResolution = { ok: true; command: string } | { ok: false; unverifiedLocalCheckout: string | null };

// Resolves THE binary this invocation will use for BOTH the floor probe and
// the dispatch in main() — one answer, never two independent lookups that
// could disagree mid-invocation. Tries the local mount point first (when
// resolveAdlcCli() validated one), and falls back to bare `adlc-cli` on
// PATH ONLY when the local candidate could not be spawned at all.
//
// Why that fallback exists (security review): without it, a local mount
// point that passes resolveAdlcCli()'s validation but whose binary won't
// execute (a broken interpreter, wrong mode bits, a half-finished
// bootstrap, or a hang past PROBE_TIMEOUT_MS) made the floor probe fail with
// PATH never reconsulted. Off Cursor Cloud that is fail-closed and merely
// annoying; ON Cursor Cloud it takes main()'s fail-OPEN branch — so a broken
// local file flipped a would-be BLOCK into an ALLOW there. Falling back to
// PATH on a spawn failure removes that path entirely. The fallback is
// deliberately narrow: a local candidate that RUNS but reports a below-floor
// version or a missing verb does NOT fall back to PATH — that is a real
// "your local checkout is too old / wrong" signal a dogfooder needs to see,
// surfaced via `unverifiedLocalCheckout`, not masked by whatever happens to
// be on PATH.
function resolveVerifiedAdlcCli(): CliResolution {
  const candidate = resolveAdlcCli();
  const first = probeFloor(candidate);
  if (first.ok) return { ok: true, command: candidate };
  if (candidate !== 'adlc-cli') {
    if (first.spawnFailed) {
      if (probeFloor('adlc-cli').ok) return { ok: true, command: 'adlc-cli' };
      return { ok: false, unverifiedLocalCheckout: null };
    }
    // Ran, but failed verification -- this IS the local checkout's problem.
    return { ok: false, unverifiedLocalCheckout: candidate };
  }
  return { ok: false, unverifiedLocalCheckout: null };
}

function block(message: string): never {
  console.error(message);
  // Exit code 2 (not 1) is what the Claude Code hook harness treats as BLOCK
  // for PreToolUse; exit 1 is non-blocking and the harness proceeds with the
  // tool call anyway.
  process.exit(2);
}

function main(): void {
  const resolution = resolveVerifiedAdlcCli();
  if (!resolution.ok) {
    // Deliberate fail-CLOSED: no local detector remains to fall back to, and
    // per direct team feedback (see this repo's spec history) the
    // shim must not let a potentially-destructive command through just
    // because its preferred dependency is unavailable.
    // Laptop / Claude Code stay fail-closed. Cursor Cloud has no Homebrew and
    // cannot install adlc-cli from a blocked shell, so allow here.
    if (isCursorCloud()) {
      console.error(
        'WORKTREE DESTROY SHIM: adlc-cli is unavailable or below ' +
          FLOOR_VERSION +
          '; allowing Bash on Cursor Cloud. Install adlc-cli to restore AST-based detection.',
      );
      process.exit(0);
    }
    block(buildMessage(resolution));
  }

  const result = spawnSync(resolution.command, ['hook', 'worktree-destroy'], { stdio: 'inherit' });
  if (result.error || result.signal || typeof result.status !== 'number') {
    throw new Error(
      `dispatch to adlc-cli hook worktree-destroy did not complete normally ` +
        `(${result.error?.message ?? result.signal ?? 'no exit code'})`,
    );
  }
  process.exit(result.status);
}

try {
  main();
} catch (error) {
  // Same fail-closed posture as before: an unhandled failure in THIS
  // script's own probe/dispatch logic (not the external detector, which
  // fails closed on its own terms) must never resolve to a silent allow.
  console.error(
    `WORKTREE DESTROY BLOCKED: the dispatch shim failed before a decision could be reached (${
      error instanceof Error ? error.message : String(error)
    }), so this command cannot be cleared.`,
  );
  // Exit code 2 (not 1) is what the Claude Code hook harness treats as BLOCK
  // for PreToolUse; exit 1 is non-blocking and the harness proceeds with the
  // tool call anyway.
  process.exit(2);
}
