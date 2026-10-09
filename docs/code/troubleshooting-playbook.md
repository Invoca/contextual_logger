# Troubleshooting Playbook — `contextual_logger`

Symptom → likely cause → fix → prevention. Entries are drawn from this repository's own history
(CHANGELOG, commit log) and from its actual runtime constraints.

---

## Symptom: `Bundler::GemNotFound` — "Could not find coveralls-…, rspec-core-…, … in locally installed gems"

**Cause.** Development dependencies have not been installed for the Ruby in use. The lockfile
pins exact versions and `bundler` refuses to continue without them. Frequently seen right after
a fresh clone, or after `.ruby-version` moved (it is now `3.3.8`).

**Diagnose.**
```bash
ruby -v                 # must match .ruby-version (3.3.8)
cat .ruby-version
bundle check            # names what is missing
```

**Fix.**
```bash
rbenv install 3.3.8 && rbenv local 3.3.8    # or the rvm equivalent
bundle install
```

**Prevention.** Run `/setup-machine` after cloning — it is the command that prepares the
developer machine (dependencies, `.env`, `gh` auth). `CONTRIBUTING.md` § Environment Setup
documents the same sequence for outside contributors.

---

## Symptom: Specs pass on `Gemfile` but fail on one `gemfiles/activesupport_*.gemfile` row

**Cause.** An ActiveSupport version difference. This gem supports ActiveSupport 7.0 through 8.0
(`.github/workflows/test.yml`), and the interfaces it depends on — `deep_merge`, `delegate`,
`ActiveSupport::Deprecation`, `BroadcastLogger` — have all moved across that range.

**Diagnose.**
```bash
BUNDLE_GEMFILE=gemfiles/activesupport_8_0.gemfile bundle install
BUNDLE_GEMFILE=gemfiles/activesupport_8_0.gemfile bundle exec rspec
```
Reproduce the exact failing matrix cell locally before changing anything.

**Fix.** Branch on the capability, not on the version number, where possible. If a version must
be excluded, narrow the constraint in `contextual_logger.gemspec`, record it in `CHANGELOG.md`,
and remove the matrix row — this is what `1.3.0` did ("Limit `activesupport` gem to versions
less than 7.1 due to a bug with ActiveSupport Broadcast interface changes") and what `1.4.0`
undid by adding `BroadcastLoggerMixin`.

**Prevention.** `fail-fast: false` is already set in `test.yml` so every combination reports.
Never widen a runtime constraint without adding the matching matrix row and gemfile.

---

## Symptom: `NameError: uninitialized constant ActiveSupport::LoggerThreadSafeLevel::Logger` (or similar) at load

**Cause.** Require order. ActiveSupport 7.0 expects `::Logger` to already be defined when it
loads.

**Fix.** `lib/contextual_logger.rb` already requires `'logger'` **before** `'active_support'`,
with a comment saying why (`cd0905a`). If a new file in this gem requires `active_support`
directly, require `'logger'` first there too — or require the gem entry point instead.

**Prevention.** Don't reorder the requires at the top of `lib/contextual_logger.rb`. The comment
on line 3 is the warning.

---

## Symptom: `ContextualLogger::GlobalContextIsLocked` raised on `logger.global_context = {...}`

**Cause.** A `with_context` override has already been taken somewhere in the process. The first
call to `current_context_override=` sets `ContextualLogger.global_context_lock_message`
(`lib/contextual_logger/context.rb:17`), and `global_context=` refuses from then on
(`lib/contextual_logger.rb:62-64`).

**Diagnose.** The exception message *is* the diagnosis — it names the class, `object_id`, and
context of whatever took the first override:
```
ContextualLogger::Context.current_context_override set for MyApp::Logger 12345: {:trace_id=>"ABCD"}
```

**Fix (application).** Set `global_context` once during boot, before any request handling or
`with_context` block runs.

**Fix (specs).** Reset the lock between examples:
```ruby
after { ::ContextualLogger.global_context_lock_message = nil }
```
Every context-touching spec in this repo carries this. A spec that omits it will cause a
*different*, later spec to fail — the failure appears far from its cause, and the failing spec
changes with RSpec's ordering.

**Prevention.** Add the `after` hook to any new spec file that calls `with_context`,
`global_context=`, or constructs a `LoggerWithContext`.

---

## Symptom: `ArgumentError: context keys must use symbols not strings: {...}`

**Cause.** A string key was passed in context to `LoggerWithContext.new`. Checked deeply, so a
string key nested inside a hash value also trips it (`logger_with_context.rb:67-78`).

**Fix.** Use symbol keys. If the context comes from parsed JSON or external input, symbolize at
the boundary **before** handing it to the logger — deliberately, choosing what happens on a
collision — rather than expecting the gem to do it.

**Prevention.** This is intentional, introduced in `1.5.0`. The gem previously normalized string
keys silently (`0.11.0`); that allowed `'id'` and `:id` to collide invisibly. Do not reintroduce
coercion.

---

## Symptom: Context set in a `with_context` block leaks into later code

**Cause (a).** The non-block form of `with_context` was used and `reset!` was never called.
```ruby
handler = logger.with_context(trace_id: id)
# ... no handler.reset!
```

**Fix.** Prefer the block form, which resets in an `ensure` and therefore survives exceptions:
```ruby
logger.with_context(trace_id: id) { ... }
```
If the bracketing form is genuinely required, store the handler and reset it in the matching
teardown, defensively: `@handler&.reset!`.

**Cause (b).** Resetting to `nil` instead of to the previous override, in custom code that
mimics `ContextHandler`. `ContextHandler` captures and restores the *previous* value
(`context_handler.rb:5-12`) — that is what makes nesting work.

**Prevention.** Use `ContextHandler`; don't hand-roll a reset.

---

## Symptom: Context is missing from log lines emitted inside a `LoggerWithContext`

**Cause.** Known, documented limitation: `LoggerWithContext#global_context` memoizes the merge
of the base logger's `current_context` on first use. If the base logger enters a `with_context`
block *after* that memoization, the extra context is missed
(`logger_with_context.rb:28-33`, where the tradeoff is recorded as a `TODO`).

**Fix / workaround.** Construct the `LoggerWithContext` inside the enclosing `with_context`
block, or pass the extra context inline on the log call, where precedence level 1 applies.

**Prevention.** This is an accepted performance tradeoff (avoiding a `deep_merge` per log line),
not an oversight. If you change it, update the comment and add a spec covering the ordering.

---

## Symptom: Context from an outer layer wins when an inner layer set the same key

**Cause.** Merge direction. Context is `deep_merge`d so that the **inner** (higher-precedence)
layer is the argument, not the receiver: `current_context.deep_merge(stacked_context)`.
Reversing the operands inverts precedence.

**Diagnose.** The five-level precedence contract is asserted end to end by
`spec/lib/contextual_logger/logger_with_context_spec.rb` ("implements the full context from 1 to 5").
Run that spec first — it will fail loudly if a merge was reversed.

**Fix.** Route the merge through `deep_merge_with_current_context` rather than merging at the
call site.

---

## Symptom: `expect_any_instance_of(Logger::LogDevice)` / log-line expectations fail on a different Ruby

**Cause.** The expected string depends on a format that changed between Ruby versions. This has
happened twice in this repo: `Hash#inspect` changed its spacing around `=>` in newer Rubies
(`b2ce6a6`, `87187b7`), and messages are logged via `inspect` (`normalize_message`).

**Fix.** Compare semantically, not textually. Use the `a_json_log_line_like` matcher defined in
`spec/lib/contextual_logger_spec.rb`, which parses both sides as JSON before comparing, or
`JSON.parse(log_stream.string)` and assert on the parsed hash. Where an `inspect`-ed value must
be matched, tolerate whitespace variation in the regex rather than pinning exact spacing.

**Prevention.** Assume any `inspect` output can change between the Ruby versions in the CI
matrix (3.3 and 3.4 today).

---

## Symptom: Timestamps make a spec non-deterministic

**Cause.** `write_entry_to_log` stamps `Time.now` at log time (`lib/contextual_logger.rb:140`).

**Fix.** Freeze time with the shim installed in `spec/spec_helper.rb`:
```ruby
before { Time.now_override = Time.now }
```
There is no timecop-style gem in this project; `Time.now_override` is the mechanism.

**Prevention.** Where the timestamp is not the thing under test, exclude it from the comparison —
`logger_with_context_spec.rb` uses `.except(:timestamp)`.

---

## Symptom: A registered secret still appears in the log

**Cause (a).** The secret was registered on a *different* logger instance. `redactor` is
memoized per logger object (`lib/contextual_logger.rb:156-158`), so `register_secret` on one
logger does not redact another's output.

**Cause (b).** A new write path bypassed `write_entry_to_log`, which is the single point where
`redactor.redact` is applied (`contextual_logger.rb:146-152`).

**Cause (c).** The secret arrives in the log line in a different form than registered — e.g.
URL-encoded, or split across a message and a context value. `register_secret` escapes the
literal with `Regexp.escape` and matches it verbatim; it does not normalize encodings.

**Fix.** Register on the logger that actually writes; for a `LoggerWithContext`, that is the
underlying base logger. For pattern-shaped secrets use `register_secret_regex` with a pattern
covering the forms you expect — the README's example uses `\K` to redact only the value, not the
key.

**Prevention.** Route every new output path through `write_entry_to_log`. Add a spec asserting
the secret is absent from `log_stream.string`, in the style of `spec/lib/contextual_logger/redactor_spec.rb`.

---

## Symptom: `rubocop` fails to start, or reports unexpected offenses with no local change

**Cause.** `.rubocop.yml` inherits over HTTP from
`https://raw.githubusercontent.com/Invoca/style-guide/master/ruby/.rubocop.yml`. Offline, the
fetch fails; and because it tracks `master`, upstream changes alter results without a commit
here. RuboCop is also pinned to `0.54.0`, which is far behind current releases.

**Fix.** Run with network access. If upstream changed, decide deliberately whether to adopt the
new rule or pin the inherit URL to a tag.

**Prevention.** Note that **RuboCop is not part of CI** — `.github/workflows/test.yml` runs only
`bundle exec rspec`. Lint is enforced by convention (and historically by Hound, per
`CONTRIBUTING.md`), not by the merge gate. Don't assume a green PR means lint-clean.

---

## Symptom: A new file works locally but is missing from the published gem

**Cause.** `contextual_logger.gemspec` sets `spec.files = Dir['lib/**/*']`. Only `lib/` ships.

**Fix.** Put anything a consumer needs at runtime under `lib/`.

**Prevention.** Before releasing, confirm with `gem build contextual_logger.gemspec` and
`gem contents` (or `tar tf`) that the new file is in the package.

---

## Symptom: A CI matrix row references a gemfile that does not exist

**Cause.** `.github/workflows/test.yml` lists gemfile paths by hand, while `gemfiles/*` is
generated from `Appraisals` by `appraisal`. The two drifted.

**Fix.**
```bash
bundle exec appraisal install      # regenerates gemfiles/ from Appraisals
```
then reconcile the `matrix.gemfile` list in `test.yml` against `ls gemfiles/`.

**Prevention.** Treat `Appraisals` + `test.yml` as one change: editing one without the other is
the failure.

---

## Symptom: Edits are blocked with "WORKTREE VIOLATION: file edits are not allowed in the main repo working tree"

**Cause.** ADLC's `check-worktree-edit` PreToolUse hook. Worktree isolation (Universal Rule 1)
is mechanically enforced — all work happens in a linked worktree, never the main checkout.

**Fix.**
```bash
adlc-cli git worktree add --branch <branch-name>
# then address files by that worktree's absolute path
```

**Prevention.** Create the worktree first. The emergency bypass `ALLOW_MAIN_EDIT=1` exists for
genuine one-offs only, never routine work.

---

## Symptom: ADLC agents behave as though the session rules were never loaded

**Cause.** The root `CLAUDE.md` import is the only thing that loads them, and a wrong path fails
*silently* — no error, just no rules.

**Diagnose.**
```bash
cat CLAUDE.md                 # must contain: @adlc/methods/session-rules.md
ls -l adlc                    # must be a live symlink into the installed framework
cat adlc/methods/session-rules.md | head -3
```

**Fix.** Re-run `/adlc-init` (it repairs a stale or wrong `@adlc/...` import in place). If the
`adlc` symlink itself is missing, re-bootstrap: `adlc bootstrap /absolute/path/to/this-repo`.

**Prevention.** `/adlc-init verify` reports import, hook, permission, and version-pin conformance.
