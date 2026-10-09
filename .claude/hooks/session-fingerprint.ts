#!/usr/bin/env -S node --experimental-strip-types
// session-fingerprint.ts — Stage 0 of the reflection layer. Records what a
// finished session DID, as counts and byte offsets, never as prose.
//
// WHY THIS EXISTS
//
// The reflection layer's job is to notice friction that recurs across
// sessions and turn it into a reviewed proposal. Doing that requires a
// per-session record. Producing that record with a model does not scale and
// does not fit: measured on one developer machine, session transcripts run
// to a 1.43 MB median and a 69.8 MB maximum — the median alone is past a
// context window. So the capture step is deterministic: this script counts
// events and records WHERE meaning might be (a byte offset and a length),
// and the consolidation step later opens only those windows.
//
// The consequence that makes the whole design viable: capture costs zero
// model tokens, so it can run after every session without a cost
// conversation, and the expensive step runs once over a batch instead of
// once per session.
//
// WHY BOTH Stop AND SessionEnd
//
// `Stop` (Cursor) fires after each agent turn with a live shell — the shell
// is still running, so the hook can write files. That makes it the durable
// capture point on Cursor: every completed turn produces a fingerprint.
//
// `SessionEnd` remains registered as a final-overwrite path for a future
// Cursor that can spawn hooks at teardown (abandoned / killed sessions). It
// also covers Claude Code's own `SessionEnd`, which fires on `clear`,
// `logout`, `prompt_input_exit`, `other`, and on SIGTERM after the process
// tree is torn down — exactly the abandoned-session case a reflection layer
// most wants to see.
//
// MUST NEVER FAIL OR BLOCK. `SessionEnd` cannot block by contract, and this
// script additionally guarantees it: every failure path degrades to a
// missing fingerprint file and the process always exits 0. A missing
// transcript, an unwritable store, a malformed payload and a transcript
// larger than the read budget are all no-ops or truncations, never errors.
//
// WHAT IS DELIBERATELY NOT RECORDED
//
// No prompt text, no assistant text, no tool arguments, no file contents.
// A self-flag is stored as `{offset, len, kind}` — a pointer, not a quote.
// This keeps the fingerprint store the same shape of artifact as the
// telemetry ledger beside it: machine-local, no network egress, and
// incapable of leaking session content on its own. Extracting a quoted
// window is a separate, explicit step (`adlc-reflect windows`) that
// redacts, and a human sees the exact bytes before anything is published.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FINGERPRINT_VERSION = 2;

// Read budget. A 69.8 MB transcript must not turn a session teardown into a
// visible pause, so the scan stops at whichever of these it reaches first and
// records that it did. A truncated fingerprint is still useful — the counts
// it did reach are real — and it is honestly labelled rather than silently
// partial.
const MAX_SCAN_BYTES = 48 * 1024 * 1024;
const MAX_SCAN_MS = 4000;
const CHUNK_BYTES = 1 << 20;

// Matches `self_flags`' own len cap below, applied uniformly to every
// evidence pointer this file records.
const MAX_POINTER_LEN = 4096;

// The single source of truth for the churn threshold. adlc-reflect.ts
// imports this rather than duplicating it, so the evidence pointer's
// trigger point can never drift from what churn_files itself reports.
export const CHURN_FLOOR = 3;

// A self-flag is a moment where the agent itself noticed something it could
// not act on in-task. These are the highest-confidence findings the layer
// can produce, because the agent had full task context when it said so —
// unlike anything the consolidation step later infers. Kinds are recorded so
// the consolidation step can group them without re-reading.
const SELF_FLAG_PATTERNS: Array<[string, RegExp]> = [
  ['missing-verb', /\b(missing|absent|no such)\s+(adlc-cli\s+)?(verb|subcommand)\b/i],
  ['should-propose', /\bI (should|would|could) propose\b/i],
  ['worth-flagging', /\bworth (flagging|raising|filing|proposing)\b/i],
  ['follow-up', /\b(follow[- ]up|out of scope for this (change|pass|task))\b/i],
  ['workaround', /\b(working around|had to work around|no clean way to)\b/i],
];

// Guardrail denials, by the marker each hook actually prints. Counting these
// by NAME rather than in aggregate is what lets the consolidation step
// distinguish "this guardrail is expensive" from "this guardrail is wrong" —
// and the governors forbid ever proposing the latter for a protected one.
//
// Matched anywhere in the body — never line-anchored. A stderr/exit-2 hook
// denial arrives wrapped as `PreToolUse:<Tool> hook error: [<command>]:
// <stderr>`, which puts the real banner at some offset past the start of the
// body; anchoring to a line start silently zeroes that whole family.
type HookBlockMarker = {
  name: string;
  /** Literal text the emitting hook prints TODAY. Matched anywhere in the
   *  body — NOT line-anchored: stderr/exit-2 hooks arrive wrapped as
   *  `PreToolUse:<Tool> hook error: [<command>]: <stderr>`, and anchoring
   *  silently zeroes that whole family. */
  banner: RegExp;
} & (
  | { tools?: undefined; headline?: undefined }
  | {
      /** PreToolUse matcher registration (.claude/settings.json) — the ground
       *  truth of which hook could have fired. Present ONLY where two hooks
       *  share one banner. */
      tools: readonly string[];
      /** Fallback when the tool_use pairing is unavailable or the hook is
       *  registered on a matcher not listed above. Required alongside `tools`
       *  — the matcher below treats an unpaired `tools` as "no fallback",
       *  never as "any tool matches". */
      headline: RegExp;
    }
);

export const HOOK_BLOCK_MARKERS: readonly HookBlockMarker[] = [
  { name: 'worktree-edit',
    banner: /WORKTREE VIOLATION:/,
    tools: ['Edit', 'Write', 'NotebookEdit'],
    // every deny() headline in check-worktree-edit.ts
    headline: /so this edit cannot be cleared\.|file edits are not allowed in the main repo working tree/ },

  { name: 'worktree-read',
    banner: /WORKTREE VIOLATION:/,
    tools: ['Read'],
    // every deny() headline in check-worktree-read.ts.
    // NOTE: the EDIT hook's headlines contain the phrase "could not be read" —
    // discriminating on a bare /read/ misclassifies them. Do not "simplify" this.
    headline: /so this read cannot be cleared\.|reads must stay inside the session's own worktree/ },

  { name: 'worktree-destroy', banner: /WORKTREE DESTROY BLOCKED/ },

  { name: 'adlc-cli-prefer',  banner: /BLOCKED: this project standardizes/ },

  // The trailing colon is load-bearing: check-adlc-version.ts also prints
  // `ADLC version check (warning): ...` on its ALLOW path — that message
  // must never count as a block.
  { name: 'adlc-version',     banner: /ADLC version check:/ },

  { name: 'ship-policy',      banner: /BLOCKED by Ship Policy/ },
];

type Fingerprint = {
  fingerprint_version: number;
  session: string;
  repo: string;
  /** Filesystem root of that repo, so consolidation can reach its
   * docs/code/learnings/ store later. A slug alone is not resolvable. */
  repo_root: string;
  commit: string;
  branch: string;
  runner: string;
  /** Signals this runner CANNOT produce. A zero for one of these means "not
   * measurable here", never "measured none". */
  unsupported_signals: string[];
  end_reason: string;
  ended_mid_turn: boolean;
  truncated: boolean;
  scanned_bytes: number;
  transcript_bytes: number;
  agent_sequence: string[];
  review_cycles: number;
  hook_blocks: Record<string, number>;
  tool_errors: Record<string, number>;
  tool_calls: number;
  churn_files: number;
  self_flags: Array<{ offset: number; len: number; kind: string }>;
  /** Resolvable transcript pointers — one exemplar per signal occurrence.
   *  `signal` names the FINGERPRINT FIELD the pointer grounds, using the same
   *  vocabulary Signal.inputs and SIGNAL_COVERAGE already use; `key` is the
   *  sub-identity within that field (hook name, tool name, role, file path).
   *  A pointer, never a quote — the same artifact class as self_flags. */
  evidence: Array<{ signal: string; key: string; offset: number; len: number }>;
  docs_read: string[];
  transcript_path: string;
  recorded_at: string;
};

function reflectionDir(): string {
  if (process.env.ADLC_REFLECTION_DIR) return process.env.ADLC_REFLECTION_DIR;
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, 'adlc', 'reflection');
  return join(process.env.HOME || '/tmp', '.adlc', 'reflection');
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Opt-out, default ON. Two channels, first definite answer wins:
// ADLC_REFLECTION in the environment, then ADLC_REFLECTION in the repo .env.
// The .env channel matters because .claude/settings.json is COMMITTED —
// disabling there disables it for the whole team, so it cannot be the
// individual opt-out. The file is grepped for that one key, never sourced:
// sourcing would execute arbitrary shell from a hook that must be incapable
// of affecting the session. Same two-channel shape the telemetry recorder
// already uses, deliberately, so one mental model covers both.
function optedOut(repoRoot: string): boolean {
  let value = process.env.ADLC_REFLECTION ?? '';
  if (!value && repoRoot) {
    try {
      const envFile = join(repoRoot, '.env');
      if (existsSync(envFile)) {
        const lines = readFileSync(envFile, 'utf8').split('\n');
        for (const line of lines) {
          const m = /^\s*(?:export\s+)?ADLC_REFLECTION\s*=\s*(.*)$/.exec(line);
          if (m) value = (m[1] ?? '').replace(/\s*#.*$/, '').trim().replace(/^["'](.*)["']$/, '$1');
        }
      }
    } catch {
      /* unreadable .env is not an opt-out signal */
    }
  }
  return ['off', '0', 'false', 'no', 'disabled'].includes(value.trim().toLowerCase());
}

function git(args: string[], cwd: string): string {
  try {
    // Statically imported, NOT lazily require()d. This package is
    // "type": "module", so `require` is undefined here: a lazy require threw
    // ReferenceError on every call, the catch below swallowed it, and every
    // git-derived field silently became empty -- repo 'unknown', commit and
    // branch ''. That disabled the cross-repo recurrence gate entirely,
    // because every session in every repository collapsed into one bucket
    // named 'unknown'. Found by backfilling real transcripts, not by the
    // suite, which is why gitFieldsAreResolved below now exists.
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return '';
  }
}

// The repository this session belongs to. Anchored on --git-common-dir so
// sibling worktrees of one repo resolve to that repo rather than to N
// repos — mandatory worktree isolation means a repo is normally being worked
// from a worktree, and the cross-repo recurrence signal is worthless if each
// worktree reads as its own repository.
function repoSlug(cwd: string): string {
  if (!cwd) return 'unknown';
  let common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) common = git(['rev-parse', '--show-toplevel'], cwd);
  if (!common) return 'unknown';
  const root = common.endsWith('/.git') ? common.slice(0, -5) : common.replace(/\/\.git$/, '');
  const remote = git(['config', '--get', 'remote.origin.url'], cwd);
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (m) return `${m[1]}/${m[2]}`;
  const parts = root.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

/** Streaming, byte-budgeted scan of one transcript. Never loads the file. */
export function scanTranscript(
  path: string,
  now: () => number = Date.now,
): Pick<
  Fingerprint,
  | 'agent_sequence'
  | 'review_cycles'
  | 'hook_blocks'
  | 'tool_errors'
  | 'tool_calls'
  | 'churn_files'
  | 'self_flags'
  | 'evidence'
  | 'docs_read'
  | 'ended_mid_turn'
  | 'truncated'
  | 'scanned_bytes'
> {
  const agentSequence: string[] = [];
  const agentSequenceSites: Array<{ offset: number; len: number }> = [];
  const hookBlocks: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  const selfFlags: Array<{ offset: number; len: number; kind: string }> = [];
  const evidence: Array<{ signal: string; key: string; offset: number; len: number }> = [];
  const evidenceSeen = new Set<string>();
  const docsRead = new Set<string>();
  const editCounts = new Map<string, number>();
  // Still-open tool_use, by id, holding the site of the record that opened it
  // -- the citable events for `ended_mid_turn` are whichever of these are
  // still open at end of scan (a session can die holding more than one).
  const openToolUses = new Map<string, { offset: number; len: number }>();
  const toolNameById = new Map<string, string>();
  let toolCalls = 0;
  let truncated = false;
  let scanned = 0;

  // One exemplar per (signal, key) per session -- first occurrence wins.
  function noteEvidence(signal: string, key: string, offset: number, len: number): void {
    const id = signal + ':' + key;
    if (evidenceSeen.has(id)) return;
    evidenceSeen.add(id);
    evidence.push({ signal, key, offset, len });
  }

  const started = now();
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return {
      agent_sequence: [], review_cycles: 0, hook_blocks: {}, tool_errors: {}, tool_calls: 0,
      churn_files: 0, self_flags: [], evidence: [], docs_read: [], ended_mid_turn: false, truncated: false, scanned_bytes: 0,
    };
  }

  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let carry: Buffer = Buffer.alloc(0);
    let lineStart = 0;
    for (;;) {
      if (scanned >= MAX_SCAN_BYTES || now() - started > MAX_SCAN_MS) {
        truncated = true;
        break;
      }
      const got = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (got <= 0) break;
      scanned += got;
      const block = carry.length === 0
        ? Buffer.from(buf.subarray(0, got))
        : Buffer.concat([carry, buf.subarray(0, got)]);
      let from = 0;
      for (;;) {
        const nl = block.indexOf(0x0a, from);
        if (nl === -1) break;
        const lineBytes = block.subarray(from, nl);
        const offset = lineStart;
        const byteLen = lineBytes.length + 1;
        lineStart += byteLen;
        from = nl + 1;
        if (lineBytes.length === 0) continue;
        let rec: any;
        try {
          rec = JSON.parse(lineBytes.toString('utf8'));
        } catch {
          continue; // a partial or non-JSON line is skipped, never fatal
        }
        ingest(rec, offset, byteLen);
      }
      // Copy, not a view: `buf` is reused by the next readSync, and a bare
      // subarray of it (the empty-carry case) would be silently overwritten.
      carry = Buffer.from(block.subarray(from));
    }
    if (carry.length > 0) {
      try {
        ingest(JSON.parse(carry.toString('utf8')), lineStart, carry.length);
      } catch {
        /* trailing partial line */
      }
    }
  } catch {
    truncated = true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }

  function ingest(rec: any, offset: number, byteLen: number): void {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        toolCalls += 1;
        const name = String(block.name ?? '');
        const site = { offset, len: Math.min(byteLen, MAX_POINTER_LEN) };
        if (block.id) {
          openToolUses.set(String(block.id), site);
          toolNameById.set(String(block.id), name);
        }
        if (name === 'Agent' || name === 'Task') {
          const sub = block.input?.subagent_type ?? block.input?.subagentType;
          if (sub) {
            agentSequence.push(String(sub));
            agentSequenceSites.push(site);
            noteEvidence('agent_sequence', String(sub), site.offset, site.len);
          }
        }
        if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
          const fp = block.input?.file_path;
          if (fp) {
            const count = (editCounts.get(String(fp)) ?? 0) + 1;
            editCounts.set(String(fp), count);
            if (count === CHURN_FLOOR) noteEvidence('churn_files', String(fp), site.offset, site.len);
          }
        }
        if (name === 'Read') {
          const fp = String(block.input?.file_path ?? '');
          const m = /adlc\/methods\/(.+\.md)$/.exec(fp);
          if (m) docsRead.add(m[1]!);
        }
      } else if (block?.type === 'tool_result') {
        const id = String(block.tool_use_id ?? '');
        if (id) openToolUses.delete(id);
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        if (block.is_error) {
          const name = toolNameById.get(id) ?? 'unknown';
          toolErrors[name] = (toolErrors[name] ?? 0) + 1;
          noteEvidence('tool_errors', name, offset, Math.min(byteLen, MAX_POINTER_LEN));
          for (const marker of HOOK_BLOCK_MARKERS) {
            if (!marker.banner.test(body)) continue;
            if (marker.tools && !marker.tools.includes(name) && !marker.headline?.test(body)) continue;
            hookBlocks[marker.name] = (hookBlocks[marker.name] ?? 0) + 1;
            noteEvidence('hook_blocks', marker.name, offset, Math.min(byteLen, MAX_POINTER_LEN));
          }
        }
      } else if (block?.type === 'text' && (rec?.type === 'assistant' || rec?.role === 'assistant')) {
        const text = String(block.text ?? '');
        for (const [kind, re] of SELF_FLAG_PATTERNS) {
          const m = re.exec(text);
          if (!m) continue;
          // Offsets are into the transcript FILE, so the consolidation step
          // can seek directly. The window is the record's own line; the
          // extraction step narrows and redacts it.
          selfFlags.push({ offset, len: Math.min(byteLen, MAX_POINTER_LEN), kind });
          break; // at most one flag per text block — recurrence, not volume, is the signal
        }
      }
    }
  }

  // The re-dispatch that actually followed a reviewer episode -- not the
  // first dispatch in the sequence -- is the citable event for review-loop.
  const reviewSite = reviewLoopSite(agentSequence, agentSequenceSites);
  if (reviewSite) noteEvidence('review_cycles', reviewSite.key, reviewSite.offset, reviewSite.len);
  // Whatever tool_use(s) are still open at end of scan are the citable events
  // for ended_mid_turn -- the session died holding them, one entry per still-
  // open call (died-mid-turn's own filter in signalsFor does not key on a
  // single tool, so it picks up all of them).
  for (const [id, site] of openToolUses) {
    noteEvidence('ended_mid_turn', toolNameById.get(id) ?? 'unknown', site.offset, site.len);
  }

  return {
    agent_sequence: agentSequence,
    review_cycles: countReviewCycles(agentSequence),
    hook_blocks: hookBlocks,
    tool_errors: toolErrors,
    tool_calls: toolCalls,
    churn_files: [...editCounts.values()].filter((n) => n >= CHURN_FLOOR).length,
    self_flags: selfFlags,
    evidence,
    docs_read: [...docsRead].sort(),
    ended_mid_turn: openToolUses.size > 0,
    truncated,
    scanned_bytes: scanned,
  };
}

/** The dispatch that actually sent work back to `code` after a `reviewer`
 * episode -- the citable event for `review-loop`, index-aligned against
 * `sequence` so the pointer names the re-dispatch itself, never the first
 * dispatch in the sequence. */
function reviewLoopSite(
  sequence: string[],
  sites: Array<{ offset: number; len: number }>,
): { offset: number; len: number; key: string } | undefined {
  for (let i = 0; i < sequence.length; i++) {
    if (!/reviewer/.test(sequence[i] ?? '')) continue;
    const j = sequence.findIndex((role, idx) => idx > i && /^code/.test(role));
    if (j === -1) continue;
    const site = sites[j];
    if (site) return { ...site, key: sequence[j]! };
  }
  return undefined;
}

/** Which runner fired this hook, from the payload alone.
 *
 * Cursor's hook payload carries `cursor_version` and spells the event in
 * camelCase (`sessionEnd`); Claude Code spells it `SessionEnd` and exports
 * CLAUDE_CODE_SESSION_ID into the hook environment. Deliberately does NOT
 * fall back to 'claude-code' on an unrecognised payload -- an unknown runner
 * must stay `unknown`, because SIGNAL_COVERAGE decides what a missing count
 * MEANS, and guessing wrong there turns "not measurable" into a confident
 * zero. */
export function detectRunner(payload: any, env: NodeJS.ProcessEnv = process.env): string {
  if (payload?.cursor_version || payload?.hook_event_name === 'sessionEnd') return 'cursor';
  if (env.CLAUDE_CODE_SESSION_ID || payload?.hook_event_name === 'SessionEnd') return 'claude-code';
  return 'unknown';
}

/** Which signals each runner can actually produce, and therefore which
 * absences are meaningful.
 *
 * The capture code is shared, but the runners are not equivalent, and a
 * signal that CANNOT be measured on a runner must never be read as a measured
 * zero. Verified against real Cursor agent transcripts:
 *
 *   - Cursor records carry NO `tool_result` blocks, so tool errors and the
 *     hook-block markers (matched against tool_result bodies) are
 *     unobservable -- not absent, unobservable.
 *   - Cursor `tool_use` blocks carry no `id`, so no call can be correlated
 *     with its outcome even in principle.
 *   - Cursor names its tools differently (`Shell`, not `Bash`) and does not
 *     expose ADLC's Agent/Task dispatch shape, so agent sequence, review
 *     cycles, doc reads and edit churn have no counterpart.
 *
 * What DOES survive on Cursor is the text-block scan -- the self-flag signal,
 * the highest-confidence input the design has. */
export const SIGNAL_COVERAGE: Record<string, { unsupported: string[] }> = {
  'claude-code': { unsupported: [] },
  cursor: {
    unsupported: [
      'tool_errors', 'hook_blocks', 'agent_sequence', 'review_cycles',
      'docs_read', 'churn_files', 'ended_mid_turn',
    ],
  },
  unknown: {
    unsupported: [
      'tool_errors', 'hook_blocks', 'agent_sequence', 'review_cycles',
      'docs_read', 'churn_files', 'ended_mid_turn',
    ],
  },
};

/** A review cycle is one reviewer dispatch that is followed by another code
 * dispatch — i.e. the review sent work back. A single reviewer pass at the
 * end of a clean change is zero cycles, which is the intended reading: the
 * signal is rework, not the existence of review. */
export function countReviewCycles(sequence: string[]): number {
  let cycles = 0;
  for (let i = 0; i < sequence.length; i++) {
    if (!/reviewer/.test(sequence[i] ?? '')) continue;
    if (sequence.slice(i + 1).some((a) => /^code/.test(a))) cycles += 1;
  }
  return cycles;
}

// The repo's filesystem root, for the `repo_root` field. `git rev-parse
// --show-toplevel` canonicalizes symlinks in the path it returns (e.g. macOS
// resolves /var -> /private/var), which can differ textually from `cwd` even
// when `cwd` already IS the toplevel -- the common case under mandatory
// worktree isolation, where a session's cwd is itself a worktree's own git
// root. In that case prefer `cwd` verbatim, in whatever notation the runner
// gave it, rather than git's canonicalized rewrite of the same directory.
// Only when `cwd` is a strict subdirectory of a larger repo (not the
// toplevel itself) does this fall back to git's own answer.
function repoRootFor(cwd: string): string {
  if (!cwd) return '';
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return '';
  try {
    if (realpathSync(root) === realpathSync(cwd)) return cwd;
  } catch {
    /* unresolvable path -- fall through to git's own answer */
  }
  return root;
}

/** Derives the transcript path when the payload does not carry one. Claude
 * Code stores a session at ~/.claude/projects/<slugified-cwd>/<id>.jsonl. */
export function derivedTranscriptPath(sessionId: string, cwd: string, home: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(home, '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/** The working directory this session ran in, from whichever field the
 * runner's SessionEnd payload actually carries. Claude Code sends `cwd`.
 * Cursor's SessionEnd payload carries no `cwd` at all -- only
 * `workspace_roots` (string[]) -- so every git-derived field (repo,
 * repo_root, commit, branch) and the .env opt-out fall back to the first
 * existing entry in `workspace_roots` when `cwd` is absent. Only a directory
 * that actually exists on disk is trusted, same guard `cwd` itself gets. */
export function resolveWorkingDir(payload: any): string {
  if (typeof payload?.cwd === 'string' && existsSync(payload.cwd)) return payload.cwd;
  const roots = payload?.workspace_roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === 'string' && existsSync(root)) return root;
    }
  }
  return '';
}

function main(): void {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = resolveWorkingDir(payload);
  if (optedOut(cwd)) process.exit(0);

  const sessionId = String(payload.session_id ?? '');
  if (!sessionId) process.exit(0);

  const home = process.env.HOME || '/tmp';
  let transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcript || !existsSync(transcript)) {
    transcript = derivedTranscriptPath(sessionId, cwd, home);
  }

  let transcriptBytes = 0;
  try {
    transcriptBytes = statSync(transcript).size;
  } catch {
    transcriptBytes = 0;
  }

  const scan = scanTranscript(transcript);

  // Resolved from the payload, not from "is CLAUDE_CODE_SESSION_ID set".
  // The old test tagged every Cursor session 'unknown', which is why they had
  // to be excluded from the population wholesale rather than described.
  const runner = detectRunner(payload);

  const fingerprint: Fingerprint = {
    fingerprint_version: FINGERPRINT_VERSION,
    session: sessionId,
    repo: repoSlug(cwd),
    repo_root: repoRootFor(cwd),
    commit: cwd ? git(['rev-parse', '--short', 'HEAD'], cwd) : '',
    branch: cwd ? git(['branch', '--show-current'], cwd) : '',
    runner,
    unsupported_signals: (SIGNAL_COVERAGE[runner] ?? SIGNAL_COVERAGE.unknown!).unsupported,
    end_reason: String(payload.reason ?? payload.status ?? payload.matcher ?? 'other'),
    transcript_path: transcript,
    transcript_bytes: transcriptBytes,
    recorded_at: new Date().toISOString(),
    ...scan,
  };

  try {
    const dir = join(reflectionDir(), 'fingerprints');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(fingerprint, null, 2) + '\n', 'utf8');
  } catch {
    /* an unwritable store is a dropped fingerprint, never an error */
  }

  process.exit(0);
}

// `import.meta.main` is not available under --experimental-strip-types on
// every supported Node; compare argv[1] instead so the test suite can import
// the exported helpers without running the hook.
const invokedDirectly = process.argv[1]?.endsWith('session-fingerprint.ts') ?? false;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // Deliberately silent, and deliberately not logging the error object.
    //
    // Two reasons. This hook is contractually incapable of failing loudly:
    // SessionEnd cannot block and discards systemMessage, so anything written
    // here reached nobody. And an unexpected error's message can carry a path
    // or a fragment of transcript content, which is exactly what this layer
    // promises never to emit (CWE-209, flagged by SAST). Set
    // ADLC_REFLECTION_DEBUG=1 to surface it while developing.
    if (process.env.ADLC_REFLECTION_DEBUG === '1') {
      console.error('session-fingerprint: capture failed (ADLC_REFLECTION_DEBUG)');
    }
    process.exit(0);
  }
}
