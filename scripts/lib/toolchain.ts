/**
 * toolchain.ts — shared helpers for shelling out to external toolchain
 * binaries (git, gh, curl, etc.) with automatic credential redaction.
 *
 * Exports: run, cliRun, runCaptured, commandExists, secret, redact,
 * redactDetail, errorDetail, ToolchainError, CliError, MAX_BUFFER.
 *
 * Use `run()` instead of bare `execFileSync` for any toolchain call so
 * failures surface as `ToolchainError` with a redacted message rather than
 * as a raw child_process error that may embed credentials in its `.message`.
 * `run()`'s signature — `run(command, args[], options?)` — deliberately
 * mirrors `execFileSync`/`spawnSync`'s own shape so it's a drop-in swap at
 * call sites already passing an args array.
 * Wrap any credential value in `secret()` at its point of substitution —
 * where it's interpolated into an argument/command string — so it is
 * masked in all subsequent `run()` output and error messages.
 *
 * Use `cliRun()` instead for a subprocess whose stderr should stream live to
 * the user (`stdio: 'inherit'`) rather than be captured — e.g. a CLI
 * script's main Ruby/Python worker process, or a `git` call whose own error
 * text should reach the terminal directly. Stdout streams live too by
 * default; pass `{ captureStdout: true }` to capture and return it instead,
 * for a command whose stdout is data to read back (e.g. `git rev-parse
 * HEAD`) rather than progress output. Whatever is inherited can't be
 * redacted; never pass a secret via argv to a command run through
 * `cliRun()`. It throws `CliError(failureMessage ?? '', status)` on a
 * non-zero exit — the default empty message is a silent passthrough for a
 * script's top-level catch to relay unchanged (the child already wrote its
 * own diagnostics to the inherited stderr); pass `failureMessage` instead
 * when the caller wants to layer its own summary on top of that.
 *
 * Use `runCaptured()` instead of `run()` for a caller that inspects a
 * command's exit status itself rather than catching a thrown error — it
 * always returns `{ output, stdout, status }` and never throws for a
 * spawned child's non-zero exit or maxBuffer-exceeded kill. Every one of
 * `run()`, `cliRun()`, and `runCaptured()` accepts a per-call `maxBuffer`
 * override (default `MAX_BUFFER`) and diagnoses a maxBuffer-exceeded kill
 * (`err.code === 'ENOBUFS'`) distinctly from an ordinary non-zero exit, each
 * on its own failure surface (`ToolchainError.message`, `CliError.message`,
 * `RunCapturedResult.output`).
 */

import { execFileSync } from 'node:child_process';

/** Max buffer for a captured child process's stdout+stderr, shared by every `run()`/`cliRun({ captureStdout: true })` call — well above Node's 1MB default. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** The diagnosed message for a maxBuffer-exceeded (`ENOBUFS`) child-process kill, shared by every throwing and non-throwing call style so the wording stays identical everywhere it's surfaced. */
function maxBufferExceededMessage(maxBuffer: number): string {
  return `execFileSync exceeded maxBuffer (${maxBuffer} bytes) — output truncated`;
}

/**
 * Extracts a caught `execFileSync` error's diagnostic fields, and
 * distinguishes a maxBuffer-exceeded kill (`err.code === 'ENOBUFS'`) from an
 * ordinary non-zero exit — the one piece of guard/diagnosis logic every
 * throwing (`run`, `cliRun`) and non-throwing (`runCaptured`) call style
 * builds on, so it is implemented exactly once.
 */
function diagnoseExecError(error: unknown): { stdout: string; stderr: string; status: number | null | undefined; maxBufferExceeded: boolean } {
  const err = error && typeof error === 'object' ? (error as { stdout?: unknown; stderr?: unknown; status?: number | null; code?: string }) : undefined;
  const stdout = err && 'stdout' in err ? String(err.stdout ?? '') : '';
  const stderr = err && 'stderr' in err ? String(err.stderr ?? '') : '';
  const status = err && 'status' in err ? err.status : undefined;
  const maxBufferExceeded = err?.code === 'ENOBUFS';
  return { stdout, stderr, status, maxBufferExceeded };
}

interface RunOptions {
  cwd?: string;
  /**
   * Piped to the child process's stdin (e.g. a JSON payload for `curl -d @-`).
   * When omitted, stdin is not connected (`'ignore'`) — unchanged from every
   * call site that doesn't need it.
   */
  input?: string;
  /**
   * Extra environment variables merged on top of `process.env` for this call
   * only. A key set to `undefined` unsets that variable for the child
   * process instead of inheriting it. Omit entirely to inherit `process.env`
   * unchanged (the default for every call site that doesn't need this).
   */
  env?: Record<string, string | undefined>;
  /** Overrides `MAX_BUFFER` for this call only. Omit to use the default. */
  maxBuffer?: number;
}

/** Merges extra env vars onto `process.env` for one call; a key set to
 * `undefined` unsets that variable instead of inheriting it. Returns
 * `undefined` (inherit `process.env` unchanged) when `extra` is omitted. */
function mergedEnv(extra?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!extra) return undefined;
  return Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

const secrets = new Set<string>();

/** Register a value that must never reach stdout/stderr in the clear, and return it unchanged — designed for inline use at the point of substitution, where the secret is interpolated into an argument/command string. */
function secret<T extends string | undefined>(value: T): T {
  if (value && value.length >= 4) secrets.add(value);
  return value;
}

// Best-effort auto-registration: any env var whose *name* looks secret-shaped
// has its *value* masked automatically, so a call site doesn't have to
// remember to opt in every time it reads a credential.
for (const [key, value] of Object.entries(process.env)) {
  if (/token|secret|key|password|_pat$/i.test(key)) secret(value);
}

/**
 * Shape-based redaction patterns, applied regardless of whether the value was
 * ever registered via `secret()` or a token-shaped env var — these catch a
 * credential lifted from a tool's own raw output (e.g. a `gh` CLI auth
 * failure echoing the failing request's own headers back on stderr), which
 * was never in this process's own environment to auto-register.
 */
const SHAPE_PATTERNS: Array<[RegExp, string]> = [
  // GitHub personal-access/app/installation/OAuth tokens (gh{p,o,u,s,r}_...)
  // and the newer github_pat_... form.
  [/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, '***REDACTED***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***REDACTED***'],
  // Slack bot/user/app/refresh tokens: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-.
  [/\bxox[baprs]-[A-Za-z0-9-]+\b/g, '***REDACTED***'],
  // Authorization header / Bearer scheme, wherever it appears (a header line,
  // or echoed inline in an error message) — keep the scheme name, redact only
  // the credential. The bearer-specific pattern must run first: the generic
  // `authorization:` pattern below would otherwise greedily consume the
  // literal word "Bearer" as part of its own match, leaving nothing for the
  // bearer-specific pattern to redact.
  [/\b(bearer\s+)\S+/gi, '$1***REDACTED***'],
  [/\b(authorization:\s*)\S+/gi, '$1***REDACTED***'],
  // Credential-shaped query-string params (?token=..., &jwt=..., ?api_key=..., etc.).
  [/([?&](?:token|jwt|api[_-]?key|password|secret|access[_-]?token)=)[^&\s"'<>]+/gi, '$1***REDACTED***'],
];

function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***REDACTED***');
  // Credentials embedded in URLs (https://user:token@host/...), independent
  // of whether that token was separately registered.
  out = out.replace(/:\/\/[^/\s@]+@/g, '://***REDACTED***@');
  for (const [pattern, replacement] of SHAPE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Cap shared with every caught-error detail — matches the truncation already applied to a failed download's response-body snippet. */
const DETAIL_MAX_LENGTH = 500;

/** Redacts (via `redact()`) and truncates `text` to `DETAIL_MAX_LENGTH` characters — the shared shape a caught-error detail must pass through before it's safe to log. */
function redactDetail(text: string): string {
  return redact(text).slice(0, DETAIL_MAX_LENGTH);
}

/** The safe-to-log string for an `unknown` caught value — mirrors the `error instanceof Error ? error.message : String(error)` ternary used inline at call sites, redacted and truncated via `redactDetail`. */
function errorDetail(error: unknown): string {
  return redactDetail(error instanceof Error ? error.message : String(error));
}

class ToolchainError extends Error {
  readonly command: string;
  /**
   * Raw, unredacted argv — kept for callers that need the exact invocation
   * (e.g. retry logic). Unlike `.message`/`.cause`, this is NOT safe to log
   * or `JSON.stringify()` directly: it may contain a secret verbatim. Use
   * `redact(err.args.join(' '))` if you need to display it.
   */
  readonly args: string[];
  /**
   * Redacted stdout captured from the failing process, if any. Some tools
   * (e.g. `curl --fail-with-body`) write their most useful diagnostic — the
   * actual response body — to stdout on failure, not stderr; callers that
   * need just that diagnostic can read it here instead of parsing `.message`.
   */
  readonly stdout?: string;
  /** The failing child's exit code, `null` if it was killed by a signal, or `undefined` when no exit status was available. */
  readonly status?: number | null;

  constructor(
    command: string,
    args: string[],
    options: { cause?: unknown; stdout?: string; stderr?: string; status?: number | null } = {},
  ) {
    const cmdline = redact([command, ...args].join(' '));
    const stdout = options.stdout ? redact(options.stdout) : '';
    const stderr = options.stderr ? redact(options.stderr) : '';
    const diagnostics = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    super(`command failed: ${cmdline}` + (diagnostics ? `\n${diagnostics}` : ''));
    this.name = 'ToolchainError';
    this.command = command;
    this.args = args;
    if (stdout) this.stdout = stdout;
    this.status = options.status;

    // Don't chain the raw child_process error verbatim as `cause` — Node's
    // own "Command failed: ..." message re-embeds the full, unredacted argv.
    // Wrap a sanitized copy so console.error's automatic cause-chain
    // printing can't reintroduce a leak.
    if (options.cause instanceof Error) {
      const sanitizedCause = new Error(redact(options.cause.message));
      sanitizedCause.name = options.cause.name;
      sanitizedCause.stack = options.cause.stack ? redact(options.cause.stack) : sanitizedCause.stack;
      this.cause = sanitizedCause;
    }
  }
}

function run(command: string, args: string[] = [], options: RunOptions = {}): string {
  const maxBuffer = options.maxBuffer ?? MAX_BUFFER;
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      input: options.input,
      env: mergedEnv(options.env),
      encoding: 'utf8',
      maxBuffer,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const diagnosis = diagnoseExecError(error);
    if (diagnosis.maxBufferExceeded) {
      throw new ToolchainError(command, args, { cause: error, stderr: maxBufferExceededMessage(maxBuffer), status: diagnosis.status });
    }
    throw new ToolchainError(command, args, { cause: error, stdout: diagnosis.stdout, stderr: diagnosis.stderr, status: diagnosis.status });
  }
}

/** Thrown for every expected CLI failure; a script's top-level catch should
 * print `message` (when non-empty — empty means a child process already
 * wrote its own diagnostics to inherited stderr) and exit with `code`.
 * Pass `{ cause }` when rethrowing over a caught `ToolchainError` (or
 * another already-redacted error) so the original diagnostic isn't lost —
 * `console.error` prints a `.cause` chain automatically. */
class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number = 1, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.code = code;
  }
}

interface CliRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Capture stdout and return it instead of streaming it live to the
   * parent's own stdout — for a command whose stdout is data to read back
   * (e.g. `git rev-parse HEAD`), not user-facing progress output. stderr is
   * always inherited either way, so the child's own diagnostics still reach
   * the terminal directly. Defaults to false (both streams inherited,
   * nothing captured, return value is `''`).
   */
  captureStdout?: boolean;
  /**
   * Message for the thrown `CliError` on a non-zero exit, instead of the
   * default `''`. Use this when the caller wants to layer its own summary
   * on top of whatever the child already streamed to inherited stderr
   * (e.g. "no bundle was published") rather than a silent passthrough.
   */
  failureMessage?: string;
  /** Overrides `MAX_BUFFER` for this call only. Only meaningful with `{ captureStdout: true }` — inherited stdio has no captured buffer for a maxBuffer cap to apply to. Omit to use the default. */
  maxBuffer?: number;
}

function cliRun(command: string, args: string[] = [], options: CliRunOptions = {}): string {
  const maxBuffer = options.maxBuffer ?? MAX_BUFFER;
  try {
    return (
      execFileSync(command, args, {
        cwd: options.cwd,
        env: mergedEnv(options.env),
        encoding: 'utf8',
        maxBuffer,
        stdio: options.captureStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      }) ?? ''
    );
  } catch (error) {
    const diagnosis = diagnoseExecError(error);
    // execFileSync's thrown error sets `.status` to the child's exit code, or
    // `null` if it was killed by a signal instead — either way, ?? 1 falls
    // through to a generic failure code.
    if (options.captureStdout && diagnosis.maxBufferExceeded) {
      throw new CliError(maxBufferExceededMessage(maxBuffer), diagnosis.status ?? 1);
    }
    throw new CliError(options.failureMessage ?? '', diagnosis.status ?? 1);
  }
}

interface RunCapturedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Piped to the child process's stdin. When omitted, stdin is not connected
   * (`'ignore'`); when present (including `''`), stdin is connected (`'pipe'`)
   * even for an empty payload — some callers (e.g. a `gh api --input -` POST
   * wrapper that always pipes stdin, whether or not this particular call has
   * a body) rely on that distinction.
   */
  input?: string;
  /** Overrides `MAX_BUFFER` for this call only. Omit to use the default. */
  maxBuffer?: number;
}

interface RunCapturedResult {
  /** stdout+stderr concatenated on failure (or the maxBuffer-exceeded diagnostic in place of both), stdout alone on success. */
  output: string;
  /** stdout alone — `''` on failure. */
  stdout: string;
  /** The child's exit code; `1` when it was killed by a signal (including a maxBuffer-exceeded kill) rather than exiting normally. */
  status: number;
}

/**
 * Non-throwing counterpart to `run()`: captures combined output and exit
 * status without ever throwing for a spawned child's non-zero exit or
 * maxBuffer-exceeded kill — for a caller that inspects `.status` itself
 * (e.g. its own `die()`) rather than catching a thrown error. Builds on the
 * same maxBuffer-default-resolution and ENOBUFS-diagnosis logic `run()` and
 * `cliRun()` use, so a too-large response is reported as a clear maxBuffer
 * condition here too, not a truncated generic failure.
 */
function runCaptured(command: string, args: string[] = [], options: RunCapturedOptions = {}): RunCapturedResult {
  const maxBuffer = options.maxBuffer ?? MAX_BUFFER;
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd,
      input: options.input,
      env: mergedEnv(options.env),
      encoding: 'utf8',
      maxBuffer,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    // Deliberately unredacted: the success path's stdout is live data a
    // caller may need verbatim (e.g. `fetchPrBodyHtml()`'s rendered PR body
    // HTML), not a diagnostic destined for a log line. Only the failure path
    // below — whose `output`/`stdout` exist to be logged — is redacted.
    return { output, stdout: output, status: 0 };
  } catch (error) {
    const diagnosis = diagnoseExecError(error);
    if (diagnosis.maxBufferExceeded) {
      return { output: maxBufferExceededMessage(maxBuffer), stdout: '', status: 1 };
    }
    const stdout = redact(diagnosis.stdout);
    const stderr = redact(diagnosis.stderr);
    return { output: stdout + stderr, stdout, status: diagnosis.status ?? 1 };
  }
}

/** True if `bin` resolves on PATH and runs `probeArgs` (default `['--version']`)
 * successfully. Any failure — ENOENT (nothing to spawn) or a non-zero exit —
 * is treated uniformly as "not available": a real, healthy install of a tool
 * like `ruby`/`python3` always exits 0 for `--version`, so there's no
 * `execFileSync` failure mode here worth distinguishing further. Pass
 * `probeArgs` for a binary whose health check needs different flags (e.g.
 * `-version` for ImageMagick's `magick`/`convert`) — this only works for a
 * probe whose *exit code* itself differs by tool/feature state. It cannot
 * detect an output-content-dependent condition like a specific ffmpeg
 * filter's availability, since `stdio: 'ignore'` never captures stdout for
 * this function to inspect and a command like `ffmpeg -filters` exits 0
 * whether or not the filter being searched for is actually listed in its
 * output; `detectDrawtext()` (scripts/demo-video-produce.ts) uses
 * `runCaptured()` plus a stdout grep instead, specifically because
 * `commandExists()` cannot make that distinction. */
function commandExists(bin: string, probeArgs: string[] = ['--version']): boolean {
  try {
    execFileSync(bin, probeArgs, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export { run, cliRun, runCaptured, commandExists, secret, redact, redactDetail, errorDetail, ToolchainError, CliError, MAX_BUFFER };
