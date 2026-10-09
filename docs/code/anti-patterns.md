# Anti-Patterns — `contextual_logger`

What to avoid in this repository, why, and what to do instead. Each entry is grounded in this
gem's actual constraints — a published library mixed into other people's loggers, on a logging
hot path, across four ActiveSupport majors.

---

## 1. Wrapping the host's logger instead of mixing into it

**Don't:**
```ruby
contextual_logger = ContextualLogger.new(logger)
```

**Do:**
```ruby
logger.extend(ContextualLogger::LoggerMixin)
# or, in your own class:
class ApplicationLogger < Logger
  include ContextualLogger::LoggerMixin
end
```

**Why.** `ContextualLogger.new` is deprecated (`lib/contextual_logger.rb:27`,
`ActiveSupport::Deprecation`, removal slated for 2.0). A wrapper breaks `is_a?(Logger)` checks
in host code and in Rails, and forces the gem to forward every `::Logger` method it does not
care about. Do not add new API that returns a wrapper.

---

## 2. Changing `#add`'s positional signature

**Don't:**
```ruby
def add(severity, message = nil, progname = nil, context = {}, &block)   # fourth positional
```

**Do:**
```ruby
def add(arg_severity, arg1 = nil, arg2 = nil, **context)
```

**Why.** `::Logger#add` is `add(severity, message = nil, progname = nil)`, and
`ActiveSupport::Logger.broadcast` re-implements it with exactly that arity. The `**context`
splat is chosen so that when a classic caller passes three positionals, Ruby binds them to the
three positional parameters; when a context hash is present, Ruby prefers it for `**context`.
This is spelled out at `lib/contextual_logger.rb:91-99` and in CHANGELOG `0.5.1`. A fourth
positional parameter silently breaks every broadcast and plain-`::Logger` caller.

The same rule applies to `write_entry_to_log(severity, timestamp, progname, message, context:)` —
both `LoggerMixin` and `LoggerWithContext` implement it, and `LoggerWithContext#write_entry_to_log`
forwards to the base logger's. Changing one without the other breaks delegation.

---

## 3. Evaluating the message block before the level check

**Don't:**
```ruby
def info(arg = nil, **context)
  message = yield if block_given?     # runs even when info is disabled
  add(INFO, nil, message, **context)
end
```

**Do:** pass the block down and let `add` decide.
```ruby
def add(arg_severity, arg1 = nil, arg2 = nil, **context)
  severity = arg_severity || UNKNOWN
  if log_level_enabled?(severity)
    message = yield if block_given?
    ...
```

**Why.** The block form exists so expensive message construction is skipped when the level is
disabled — that is the entire point of `logger.debug { expensive }`. Evaluating it eagerly was a
real bug, fixed in `0.10.0`. There is a second reason the check cannot move *up* into the level
method: under `ActiveSupport::Logger.broadcast` there are several loggers each with their own
level, so only `add` — running per logger — knows whether this particular one is enabled
(`lib/contextual_logger.rb:97-99`).

---

## 4. String keys in context

**Don't:**
```ruby
logger.info('started', 'log_source' => 'redis_client')
ContextualLogger::LoggerWithContext.new(base, { 'log_source' => 'redis' })
```

**Do:**
```ruby
logger.info('started', log_source: 'redis_client')
```

**Why.** `LoggerWithContext` raises `ArgumentError` on any string key at any depth
(`deep_key_has_string?`, `logger_with_context.rb:67-78`). The gem used to *normalize* string
keys to symbols (`0.11.0`); that was replaced with rejection in `1.5.0` because silent
symbolization lets `'id'` and `:id` collide and one value wins invisibly. Don't reintroduce
coercion as a "convenience".

---

## 5. Mutating a context hash after it has been stored

**Don't:**
```ruby
ctx = { request_id: id }
logger.global_context = ctx
ctx[:request_id] = other_id      # the stored context is frozen; this is a surprise either way
```

**Do:** build a new hash and assign it, or use `with_context` for a scoped override.

**Why.** Both `global_context=` and `current_context_override=` call `.freeze` on the value
(`contextual_logger.rb:65`, `context.rb:18`). Contexts are shared across threads and merged on
every log line; treating them as immutable snapshots is what makes that safe. Mutation attempts
raise `FrozenError`, and in-place mutation of a nested hash — which `freeze` does not reach —
would be a genuine cross-thread data race.

---

## 6. Setting `global_context` after a context override has been taken

**Don't:** assume `logger.global_context = {...}` always works.

**Do:** set global context once, at process start, before any `with_context` block runs. Handle
or avoid `ContextualLogger::GlobalContextIsLocked`.

**Why.** The first call to `current_context_override=` sets
`ContextualLogger.global_context_lock_message` (`context.rb:17`), and `global_context=`
raises `GlobalContextIsLocked` once that is set (`contextual_logger.rb:62-64`). The lock exists
because a global-context change after overrides are live would produce inconsistent context
between threads. Note the lock is **process-global** (a module-level accessor), not per-logger —
one logger taking an override locks global context for all of them.

In specs this is why every context-touching example carries
`after { ::ContextualLogger.global_context_lock_message = nil }`. Omitting it leaks failures
into later examples.

---

## 7. Bypassing `write_entry_to_log` on a new output path

**Don't:**
```ruby
@logdev.write(format_message(...))      # redaction skipped
```

**Do:** route everything through `write_entry_to_log`, which redacts the fully-formatted line.

**Why.** `redactor.redact` is applied once, to the final string, at a single choke point
(`contextual_logger.rb:146-152`). That is what guarantees a registered secret cannot escape via
a message, a progname, or a context value. A second write path is a silent secret leak with no
test that would catch it.

---

## 8. Requiring an `overrides/` file from the gem entry point

**Don't:** add `require_relative './contextual_logger/overrides/...'` to `lib/contextual_logger.rb`.

**Do:** leave it opt-in — the consumer writes
`require 'contextual_logger/overrides/active_support/tagged_logging/formatter'` in their own
startup, as `README.md` instructs.

**Why.** Files under `overrides/` monkey-patch *other gems*. Loading one by default changes
behaviour for every consumer of `contextual_logger`, including those who never use
`TaggedLogging`. Opt-in is the contract.

Related: an override must call `super`. A patch that replaces rather than extends the host
method will break whichever other gem also patched it.

---

## 9. Unqualified constants in library code

**Don't:**
```ruby
Logger::Severity::DEBUG
raise GlobalContextIsLocked, msg
```

**Do:**
```ruby
::Logger::Severity::DEBUG
raise ::ContextualLogger::GlobalContextIsLocked, msg
```

**Why.** `LoggerMixin` is `include`d into classes in host applications, so constant lookup
starts in *their* lexical scope. A host with its own `MyApp::Logger` silently resolves to the
wrong constant. `ffbb015` made this a deliberate convention; `contextual_logger.rb:15-20` and
`logger_with_context.rb:43` follow it.

---

## 10. Allocating on the no-context path

**Don't:**
```ruby
def deep_merge_with_current_context(stacked_context)
  current_context.deep_merge(stacked_context)      # allocates even for an empty hash
end
```

**Do:** short-circuit.
```ruby
if stacked_context.any?
  current_context.deep_merge(stacked_context)
else
  current_context
end
```

**Why.** This runs on every single log line in every host application. `LoggerWithContext#write_entry_to_log`
carries the same `if context.any?` guard for the same reason. Similarly, the thread-local key is
memoized rather than rebuilt per call (`context.rb:9`), and the redaction regex is recompiled
only when the secret set actually changes (`redactor.rb:17`). Treat per-log-line allocation as
a cost that needs justifying.

---

## 11. Hand-writing what the level table generates

**Don't:** add a seventh level method by hand alongside the six generated ones, or duplicate a
predicate method on `LoggerWithContext`.

**Do:** add a row to `LOG_LEVEL_NAMES_TO_SEVERITY`. `LoggerMixin`'s level methods,
`LoggerWithContext`'s predicates, and `BroadcastLoggerMixin`'s dispatchers all derive from it.

**Why.** Three generation sites read that one table. A hand-written seventh method appears on
one surface and silently not the other two.

---

## 12. Hand-editing generated files

**Don't:** edit `gemfiles/activesupport_*.gemfile` directly.

**Do:** edit `Appraisals`, run `bundle exec appraisal install`, and commit the regenerated files
together with the matching `.github/workflows/test.yml` matrix row.

**Why.** `gemfiles/` is `appraisal` output. A hand edit is reverted by the next regeneration,
and a CI matrix row pointing at a gemfile that no longer exists fails obscurely.

Same category: `catalog-info.yaml` is partly generated by `invoca-backstage-tools` and names the
fields that must not be hand-edited in its own header comment.

---

## 13. Letting the README drift from the gemspec

**Current drift, left as a live example.** `README.md` states
*"Ruby >= 2.6 / ActiveSupport >= 4.2, < 7"*, while `contextual_logger.gemspec` requires
`activesupport >= 6.0`, `.ruby-version` pins `3.3.8`, and `.github/workflows/test.yml` tests
Ruby 3.3/3.4 against ActiveSupport 7.0–8.0. The README is several support windows out of date.

**Why it matters here more than in an application.** The README is the gem's landing page on
RubyGems and GitHub — for most consumers it is the only documentation they read, and a wrong
support matrix sends them to the wrong version. Any PR that moves the support window updates
`README.md` and `CHANGELOG.md` in the same change, per the release convention.

---

## 14. Silently dropping a deprecated API

**Don't:** delete `ContextualLogger.new` or the `current_context_for_thread` alias in a minor
release.

**Do:** deprecate with `ActiveSupport::Deprecation` naming the removal version
(`deprecate :new, deprecator: ActiveSupport::Deprecation.new('1.0', 'contextual_logger')`), or
leave a `TODO` naming it (`# TODO: Deprecate current_context_for_thread in v2.0.`), and remove
only on a major.

**Why.** This is a published gem with unknown downstream consumers; SemVer is the contract
(`CHANGELOG.md` header). The repo has consistently chosen a deprecation cycle over a removal.

---

## 15. Specs that assert on mocked log output

**Don't:**
```ruby
expect(logger).to receive(:info).with('started', log_source: 'x')
```

**Do:**
```ruby
let(:log_stream) { StringIO.new }
let(:logger)     { Logger.new(log_stream).extend(ContextualLogger::LoggerMixin) }

it 'includes the context' do
  logger.info('started', log_source: 'x')
  expect(JSON.parse(log_stream.string)).to include('log_source' => 'x')
end
```

**Why.** The behaviour under test *is* the formatting and merging that happens below `#info`.
Mocking the method under test asserts only that it was called. Every meaningful spec in this
repo writes to a real `StringIO`-backed `Logger` and inspects the output.

Related: compare JSON log lines **semantically**. `spec/lib/contextual_logger_spec.rb` defines
an `a_json_log_line_like` matcher that parses both sides first. String-comparing a serialized
hash makes the test brittle to key ordering — and that brittleness has already bitten this repo
in a different form: commits `b2ce6a6` and `87187b7` fixed specs that depended on the exact
spacing of `Hash#inspect`, which changed between Ruby versions.
