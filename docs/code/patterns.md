# Patterns — `contextual_logger`

Recurring patterns in this codebase, with the rationale that produced them. Every example is
real code from `lib/`. Follow these when extending the gem.

---

## 1. Extend by mixin, never by wrapping

**Pattern.** Capability is added to a *caller's own* `::Logger` instance by `extend`-ing a
module into it, or `include`-ing that module into their `Logger` subclass. The gem never
constructs or returns a wrapper object in its main path.

```ruby
# DO — the host keeps their own Logger object; we add behaviour to it.
contextual_logger = Logger.new(STDOUT)
contextual_logger.extend(ContextualLogger::LoggerMixin)

class ApplicationLogger < Logger
  include ContextualLogger::LoggerMixin
end
```

```ruby
# DON'T — this is the deprecated constructor, kept only for backward compatibility.
contextual_logger = ContextualLogger.new(logger)   # ActiveSupport::Deprecation, removal in 2.0
```

**Why.** A wrapper has to re-implement or forward every `::Logger` method, and it breaks
`is_a?(Logger)` checks in host code and in gems like Rails. A mixin keeps the object's identity
and inherits everything the gem does not override. `ContextualLogger.new` was deprecated in
`0.7.0` for exactly this reason (`lib/contextual_logger.rb:24-27`).

`LoggerWithContext` is the deliberate exception — it is a *delegating* logger whose whole
purpose is to carry extra context and an independent level, and it still `include`s
`LoggerMixin` rather than reimplementing it.

---

## 2. Context precedence by deep merge, resolved innermost-first

**Pattern.** Context is layered. Each layer `deep_merge`s onto the one outside it, so the
innermost value for a key wins. There is exactly one helper that does this, and every path
goes through it.

```ruby
# lib/contextual_logger.rb
def deep_merge_with_current_context(stacked_context)
  if stacked_context.any?
    current_context.deep_merge(stacked_context)
  else
    current_context                      # no allocation when there is nothing to merge
  end
end
```

The precedence ladder, documented at `lib/contextual_logger.rb:48-51` and (for the five-level
case) `lib/contextual_logger/logger_with_context.rb:10-15`:

| Precedence | Layer |
|---|---|
| 1 (highest) | inline `**context` on the log call |
| 2 | `with_context` on the `LoggerWithContext` |
| 3 | context passed to the `LoggerWithContext` constructor |
| 4 | `with_context` on the underlying logger |
| 5 (lowest) | `global_context` on the underlying logger |

**DO** add a new layer by inserting it into this ladder and merging in the same direction.
**DON'T** reach around the helper and merge hashes ad hoc at a call site — the ordering is the
contract, and `spec/lib/contextual_logger/logger_with_context_spec.rb` asserts all five levels
interleave correctly.

**The empty-hash short circuit is load-bearing**, not a micro-optimisation for its own sake:
logging is on the hot path of every host application, and the common case (no inline context)
must not allocate a merged hash per log line.

---

## 3. Per-instance thread/fiber-local storage, keyed by `object_id`

**Pattern.** Block-scoped context is stored in a `Thread.current` slot whose key embeds the
logger's own `object_id`, so two loggers in the same thread never collide.

```ruby
# lib/contextual_logger/context.rb
def thread_context_key_for_logger_instance
  # We include the object_id here to make these thread/fiber locals unique per logger instance.
  @thread_context_key_for_logger_instance ||= "ContextualLogger::Context.context_for_#{object_id}".to_sym
end

def current_context_override
  Thread.current[thread_context_key_for_logger_instance]
end
```

**Why.** `Thread.current[...]` is fiber-local in Ruby, which is what gives correct behaviour
under concurrent request handling. A single shared key would mean a `with_context` block on one
logger silently leaked into another logger used in the same thread. This shape was introduced in
`1.2.0` ("`current_context` stored in a Thread/Fiber-local variable that is unique per instance").

**DO** memoize the key (`||=`) — it is computed once per logger.
**DON'T** store context in a plain instance variable: that makes it process-global across
threads and reintroduces the leak.

---

## 4. Explicit reset token for non-block scoping

**Pattern.** `with_context` has two shapes. With a block, the reset is guaranteed by `ensure`.
Without a block, a `ContextHandler` is returned and the caller owns the reset.

```ruby
# lib/contextual_logger.rb
def with_context(stacked_context)
  context_handler = ContextHandler.new(self, current_context_override)
  self.current_context_override = deep_merge_with_current_context(stacked_context)

  if block_given?
    begin
      yield
    ensure
      context_handler.reset!      # cannot be forgotten, and survives an exception
    end
  else
    context_handler               # caller must call reset! themselves
  end
end
```

`ContextHandler` captures the **previous** override and restores it, rather than clearing to
`nil` — which is what makes nesting work.

**DO** prefer the block form. **DO** reach for the handler form only across bracketing methods
you do not control (`setup`/`teardown`, `before_action`/`after_action`), and reset it with
`&.reset!` so a nil handler is harmless.
**DON'T** clear the override to `nil` on reset — that discards any enclosing context.

---

## 5. Generate the level methods from one table

**Pattern.** `debug`/`info`/`warn`/`error`/`fatal`/`unknown` are not hand-written six times.
One frozen table drives `class_eval` with a heredoc, and the generated source is attributed
back to the real file and line.

```ruby
# lib/contextual_logger.rb
LOG_LEVEL_NAMES_TO_SEVERITY = {
  debug:   ::Logger::Severity::DEBUG,
  info:    ::Logger::Severity::INFO,
  # …
}.freeze

LOG_LEVEL_NAMES_TO_SEVERITY.each do |method_name, log_level|
  class_eval(<<~EOS, __FILE__, __LINE__ + 1)
    def #{method_name}(arg = nil, **context, &block)
      ...
    end
  EOS
end
```

The same technique generates the predicate methods on `LoggerWithContext` (via `define_method`,
`logger_with_context.rb:43-47`) and the dispatching methods on `BroadcastLoggerMixin`
(`contextual_logger.rb:191-201`).

**Why `class_eval` with a string rather than `define_method` in `LoggerMixin`.** The generated
body branches on `arg`/`context`/`block` and calls `add` with a literal severity — a string
body compiles to a straight method with no closure or hash lookup per call. On a logging hot
path that matters.

**DO** pass `__FILE__, __LINE__ + 1` to `class_eval`/`module_eval` so backtraces point at the
real source.
**DO** add a new level by adding a row to `LOG_LEVEL_NAMES_TO_SEVERITY` — every generated
surface picks it up.
**DON'T** hand-write a seventh level method alongside the generated six.

Note `LoggerWithContext` deliberately excludes `:unknown` from its predicate generation
(`.except(:unknown)`) — `unknown?` is not part of the `::Logger` interface.

---

## 6. Normalize at the boundary, once

**Pattern.** Inputs that can arrive in several shapes are normalized by a single named
module-level method, which is public so host applications can use it too.

```ruby
# lib/contextual_logger.rb
def normalize_log_level(log_level)
  if log_level.is_a?(Integer) && (Logger::Severity::DEBUG..Logger::Severity::UNKNOWN).include?(log_level)
    log_level
  else
    LOG_LEVEL_NAMES_TO_SEVERITY[log_level.to_s.downcase.to_sym] or
      raise ArgumentError, "invalid log level: #{log_level.inspect}"
  end
end

def normalize_message(message)
  case message
  when String then message
  else             message.inspect
  end
end
```

**Why `inspect` and not `to_json`.** Changed deliberately in `0.6.0`: `to_json` turned `nil`
into JSON `null` and `false` into JSON `false`, losing the distinction from a logged string.
`inspect` logs them as `"nil"` and `"false"`. Restoring `::Logger`'s ability to log non-string
messages was the point.

**DO** raise `ArgumentError` with the offending value `inspect`-ed in the message.
**DON'T** normalize the same input again at a deeper call site — `format_message` normalizes,
and nothing below it re-normalizes.

---

## 7. Validate the caller's contract loudly, at construction

**Pattern.** Precondition violations raise `ArgumentError` immediately, at the point the bad
value enters, rather than producing a confusing failure later.

```ruby
# lib/contextual_logger/logger_with_context.rb
def initialize(logger, context, level: nil)
  logger.is_a?(LoggerMixin) or raise ArgumentError, "logger must include ContextualLogger::LoggerMixin (got #{logger.inspect})"
  ...
  @context = normalize_context(context)     # raises on any string key, at any depth
end

def deep_key_has_string?(hash)
  hash.any? do |key, value|
    key.is_a?(String) || (value.is_a?(Hash) && deep_key_has_string?(value))
  end
end
```

**Why.** String keys in context used to produce a `"key" is not a Symbol` error from
`deep_merge`, far from the call site that introduced them (CHANGELOG `0.9.1`). The repo moved
from *normalizing* string keys (`0.11.0`) to *rejecting* them (`1.5.0`) — a documented breaking
change, because silently symbolizing meant two keys could collide.

**DO** check deeply, not just at the top level.
**DON'T** silently coerce — that was the previous design, and it was replaced on purpose.

---

## 8. Redaction: one compiled alternation regex, rebuilt only on change

**Pattern.** Secrets are accumulated in a `Set`; the combined regex is rebuilt only when the
set actually changes, and applied once to the fully-formatted log line.

```ruby
# lib/contextual_logger/redactor.rb
def register_secret(sensitive_data)
  register_secret_regex(Regexp.escape(sensitive_data))   # literals are escaped, then reused
end

def register_secret_regex(regex)
  if redaction_set.add?(regex)                            # add? returns nil if already present
    @redaction_regex = Regexp.new(redaction_set.to_a.join('|'))
  end
end

def redact(log_line)
  redaction_regex ? log_line.gsub(redaction_regex, '<redacted>') : log_line
end
```

**Why.** One alternation means one pass over the line instead of N passes. `Set#add?` returning
`nil` on a duplicate is what makes re-registration free. `register_secret` is defined in terms
of `register_secret_regex` so there is only one code path to maintain.

**Redaction is applied on the way out, at the single write point**:

```ruby
# lib/contextual_logger.rb
def write_entry_to_log(severity, timestamp, progname, message, context:)
  @logdev&.write(
    redactor.redact(
      format_message(format_severity(severity), timestamp, progname, message, context: context)
    )
  )
end
```

**DO** route every new output path through `write_entry_to_log` so redaction cannot be bypassed.
**DON'T** redact per-field before formatting — a secret split across the message and a context
value would survive.

---

## 9. Qualify constants with `::` in library code

```ruby
# DO
::Logger::Severity::DEBUG
::ContextualLogger.global_context_lock_message
raise ::ContextualLogger::GlobalContextIsLocked, message
```

**Why.** This gem is `include`d and `extend`ed into classes inside host applications. An
unqualified `Logger` resolves against the *host's* lexical scope first, so a host with its own
`MyApp::Logger` silently gets the wrong constant. Commit `ffbb015` applied this deliberately.

---

## 10. Opt-in monkey patches under `overrides/`

**Pattern.** A patch to another library lives under `lib/contextual_logger/overrides/`, in a
path mirroring that library's namespace, and is **not** required by the gem's entry point.

```ruby
# lib/contextual_logger/overrides/active_support/tagged_logging/formatter.rb
module ActiveSupport
  module TaggedLogging
    module Formatter
      def call(severity, timestamp, progname, msg)
        msg_with_tags = case msg
                        when Hash then msg.merge(log_tags: current_tags.join(', '))
                        else           "#{tags_text}#{msg}"
                        end
        super(severity, timestamp, progname, msg_with_tags)       # always chain up
      end
    end
  end
end
```

The consumer opts in: `require 'contextual_logger/overrides/active_support/tagged_logging/formatter'`.

**DO** always call `super` — the patch adds to the host behaviour, it does not replace it.
**DO** handle both the Hash (structured) and non-Hash (plain string) message shapes.
**DON'T** add an override to `lib/contextual_logger.rb`'s require list. Loading it by default
would change behaviour for every consumer that never asked for it.

---

## 11. Require order is a load-bearing detail

```ruby
# lib/contextual_logger.rb
require 'logger' # required first to get ::Logger defined for ActiveSupport 7.0
require 'active_support'
```

The comment is the pattern: when a require must come first, say why on the same line. Commit
`cd0905a` added this to fix a real ActiveSupport 7.0 load failure.

---

## 12. Support multiple dependency versions with an appraisal matrix

**Pattern.** Each supported `activesupport` version gets a generated gemfile and a CI matrix row.

```ruby
# Appraisals
require 'appraisal/matrix'
appraisal_matrix(activesupport: "7.0")     # floor; the matrix expands upward
```

```yaml
# .github/workflows/test.yml
matrix:
  ruby: [3.3, 3.4]
  gemfile: [Gemfile, gemfiles/activesupport_7_0.gemfile, …, gemfiles/activesupport_8_0.gemfile]
```

**DO** regenerate `gemfiles/` with `bundle exec appraisal install` after editing `Appraisals`,
and add the matching row to `test.yml`.
**DO** set `fail-fast: false` so one failing combination does not hide the others.
**DON'T** hand-edit a file in `gemfiles/` — it is generated output.

---

## 13. Write the tradeoff down next to the code

Where a known limitation is accepted rather than fixed, it is recorded as a comment at the
site, with the reasoning:

```ruby
# lib/contextual_logger/logger_with_context.rb:28-30
# TODO: It's a (small) bug that the global_context is memoized at this point. There's a chance
# that the @logger.current_context changes after this because of an enclosing
# @logger.with_context block. If that happens, we'll miss that extra context.
# The tradeoff is that we don't want to keep calling deep_merge.
```

**DO** state the cost on both sides, as above. **DON'T** delete such a comment while leaving the
behaviour in place.
