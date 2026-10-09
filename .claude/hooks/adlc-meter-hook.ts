#!/usr/bin/env -S node --experimental-strip-types
// adlc-meter-hook.ts -- forwards Runner hook events to adlc-meter, which
// records ADLC telemetry spans to a machine-local store outside every repository
// (see ledger_dir in adlc-meter.ts).
//
// Registered on two events (both carry hook_event_name, so one script routes
// both -- see adlc-init.md "Runner Hooks Setup"):
//   PostToolUse, matcher "Agent|Task"  -> dispatch metadata for one agent
//   Stop                               -> one adlc.session.turn span per turn,
//                                         plus one adlc.agent.<role> span per agent
//
// Note which event emits the agent spans: Stop, not PostToolUse. PostToolUse for an
// agent that itself dispatches others fires long before that agent has finished, so
// recording there captured a fraction of the real usage (measured at 11-46% for the
// orchestrator across six runs). It now only stores the few facts the transcript
// cannot state, which the Stop-time read merges in.
//
// PostToolUse fires AFTER the dispatched agent has returned to whoever dispatched
// it, so this script only ever observes work already done -- it cannot gate or
// block a dispatch (contrast with the PreToolUse check-worktree-edit.ts, which does
// block). "Returned to its dispatcher" is not the same as "the whole subtree is
// finished", which is exactly why the agent span is emitted at Stop instead.
//
// MUST NEVER fail or block: every failure path degrades to a dropped telemetry
// line and the script always exits 0 as its last action. A missing adlc-meter,
// a malformed payload, or an unwritable ledger are all no-ops.
//
// Ported from the original Bash implementation per
// docs/code/bash-to-ts-conversion-recipe.md. Same control flow, same
// stdin/exit-code contract, same diagnostics wording — proven identical by
// the black-box test suite in test/adlc-meter-hook.test.ts, which stayed
// unmodified across the conversion.

import { execFileSync, spawn } from 'node:child_process';
import { globSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function gitShowToplevel(cwd: string): string {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return '';
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isReadableFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function expandTilde(p: string, home: string): string {
  if (p.startsWith('~')) {
    return home + p.slice(1);
  }
  return p;
}

// Trusted-root validation for a repo-derived meter candidate, mirroring
// worktree-destroy-shim.ts's resolveAdlcCli(). Threat: `payloadRoot`/`repoRoot`
// come from `git rev-parse --show-toplevel` against whatever repo the Runner
// happens to be sitting in -- an untrusted clone/fork can force-commit a file
// at `adlc/methods/hooks/adlc-meter.ts` (a gitignored path in a legitimate
// bootstrap, but not gitignored to an attacker's own fork) containing
// arbitrary TypeScript. Before this hook existed to close it, a developer
// merely opening such a repo would have that file executed with their
// privileges on the first Agent/Task dispatch or turn end. `adlc/` is a real
// bootstrap-created framework mount ONLY when it is a symlink; requiring the
// candidate's realpath to resolve inside that symlink's real target AND
// outside the prefix's own tree defeats both a same-repo forgery (both
// `adlc` and the meter script committed as ordinary files pointing at each
// other) and a bare "file exists at this path" check.
//
// KNOWN, DELIBERATE LIMIT (matches check-adlc-version.ts's/adlc-cli's own
// isSelfOrUnmanaged() precedent): when `adlc/` is a real, non-symlinked
// directory, this returns null unconditionally -- including for this
// framework's OWN checkout, where `adlc/` is legitimately the tracked source
// tree rather than a consumer's bootstrap mount. That framework-self shape
// is, by pure filesystem inspection, INDISTINGUISHABLE from a hostile fork
// of this very repo shipping the identical shape with a poisoned
// `adlc/methods/hooks/adlc-meter.ts` -- there is no filesystem-only signal
// that tells the two apart, so trusting one means trusting both. Telemetry
// silently no-ops for this framework's own repo/worktrees as the accepted
// cost of refusing that ambiguity rather than guessing; ADLC_HOME (below)
// is the documented, operator-configured escape hatch for a contributor who
// wants their own telemetry back.
function trustedFrameworkRoot(prefix: string): string | null {
  try {
    const frameworkSymlink = join(prefix, 'adlc');
    if (!lstatSync(frameworkSymlink).isSymbolicLink()) return null;
    return dirname(realpathSync(frameworkSymlink));
  } catch {
    return null;
  }
}

// Resolves a repo-derived candidate to its trusted, realpath'd form -- or
// null if untrusted. Returning the REALPATH (not the original candidate
// string) matters: main() below uses only this returned value for every
// subsequent readability/executability/spawn check, so a symlink swapped
// after this call (but before use) cannot make the executed file diverge
// from the one just validated (the same shape worktree-destroy-shim.ts
// accepts as a narrow, documented tradeoff -- closed here since this file
// exists specifically to harden untrusted-execution paths).
function resolveTrustedRepoCandidate(candidate: string, prefix: string): string | null {
  const frameworkRoot = trustedFrameworkRoot(prefix);
  if (!frameworkRoot) return null;
  try {
    const resolvedCandidate = realpathSync(candidate);
    const resolvedPrefix = realpathSync(prefix);
    if (resolvedCandidate.startsWith(frameworkRoot + sep) && !resolvedCandidate.startsWith(resolvedPrefix + sep)) {
      return resolvedCandidate;
    }
    return null;
  } catch {
    return null;
  }
}

// Trust gate for a hookDir-derived candidate (a file living next to this
// script's own realpath'd location). Threat (round 2 of the security
// review): this script is copied byte-identical into every consumer (and
// this framework's own) repo at `.claude/hooks/adlc-meter-hook.ts` -- so
// `hookDir` there is REPO CONTENT, exactly as attacker-reachable as the
// `adlc/methods/hooks/adlc-meter.ts` path above. A hostile fork can commit a
// sibling `.claude/hooks/adlc-meter.ts` directly, no symlink forgery needed,
// and it would sail through ungated -- reopening the identical RCE this
// file exists to close, through a second door. `hookDir` is a genuine,
// operator/install-configured trust anchor ONLY for the one shape that
// justifies exempting it at all: a Homebrew Cellar keg (or any other
// install directory) that sits entirely OUTSIDE every git working tree. The
// `.claude/hooks/` mirror shape, by construction, always sits INSIDE one
// (whichever repo it was deployed into, hostile or legitimate) --
// `gitShowToplevel` returns '' for exactly the "not inside any repo" case
// and is reused here rather than re-implemented.
function isTrustedHookDirSibling(hookDir: string): boolean {
  return gitShowToplevel(hookDir) === '';
}

// `globSync()` throwing for one prefix (ELOOP on a symlink cycle, EACCES,
// etc.) must not abort candidate discovery for every OTHER prefix -- every
// neighboring filesystem check in this file (isDir, isReadableFile,
// isExecutable, gitShowToplevel, trustedFrameworkRoot,
// resolveTrustedRepoCandidate) already degrades per-call via try/catch;
// this brings the glob-fallback loops in line with that same posture.
function safeGlob(pattern: string): string[] {
  try {
    return globSync(pattern).sort();
  } catch {
    return [];
  }
}

function main(): void {
  const payload = readStdin();

  // The payload states the session's directory; the process cwd is whatever
  // the Runner happened to leave us in. Both the CLI lookup below and the
  // ledger location must key off the payload, or a Runner that invokes
  // hooks from somewhere else silently records nothing at all.
  let payloadCwd = '';
  if (payload) {
    try {
      const parsed = JSON.parse(payload) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string') {
        payloadCwd = parsed.cwd;
      }
    } catch {
      payloadCwd = '';
    }
  }
  if (!payloadCwd || !isDir(payloadCwd)) {
    payloadCwd = '';
  }

  // Hand the anchor to the CLI so it does not have to re-derive it, and so a
  // direct `adlc-meter` invocation and a hook-driven one agree on the ledger.
  const extraEnv: Record<string, string> = {};
  if (payloadCwd) {
    extraEnv.ADLC_ANCHOR_DIR = payloadCwd;
  }

  let payloadRoot = '';
  if (payloadCwd) {
    payloadRoot = gitShowToplevel(payloadCwd) || payloadCwd;
  }

  const repoRoot = gitShowToplevel(process.cwd()) || process.cwd();

  // Opt-out, default ON. Checked here as well as in the CLI so a developer
  // who has opted out pays nothing at all — not even locating and starting
  // the CLI.
  //
  // Two channels, first definite answer wins: ADLC_TELEMETRY in the
  // environment (shell profile, every repo), then ADLC_TELEMETRY in the repo
  // .env (per developer, per repo, gitignored). The file is grepped for that
  // one key, never sourced/evaluated.
  let telemetryValue = process.env.ADLC_TELEMETRY ?? '';
  if (!telemetryValue) {
    const envFile = join(payloadRoot || repoRoot, '.env');
    if (isReadableFile(envFile)) {
      try {
        const lines = readFileSync(envFile, 'utf8').split('\n');
        let last = '';
        for (const line of lines) {
          const m = line.match(/^\s*(?:export\s+)?ADLC_TELEMETRY\s*=\s*(.*)$/);
          if (m) {
            last = m[1] ?? '';
          }
        }
        // Strip inline comments, surrounding quotes, trailing whitespace.
        last = last.replace(/\s*#.*$/, '');
        const dq = last.match(/^"(.*)"$/);
        const sq = last.match(/^'(.*)'$/);
        if (dq) last = dq[1] ?? '';
        else if (sq) last = sq[1] ?? '';
        last = last.replace(/\s*$/, '');
        telemetryValue = last;
      } catch {
        telemetryValue = '';
      }
    }
  }
  if (['off', '0', 'false', 'no', 'disabled'].includes(telemetryValue.trim().toLowerCase())) {
    process.exit(0);
  }

  // Locating the CLI across deploy shapes. A packaged install (Homebrew)
  // symlinks the framework's adlc/ tree into the consumer repo root, so the
  // repo-relative path resolves through that symlink to the install prefix.
  // ADLC_HOME is the fallback for a missing or broken symlink; it is
  // tilde-expanded because setup.sh accepts a `~`-relative value. The last
  // candidate is a direct SIBLING of this script -- trusted only when that
  // sibling location is itself outside any git repo (isTrustedHookDirSibling()
  // above); the `.claude/hooks/` mirror this same script is copied into is
  // never such a location, since it always lives inside whichever repo it
  // was deployed into.
  let hookSrc = fileURLToPath(import.meta.url);
  try {
    hookSrc = realpathSync(hookSrc);
  } catch {
    // keep as-is
  }
  const hookDir = (() => {
    try {
      return dirname(hookSrc);
    } catch {
      return '';
    }
  })();

  const home = process.env.HOME ?? '';
  const adlcHomeExpanded = expandTilde(process.env.ADLC_HOME ?? '', home);

  // The unquoted globs at the end are deliberate and are the only reason
  // this hook survives the CLI being relocated. This script is COPIED into a
  // consumer repo at /adlc-init time and that copy is committed, so a
  // framework upgrade does not refresh it. A glob keeps any relocation
  // within methods/ resolvable -- but a relocated repo-tree candidate must
  // ALSO pass its class's trust gate below; relocation alone never bypasses
  // it.
  let meter = process.env.ADLC_METER ?? '';
  if (!meter) {
    // Three trust classes, each resolved to a real, gate-checked path
    // (never the original candidate string, closing the TOCTOU window a
    // validate-then-reuse-the-raw-path pattern would leave open):
    //   - 'anchor'         : ADLC_HOME-derived. An explicit operator-set env
    //                        var, never repo content a clone can inject.
    //   - 'repo'           : payloadRoot/repoRoot-derived. Gated by
    //                        resolveTrustedRepoCandidate() -- must resolve
    //                        through a real adlc/ symlink mount.
    //   - 'hookDirSibling' : hookDir-derived. Gated by
    //                        isTrustedHookDirSibling() -- must sit outside
    //                        every git working tree.
    type Candidate =
      | { kind: 'anchor'; path: string }
      | { kind: 'repo'; path: string; prefix: string }
      | { kind: 'hookDirSibling'; path: string; hookDir: string };

    const explicit: Candidate[] = (
      [
        payloadRoot ? { kind: 'repo', path: join(payloadRoot, 'adlc/methods/hooks/adlc-meter.ts'), prefix: payloadRoot } : null,
        { kind: 'repo', path: join(repoRoot, 'adlc/methods/hooks/adlc-meter.ts'), prefix: repoRoot },
        adlcHomeExpanded
          ? { kind: 'anchor', path: join(adlcHomeExpanded, 'adlc/methods/hooks/adlc-meter.ts') }
          : null,
        hookDir ? { kind: 'hookDirSibling', path: join(hookDir, 'adlc-meter.ts'), hookDir } : null,
      ] satisfies Array<Candidate | null>
    ).filter((c): c is Candidate => c !== null);

    const globbed: Candidate[] = [];
    for (const prefix of [payloadRoot, repoRoot]) {
      if (!prefix) continue;
      for (const path of safeGlob(join(prefix, 'adlc/methods/*/adlc-meter.ts'))) {
        globbed.push({ kind: 'repo', path, prefix });
      }
    }
    if (adlcHomeExpanded) {
      for (const path of safeGlob(join(adlcHomeExpanded, 'adlc/methods/*/adlc-meter.ts'))) {
        globbed.push({ kind: 'anchor', path });
      }
    }
    if (hookDir) {
      for (const path of safeGlob(join(hookDir, '../*/adlc-meter.ts'))) {
        globbed.push({ kind: 'hookDirSibling', path, hookDir });
      }
    }

    for (const candidate of [...explicit, ...globbed]) {
      if (!isReadableFile(candidate.path)) continue;
      let resolved: string | null;
      switch (candidate.kind) {
        case 'anchor':
          try {
            resolved = realpathSync(candidate.path);
          } catch {
            resolved = null;
          }
          break;
        case 'repo':
          resolved = resolveTrustedRepoCandidate(candidate.path, candidate.prefix);
          break;
        case 'hookDirSibling':
          if (!isTrustedHookDirSibling(candidate.hookDir)) {
            resolved = null;
            break;
          }
          try {
            resolved = realpathSync(candidate.path);
          } catch {
            resolved = null;
          }
          break;
      }
      if (!resolved) continue;
      meter = resolved;
      break;
    }
  }

  // Prefer executing directly; fall back to `node --experimental-strip-types
  // <path>` when the file is readable but not executable. A packaging step
  // that drops the exec bit would otherwise turn this hook into a permanent
  // silent no-op with no signal at all. Every meter candidate is a .ts file,
  // so the fallback interpreter must be node (with type stripping), not bash.
  //
  // Fire-and-forget, for real: spawned detached with its stdout/stderr fully
  // ignored (never inherited or piped from this process) and unref()'d, so
  // this hook exits the instant its own work is done and its own
  // stdout/stderr close right then -- regardless of how long the recorder
  // takes to finish. A caller that waits on this hook's stdio (e.g. a
  // process.spawn()-based test harness collecting output via the 'close'
  // event) would otherwise hang until the grandchild's fds close too, since
  // 'close' does not fire while any inherited/piped fd stays open in a
  // still-running descendant. Only stdin is piped (to hand off the payload),
  // and it is written and ended before unref() so the write survives this
  // process's exit.
  if (meter && isReadableFile(meter) && payload) {
    const env = { ...process.env, ...extraEnv };
    const fireAndForget = (command: string, args: string[]): void => {
      const child = spawn(command, args, { env, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => {
        // Never let a spawn-level failure (e.g. ENOENT) surface as an
        // unhandled 'error' event -- this hook must never fail or block.
      });
      child.stdin.on('error', () => {
        // The grandchild may exit (or fail to start) before consuming
        // stdin; an EPIPE/ECONNRESET here is expected, not a real failure.
      });
      child.stdin.write(payload);
      child.stdin.end();
      child.unref();
    };
    if (isExecutable(meter)) {
      fireAndForget(meter, ['record']);
    } else {
      fireAndForget(process.execPath, ['--experimental-strip-types', meter, 'record']);
    }
  }

  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(0);
}
