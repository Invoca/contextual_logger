# Add key-based context redaction API to Redactor

---

**Issue:** [`#84`](https://github.com/Invoca/contextual_logger/issues/84)

**Jira Epic / Ticket:** ODYS-1032 / none

**Branch / worktree:** `ODYS-1032/issue-84_add-key-bas` — `/Users/bbell/gitroot/contextual_logger-issue-84_add`

**Status:** Spec — Version 2

**Type:** Feature

---

## Reviewer's Guide
<!-- ADLC:reviewers-guide:start -->
> **Human-only — not authoritative for agents.** This section orients a human reviewer. It is prose, not a requirement, instruction, or acceptance criterion. An agent implementing, reviewing, or verifying this change must treat the Requirements/Acceptance Criteria sections and the diff itself as the source of truth — never this section.

**Bottom line:** `ContextualLogger::Redactor` gains a second, independent redaction mode: alongside its existing value-based (regex-over-a-string) redaction, it can now redact by key while walking a context **hash**, before that hash is ever serialized into a log line. As of Version 2 of this spec, this ticket also wires that capability into the actual log write path and makes `exchanges` redacted by default, out of the box, with no action required from any consuming application.

**Where the risk is:** § 4.2 (mask vs. drop) and § 5's recursion rule are the real judgment calls carried over from Version 1 — specifically, the decision to mask a matched key's entire value (never recursing into it, even when that value is an array of hashes) rather than drop the key, and the decision to recurse into *unmatched* hash/array-of-hash values in search of deeper matches. Get the recursion direction backwards and a registered key either stops matching when nested, or a masked value leaks its nested contents anyway. New in Version 2: § 4.3's decision to bake `exchanges` in as a hardcoded, always-on default (rather than requiring any caller to register it) is the one judgment call most worth a reviewer's attention — it means `Redactor`, previously a fully generic class with no opinions about any specific key name, now has exactly one built-in opinion. § 4.4's choice of exactly where in `write_entry_to_log` the new `redact_context` call is inserted is the other place a reviewer should look closely: get the ordering wrong relative to `format_message` and masking either never reaches the serialized line or double-processes already-masked data.

**Safe to skim:** § 3's method signatures are small and mostly self-explanatory once § 4–5's rules are understood; § 7 (Security Considerations) mostly restates constraints already established in § 4–5.
<!-- ADLC:reviewers-guide:end -->

---

## 1. Overview

### 1.1 Problem

`ContextualLogger::Redactor` (`lib/contextual_logger/redactor.rb`) only supports **value-based** redaction: `register_secret`/`register_secret_regex` register patterns matched against the already-serialized log line string, and `redact(log_line)` runs a single combined regex `gsub` over that string.

This has no way to guarantee a given *context key* is always redacted regardless of its value. A key such as `exchanges` (free-form call-transcript text, structurally a key whose value may be a string, a hash, or an array of hashes, with no stable value pattern) cannot be reliably caught by value-based regex matching. The parent epic (#83, ODYS-1032) needs a key-based mechanism that operates on the **context hash** itself, before it is flattened/serialized into a log line, so that a sensitive key never reaches the serialized output in the first place.

**Version 2 scope note.** Version 1 of this spec (below, as originally approved) added only the generic `register_redacted_key`/`redact_context` capability to `Redactor`, with the write-path wiring, the `exchanges` registration itself, and the README documentation all deliberately deferred to sibling sub-issue #85. PR #86 (this ticket's implementing PR) was reviewed against that Version 1 spec and received a reviewer MAJOR finding: the new API had zero production call sites anywhere in the repo — it was reachable only from tests. Raised directly to the operator, with the tradeoff made explicit (ship a narrower #84 now and either record a Staged-Rollout Exception or tighten #85's scope, vs. absorb #85's full work into this ticket), the operator's considered decision was to absorb #85 into #84 in full. This is a deliberate, authorized expansion of this ticket's scope, not a deviation from the original decomposition — Version 2 of this spec reflects that decision. #85's own ticket disposition is unaffected by this amendment: #85 is not closed, and this PR does not supersede it administratively; only its *work* is absorbed here.

### 1.2 Current state — verified against this repo

State as of `0a1b9bb27bf74d765ef7415979f3df80b14370d4`, immediately before this PR's own commits.

`lib/contextual_logger/redactor.rb` today:

```ruby
class Redactor
  attr_reader :redaction_set, :redaction_regex

  def initialize
    @redaction_set   = Set.new
    @redaction_regex = nil
  end

  def register_secret(sensitive_data)
    register_secret_regex(Regexp.escape(sensitive_data))
  end

  def register_secret_regex(regex)
    if redaction_set.add?(regex)
      @redaction_regex = Regexp.new(redaction_set.to_a.join('|'))
    end
  end

  def redact(log_line)
    if redaction_regex
      log_line.gsub(redaction_regex, '<redacted>')
    else
      log_line
    end
  end
end
```

`Redactor` is instantiated once per logger (`lib/contextual_logger.rb`'s `LoggerMixin#redactor`, memoized), and `redact` is called in `write_entry_to_log` **after** `format_message` has already turned the severity/timestamp/progname/message/context into a single string (JSON by default, or whatever a custom `@formatter` returns):

```ruby
def write_entry_to_log(severity, timestamp, progname, message, context:)
  @logdev&.write(
    redactor.redact(
      format_message(format_severity(severity), timestamp, progname, message, context: context)
    )
  )
end
```

`LoggerMixin` delegates `register_secret`, `register_secret_regex`, and `redact` straight through to the memoized `redactor` (`delegate :register_secret, :register_secret_regex, :redact, to: :redactor`).

Context hashes flowing into `write_entry_to_log` are plain Ruby `Hash`es built by `deep_merge_with_current_context` (`ActiveSupport::HashWithIndifferentAccess#deep_merge`-style deep merge). `LoggerWithContext#normalize_context` enforces that every *directly nested Hash* value uses symbol keys (raises `ArgumentError` otherwise, `deep_key_has_string?` in `lib/contextual_logger/logger_with_context.rb`), but that check does not recurse into `Array` elements — so a context value that is an array of hashes (the `exchanges` shape named in the parent epic) may itself contain hashes with string keys. Nothing in the current codebase walks a context hash recursively for any purpose; `Context::EMPTY_CONTEXT` and the hashes assigned via `global_context=`/`current_context_override=` are `.freeze`d, and `deep_merge` does not necessarily deep-dup every nested value it doesn't touch — so any code that walks a context hash must not assume it may mutate hashes (or array elements) it encounters in place.

There are no existing specs under `docs/specs/` for this repo other than the installed `specification-template.md`; this is the first substantive spec in this project.

### 1.3 Goals

- Add a way to register a context **key** (not a value pattern) that must always be redacted wherever it appears in a context hash, at any nesting depth.
- Add a method that, given a context hash, returns an equivalent hash with every registered key's value redacted — covering a key at the top level, a key nested inside other hashes, and a key whose value is itself an array of hashes.
- Leave the existing value-based API (`register_secret`, `register_secret_regex`, `redact`) completely unchanged in behavior.
- **(Version 2)** Wire the key-based redaction capability into the actual log write path, so that a registered key's value is masked in real log output, not only reachable via a direct `Redactor`/`redact_context` call from a test.
- **(Version 2)** Register `exchanges` as a redacted key by default, inside the gem itself, so that `exchanges` content never reaches log output in any environment or any consuming application, with zero required action from any caller.
- **(Version 2)** Document the new key-based redaction API in the README, alongside the existing value-based `register_secret`/`register_secret_regex` documentation.
- **(Version 2)** Record this ticket's user-visible capability in `CHANGELOG.md`/`VERSION`, since the capability is now wired and customer-visible in this PR rather than deferred to a later ticket.

### 1.4 Non-Goals

- **Wiring `exchanges` into any consuming app's own config** (downstream/cross-repo configuration of application-specific redacted keys, beyond the gem's own built-in `exchanges` default) is out of scope — this is #83's (the parent epic's) concern, not this ticket's. This spec's wiring makes `exchanges` redacted out of the box for every consumer of this gem; it does not add any new configuration surface for consuming apps to register their *own* additional keys (that capability — `register_redacted_key` itself — already exists as of Version 1 and is unchanged).
- **Per-key mask-vs-drop configuration** (letting a caller choose drop semantics for some keys and mask for others) is not implemented — see § 4.2 for why a single, uniform semantic (mask) was chosen for all registered keys.
- **Case-insensitive or regex-pattern key registration** (e.g. registering a key *pattern* rather than an exact key name) is not implemented — `register_secret_regex` already exists for pattern-based needs; key-based registration here is exact-match-by-name only, matching the issue's scope.
- **A Staged-Rollout Exception record for the Category 9 (test-only production code) finding** is explicitly not added — see § 4.5. Once this amendment's wiring lands, the API has real production call sites, and an exception record would misrepresent the capability as still deferred.
- **Resolving the open SUGGESTION** about `attr_reader :redacted_keys` mirroring `redaction_regex`/`redaction_set` is carried forward as a known-open, non-blocking item (§ 4.6) — not resolved further by this amendment.

---

## 2. Requirements

1. `Redactor` exposes a way to register a context key (`register_redacted_key`) such that any hash key matching it — by name, regardless of whether the hash uses `Symbol` or `String` keys, and regardless of nesting depth — is eligible for redaction.
2. Registering the same key more than once (as a `Symbol`, as a `String`, or any mix of the two) has no additional effect beyond the first registration — mirrors the existing `register_secret`/`register_secret_regex` dedup behavior (`Set#add?`).
3. `Redactor` exposes a method (`redact_context`) that, given a context `Hash`, returns a new `Hash` in which every key matching a registered redacted key (at any depth, including inside hashes nested within arrays) has its value replaced per the mask semantics in § 4.2 — the matched key itself is never recursed into, regardless of whether its value is a `String`, a `Hash`, or an `Array` of hashes.
4. `redact_context` recurses into **unmatched** `Hash` values, and into `Hash` elements found inside **unmatched** `Array` values, searching for registered keys at any depth. Non-`Hash`, non-`Array` values, and non-`Hash` array elements, are left unchanged.
5. `redact_context` never mutates its input — the original hash (and any frozen hash/array it contains) is left exactly as given; the method's return value is an independent `Hash`.
6. When no redacted keys have been registered, `redact_context` returns a hash structurally equivalent to its input (no redaction applied) — no regression to a caller passing an ordinary context hash through an otherwise-unconfigured `Redactor`.
7. When a registered key is absent from a given context hash entirely, `redact_context` returns a hash structurally equivalent to its input for that portion of the data — no regression to existing output for contexts that simply don't contain the key.
8. None of requirements 1–7 change `redaction_set`, `redaction_regex`, `register_secret`, `register_secret_regex`, or `redact`'s existing behavior in any way — the two redaction mechanisms (value-based, key-based) are independent state and independent methods on the same `Redactor` instance.

**Version 2 — write-path wiring and `exchanges` default:**

9. Every `Redactor` instance has `exchanges` registered as a redacted key by default, with no action required from any caller (consuming application or this gem's own code) — confirmed by `redacted_keys.include?('exchanges')` immediately after `Redactor.new`, with nothing else registered.
10. `LoggerMixin#write_entry_to_log` calls `redactor.redact_context` on the incoming `context:` hash before that hash is serialized (i.e. before it is handed to `format_message`), so that any registered key's value — including `exchanges` — is masked in the actual log line a consuming application's logger writes, at any nesting depth, including when the value is an array of exchange objects (mirrors Requirements 3–4's semantics, now observable end-to-end through a real logger call rather than only via a direct `redact_context` call).
11. The existing `redactor.redact(...)` call in `write_entry_to_log` (the value-based, string-level redaction pass) still runs, unchanged, on the already-context-redacted, fully formatted log line — Requirement 8's independence of the two mechanisms holds end-to-end, not only at the `Redactor` unit level.
12. `LoggerMixin` delegates `register_redacted_key` and `redact_context` to its memoized `redactor`, alongside the existing `register_secret`/`register_secret_regex`/`redact` delegation — so a consuming application (or test) can call `logger.register_redacted_key(:some_key)` directly on a logger instance, exactly as it already can for `register_secret`, without reaching into `logger.send(:redactor)`.
13. README.md's Redaction section documents the new key-based API (`register_redacted_key`, the built-in `exchanges` default, and the resulting log-output behavior) alongside the existing value-based (`register_secret`/`register_secret_regex`) documentation.
14. `CHANGELOG.md` gains an entry (and `VERSION`/`lib/contextual_logger/version.rb` a corresponding bump) for this capability, following this repo's existing CHANGELOG/VERSION conventions (see § 4.7).

---

## 3. API Specification

`N/A — no network/service-boundary API change.` This section documents the new Ruby method signatures `Redactor` gains; there is no HTTP/RPC/event-contract surface.

```ruby
# Registers a context key whose value is always redacted when `redact_context` walks
# a context hash, regardless of nesting depth or value shape.
#
# @param key [Symbol, String] the context key to redact. Symbol and String registrations
#   of the "same" key name are treated as equivalent (normalized to String internally) --
#   see Requirement 2.
# @return [void]
def register_redacted_key(key)
end

# Returns a new Hash equivalent to `context`, except that every key matching a
# registered redacted key (see `register_redacted_key`), at any nesting depth, has its
# value masked per the semantics in spec § 4.2. Does not mutate `context` or anything
# it contains (Requirement 5); safe to call with frozen hashes/arrays.
#
# @param context [Hash] the context hash to redact (as passed into `write_entry_to_log`'s
#   `context:` keyword -- i.e. the same shape every other part of this gem already handles).
# @return [Hash] a new hash with registered keys' values masked.
def redact_context(context)
end
```

`attr_reader :redacted_keys` is added alongside the existing `attr_reader :redaction_set, :redaction_regex`, exposing the registered-key `Set` the same way `redaction_set` exposes the value-based one (useful for tests and for any future caller wanting to introspect what's registered, exactly as `redaction_set` already is).

**Version 2 additions:**

```ruby
# ContextualLogger::Redactor

# Keys registered as redacted by default, with no action required from any caller.
# See spec § 4.3 for why `exchanges` lives here rather than requiring explicit registration.
DEFAULT_REDACTED_KEYS = %w[exchanges].freeze
```

`LoggerMixin`'s delegation line (`lib/contextual_logger.rb`) becomes:

```ruby
delegate :register_secret, :register_secret_regex, :redact, :register_redacted_key, :redact_context, to: :redactor
```

`write_entry_to_log` (`lib/contextual_logger.rb`) becomes (see § 4.4 for why the call is placed here):

```ruby
def write_entry_to_log(severity, timestamp, progname, message, context:)
  @logdev&.write(
    redactor.redact(
      format_message(format_severity(severity), timestamp, progname, message, context: redactor.redact_context(context))
    )
  )
end
```

No change to `write_entry_to_log`'s signature, its callers, or anything else in `lib/contextual_logger.rb` — this is a one-line change to the `context:` argument passed into `format_message`.

---

## 4. Design Decisions

### 4.1 Governing-decision citation

The only file this spec's scope touches is `lib/contextual_logger/redactor.rb`. Its owning LEAF is `docs/architecture/sub-systems/lib-contextual-logger.md` (per the Bounded Walk over `docs/architecture/overview.md`'s routing table). That LEAF's **Key Invariants** and **Security Posture** sections are both currently unpopulated (`<!-- adlc:pending section="key-invariants" reason="structurally-not-derivable" -->` / `<!-- adlc:pending section="security-posture" -->` in `docs/architecture/pending-sections.json` and the LEAF doc itself) — neither carries a "**Governing decision:**" line today. No touched file carries a Governing decision line this spec must reconcile with.

### 4.2 Alternatives considered

**Mask vs. drop (the issue's own open question).** Two semantics were considered for what happens to a matched key's value:

- **Mask** (chosen): replace the value with the literal string `'<redacted>'`, keeping the key present in the resulting hash.
- **Drop**: delete the key (and its value) from the resulting hash entirely.

Mask was chosen for three reasons:
1. **Consistency with the existing API.** `redact(log_line)` already uses the literal marker `'<redacted>'` for value-based redaction (visible in every existing spec and the README's documented examples). Using the same marker for key-based redaction means a log reader sees one consistent redaction convention regardless of which mechanism caught it, rather than two different "something was removed here" signals.
2. **Schema stability for downstream consumers.** Log pipelines, dashboards, or alerting rules that key off a field's *presence* (e.g. "does this log entry have an `exchanges` field at all") keep working — only the field's content changes. Dropping the key changes the hash's shape, which is a larger, less predictable blast radius for any downstream consumer that was relying on the key merely existing.
3. **Satisfies the parent epic's acceptance criterion either way.** #83's rollup acceptance is "`exchanges` no longer appears in log output... including as an array of exchange objects" — masking the entire value to the string `'<redacted>'` means none of the original array/hash content appears in output, which is all the parent epic requires. Drop is not needed to satisfy it.

Per-key configurability (letting some keys mask and others drop) was considered and rejected as unnecessary scope: the issue asks to "decide and implement" one semantic, not to build a configuration surface for it, and no concrete need for mixed semantics exists yet. If a future need for drop semantics emerges, it can be added as a second, explicitly-named method or an option, without touching this spec's design.

**Where to put the key-match check relative to recursion.** The alternative to "match the key, then stop (don't recurse into its value)" would be "recurse into the value first, then also mask it" — but that's wasted work (the value is about to be entirely replaced by the mask) and, worse, is observably different for a value that is a self-referential or very deep structure: recursing in would do unnecessary traversal of data that's being thrown away. Matching and immediately masking (no recursion into the matched value) was chosen as both simpler and strictly cheaper.

### 4.3 Where `exchanges` default-registration happens (Version 2)

The issue text (#85) is explicit: "Register `exchanges` as a redacted context key **in the gem**" — not "document that consuming applications should register it." That rules out the option that would otherwise be most consistent with this gem's existing, fully-opt-in configuration posture (every other piece of `Redactor`'s behavior — secrets, secret regexes, and even other redacted keys — is caller-registered, nothing is redacted unless something explicitly asks for it). Three placements were considered for where that registration actually happens:

- **(a) Hardcode directly in `Redactor#initialize`** — e.g. `@redacted_keys = Set.new(['exchanges'])`. Simplest, but burying a literal business-specific string key inside a constructor's state-initialization logic makes it easy to miss on a future read of the class and gives any future second default key nowhere natural to go.
- **(b) A named `DEFAULT_REDACTED_KEYS` constant, seeded into `@redacted_keys` at `initialize`** (chosen) — `DEFAULT_REDACTED_KEYS = %w[exchanges].freeze`, with `initialize` doing `@redacted_keys = Set.new(DEFAULT_REDACTED_KEYS)`. Same zero-caller-action effect as (a), but the default list is named, grep-able, documented in one place (§ 3), and trivially extensible if a future ticket needs to bake in a second always-redacted key.
- **(c) An explicit opt-in call** that some other piece of this gem's own code (e.g. `LoggerMixin#redactor`) makes when constructing a `Redactor` — e.g. `redactor.register_redacted_key(:exchanges)` right after `Redactor.new`. Rejected: this still requires zero action from a *consuming application*, satisfying the acceptance criterion, but it splits the "what's redacted by default" knowledge across two files (`redactor.rb` and `contextual_logger.rb`) instead of keeping it local to the class that owns `redacted_keys`, for no corresponding benefit — (b) achieves the identical observable behavior with the state and its default living in one place.

(b) was chosen. This is a deliberate, narrow exception to "nothing is redacted unless something explicitly registers it" — scoped to exactly one key name, for exactly the reason the issue states (an `exchanges`-shaped value has no stable value pattern a caller could register via the existing value-based API, so some built-in mechanism is needed for it to be protected by default). It does not change the posture for any other key: a consuming application still registers its own additional keys explicitly via `register_redacted_key`, exactly as before.

### 4.4 Where the write-path wiring is inserted (Version 2)

Per § 1.2's current-state read of `lib/contextual_logger.rb`, `write_entry_to_log` is the single call site where a context hash is both still a `Hash` (not yet serialized) and about to reach `@logdev`:

```ruby
def write_entry_to_log(severity, timestamp, progname, message, context:)
  @logdev&.write(
    redactor.redact(
      format_message(format_severity(severity), timestamp, progname, message, context: context)
    )
  )
end
```

`format_message` is what turns `context:` into part of the serialized string (via `basic_json_log_entry`'s `**context` splat, or via a custom `@formatter`); `redactor.redact` already runs on the fully-formatted string, after serialization. The only point in this call chain where a `Hash` is available to key-walk is the `context` argument to `format_message` itself — so `redact_context` is inserted as a wrapper around that argument: `context: redactor.redact_context(context)`. This is a minimal, single-line change to an existing call site, not a new call site or a new method — `write_entry_to_log`'s signature, its caller (`add`), and its `@logdev&.write` / `redactor.redact(...)` structure are all unchanged.

The alternative considered — redacting inside `format_message` or `basic_json_log_entry` itself, where the context is actually splatted into the output hash/string — was rejected: `format_message` is also reachable with a custom `@formatter` (`@formatter.call(severity, timestamp, normalized_progname, { message: ..., **context })`), and a consuming application's custom formatter has no obligation to call back into `Redactor`. Doing the `redact_context` call in `write_entry_to_log`, before `format_message` is invoked at all, guarantees the masking happens regardless of which formatting path is taken — exactly mirroring why the existing `redactor.redact(...)` call already wraps `format_message`'s return value rather than living inside it.

### 4.5 Category 9 finding — resolved, not exempted (Version 2)

The PR #86 review's MAJOR finding (Category 9 — test-only production code: the Version 1 API had zero production call sites) is resolved by this amendment, not worked around. § 4.4's wiring gives `redact_context` a real production call site (`write_entry_to_log`, on every log write), and § 4.3's default gives `register_redacted_key` a real production effect (the `exchanges` default is itself a registration, exercised on every `Redactor.new`). Per the operator's explicit decision (§ 1.1), no Staged-Rollout Exception record is added for this finding — recording one would misrepresent the capability as still deferred, when after this amendment it is not.

### 4.6 Carried-forward SUGGESTION (non-blocking)

A SUGGESTION from the Version 1 review — exposing `redacted_keys` via `attr_reader`, mirroring the pre-existing `redaction_regex`/`redaction_set` pattern — is already reflected in this spec's § 3/§ 5 (`attr_reader :redaction_set, :redaction_regex, :redacted_keys`) and in the implementation. It is carried forward here as a known-open, non-blocking item per the operator's direction: no further action is required on it as part of this amendment.

### 4.7 CHANGELOG/VERSION convention followed (Version 2)

This repo's existing convention (visible in recent history, e.g. the `TECH-19528` series: `02ca606` "raise ArgumentError if any context keys are strings" alongside `14a76ca` "bump to v1.5.0; update CHANGELOG", both landing in the same PR/merge as `7b07968` and `4a616d1`) is: a feature-bearing PR bumps `lib/contextual_logger/version.rb` and adds a dated `CHANGELOG.md` entry in the same PR as the feature itself, under a `## [X.Y.Z] - YYYY-MM-DD` heading with `### Added`/`### Changed` sub-bullets, following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project's existing Semantic Versioning adherence. This ticket's implementation follows that same convention: a `### Added` entry describing the key-based redaction API and the `exchanges` default, under a new `## [1.6.0]` heading (a minor version bump — new, backward-compatible functionality, no breaking change to any existing public method), dated the day the implementing commit lands.

---

## 5. Implementation Details

**Version 1** confined all changes to `lib/contextual_logger/redactor.rb`. **Version 2** additionally touches `lib/contextual_logger.rb` (the write-path wiring and delegation, § 4.4), `README.md` (documentation, Requirement 13), and `CHANGELOG.md`/`lib/contextual_logger/version.rb` (Requirement 14, § 4.7). No other file in this gem is modified by this spec.

```ruby
module ContextualLogger
  class Redactor
    MASK = '<redacted>'
    DEFAULT_REDACTED_KEYS = %w[exchanges].freeze

    attr_reader :redaction_set, :redaction_regex, :redacted_keys

    def initialize
      @redaction_set   = Set.new
      @redaction_regex = nil
      @redacted_keys   = Set.new(DEFAULT_REDACTED_KEYS)
    end

    # -- existing value-based API: unchanged --
    def register_secret(sensitive_data)
      register_secret_regex(Regexp.escape(sensitive_data))
    end

    def register_secret_regex(regex)
      if redaction_set.add?(regex)
        @redaction_regex = Regexp.new(redaction_set.to_a.join('|'))
      end
    end

    def redact(log_line)
      if redaction_regex
        log_line.gsub(redaction_regex, MASK)
      else
        log_line
      end
    end

    # -- new key-based API --
    def register_redacted_key(key)
      redacted_keys.add(key.to_s)
    end

    def redact_context(context)
      if redacted_keys.empty?
        context
      else
        redact_hash(context)
      end
    end

    private

    def redact_hash(hash)
      hash.each_with_object({}) do |(key, value), result|
        result[key] =
          if redacted_keys.include?(key.to_s)
            MASK
          else
            redact_value(value)
          end
      end
    end

    def redact_value(value)
      case value
      when Hash
        redact_hash(value)
      when Array
        value.map { |element| element.is_a?(Hash) ? redact_hash(element) : element }
      else
        value
      end
    end
  end
end
```

Notes for the code agent:

- `register_redacted_key` normalizes to `String` via `key.to_s` so `register_redacted_key(:exchanges)` and `register_redacted_key('exchanges')` dedup to one entry (Requirement 2) and so `redact_hash`'s `key.to_s` lookup matches a hash using either `Symbol` or `String` keys for that key (Requirement 1).
- `redact_hash` always builds a **new** `Hash` via `each_with_object({})` — it never mutates `hash` in place, which is required because context hashes (or hashes nested within them) may be frozen (Requirement 5).
- `redact_value`'s `Array#map` likewise always builds a new `Array`, for the same reason, and leaves non-`Hash` elements (strings, numbers, `nil`, etc.) untouched by identity.
- The empty-`redacted_keys` fast path in `redact_context` (returning `context` itself, unchanged, rather than always rebuilding) mirrors the existing `redact` method's `if redaction_regex` guard immediately above it in the same class, and satisfies Requirement 6 trivially (structurally equivalent because it's the very same object). **Version 2 note:** because `redacted_keys` is now seeded with `DEFAULT_REDACTED_KEYS` at `initialize`, this fast path is no longer reachable on a freshly-constructed `Redactor` (it's never empty) — Requirement 6 ("no keys registered at all") now describes a state that is only reachable by explicitly clearing `redacted_keys`, which this gem provides no API to do; the fast path itself is unchanged code, kept for the case where it remains relevant (e.g. a hand-constructed `Set` in a test), and is still exercised by the existing Version 1 test coverage at the `Redactor` unit level.
- `MASK` is extracted as a shared constant used by both `redact` and `redact_context`'s `redact_hash`, so the literal `'<redacted>'` string lives in exactly one place — this is a small reuse improvement over the current code (which repeats the literal), not a behavior change: `redact`'s existing behavior (Requirement 8) is unaffected since the constant's value is identical to the literal it replaces.
- `DEFAULT_REDACTED_KEYS` is a `String` array (`%w[exchanges]`), matching `register_redacted_key`'s own `key.to_s` normalization — `Set.new(DEFAULT_REDACTED_KEYS)` seeds `redacted_keys` with the same normalized-`String` shape every other registration path produces, so `redact_hash`'s `key.to_s` lookup matches `exchanges` under either `Symbol` or `String` context keys with no special-casing.

**`lib/contextual_logger.rb` changes (Version 2):**

```ruby
module ContextualLogger
  module LoggerMixin
    include Context

    delegate :register_secret, :register_secret_regex, :redact, :register_redacted_key, :redact_context, to: :redactor

    # ... (global_context, with_context, log-level methods, add: all unchanged) ...

    def write_entry_to_log(severity, timestamp, progname, message, context:)
      @logdev&.write(
        redactor.redact(
          format_message(format_severity(severity), timestamp, progname, message, context: redactor.redact_context(context))
        )
      )
    end

    # ... (redactor, format_message, basic_json_log_entry, deep_merge_with_current_context: all unchanged) ...
  end
end
```

Notes for the code agent:

- The only functional change to `lib/contextual_logger.rb` is wrapping the `context` argument passed to `format_message` inside `write_entry_to_log` with `redactor.redact_context(...)`, and extending the single `delegate` line with two additional method names. Nothing else in the file changes.
- `redactor` (the private memoized accessor, `@redactor ||= Redactor.new`) is unchanged — the `exchanges` default comes from `Redactor#initialize` itself (§ 4.3), not from any special construction here.
- Delegating `redact_context` (not only `register_redacted_key`) mirrors why `redact` is already delegated today (CHANGELOG 1.3.0: "expose the existing redaction logic outside of just logs") — the same rationale extends to the key-based mechanism's own redact method, for test/introspection use directly on a logger instance.

**`README.md` changes (Version 2):** a new subsection is added under the existing `## Redaction` heading, after `### Registering a Secret` and before `## Overrides`, documenting `register_redacted_key` and the built-in `exchanges` default — see § 6/§ 8 for the acceptance criterion this satisfies. Exact prose is left to the implementing agent; it must, at minimum: show `register_redacted_key` registering an additional key, show the resulting masked log line, and state explicitly that `exchanges` is redacted by default with no registration call needed.

**`CHANGELOG.md`/`VERSION` changes (Version 2):** per § 4.7, bump `lib/contextual_logger/version.rb` to `1.6.0` and add a `## [1.6.0] - {release date}` section to `CHANGELOG.md` with a `### Added` entry describing the key-based redaction API and the `exchanges` default, matching the style of the existing `## [1.3.0]` entry ("`ContextualLogger::LoggerMixin#redact` method to expose the existing redaction logic outside of just logs").

---

## 6. Testing Requirements

All new tests live in `spec/lib/contextual_logger/redactor_spec.rb` (the existing spec file — no new spec file needed). The existing `#register_secret` and `#redact` `describe` blocks must be left passing unmodified (Requirement 8 / the existing-behavior acceptance criterion) — this spec adds new `describe` blocks alongside them, and does not alter the existing ones.

New coverage required (mapping directly to the issue's own acceptance criteria and to Requirements 1–8 above):

1. **`#register_redacted_key`**
   - Adds a new key to `redacted_keys` (mirrors the existing `#register_secret` "adds the new sensitive data to the redaction set" test shape).
   - Registering the same key twice (as the same type) adds it only once.
   - Registering a key as a `Symbol` and then as a `String` (or vice versa) still results in exactly one entry in `redacted_keys` (Requirement 2).

2. **`#redact_context` — top-level key** (issue's "top-level key" acceptance item)
   - A context hash with a registered key at the top level has that key's value replaced with `'<redacted>'`; sibling keys are untouched.

3. **`#redact_context` — nested key** (issue's "nested key" acceptance item)
   - A registered key appearing one or more levels deep inside nested hashes has its value masked at that depth; the hash structure above and around it is otherwise untouched.

4. **`#redact_context` — array-of-hashes value** (issue's "array-of-hashes value" acceptance item)
   - A registered key whose own value is an array of hashes (e.g. an `exchanges`-shaped value `[{ request: '...' }, { response: '...' }]`) has its **entire value** replaced with `'<redacted>'` (the array itself does not appear in the output; its elements are not individually masked or recursed into) — this is the test that locks in § 4.2's "match, don't recurse into the match" decision.
   - A registered key nested *inside* an array of hashes at a non-matching key (e.g. `{ items: [{ exchanges: [...] }, { other: 1 }] }`) has the nested `exchanges` key masked inside the relevant array element, while the sibling `other: 1` element is untouched — this is the test that locks in "recurse into unmatched array-of-hashes looking for deeper matches."
   - An array value under an unmatched key containing a mix of hashes and non-hash elements (e.g. `['a string', 5, { exchanges: 'x' }]`) masks only the hash element's matching key and leaves the non-hash elements unchanged.

5. **`#redact_context` — key absent** (issue's "key-absent" acceptance item)
   - A context hash that does not contain any registered key, run through `redact_context`, is structurally unchanged (`eq`s the original input) — no regression.
   - With zero keys registered at all, `redact_context` returns the given hash unchanged (and, since this is the fast path in § 5's implementation, may assert `equal?` identity in addition to `eq`).

6. **Non-mutation / frozen-input safety**
   - Calling `redact_context` with a deeply frozen context hash (top-level hash and nested hashes/arrays all `.freeze`d, mirroring how `Context::EMPTY_CONTEXT` and `global_context=`-assigned hashes are frozen in this gem) does not raise `FrozenError` and does not alter the original frozen structure (assert the input `eq`s its own pre-call dup, or assert `frozen?` objects are never written to).
   - The original (unfrozen) hash passed to `redact_context`, inspected after the call, still contains its original (unmasked) values — confirms no in-place mutation occurred even without `.freeze` forcing the point.

7. **Independence from value-based redaction** (issue's "existing value-based redaction behavior is unchanged" acceptance criterion)
   - Registering a redacted key and calling `redact_context` does not alter `redaction_set` or `redaction_regex`, and does not affect what `redact(log_line)` returns for a line not involving that key's name.
   - Registering a secret via `register_secret`/`register_secret_regex` does not add anything to `redacted_keys`, and does not affect what `redact_context` returns for a hash not involving that secret.
   - The full pre-existing `#register_secret` and `#redact` example groups continue to pass as-is.

**Version 2 additions** — new coverage required in `spec/lib/contextual_logger/redactor_spec.rb` and `spec/lib/contextual_logger_spec.rb` (the existing spec file for `LoggerMixin`/`write_entry_to_log`):

8. **`exchanges` registered by default** (`redactor_spec.rb`)
   - A freshly-constructed `Redactor` (`Redactor.new`, nothing registered) already has `'exchanges'` in `redacted_keys`.
   - `redact_context` masks an `exchanges` key's value with no prior call to `register_redacted_key` at all.

9. **End-to-end write-path wiring** (`contextual_logger_spec.rb`, exercising a real logger via `write_entry_to_log`/the public log-level methods, not `Redactor` directly)
   - Logging with an `exchanges:` key in the context produces a log line whose serialized output contains `'<redacted>'` for `exchanges` and does not contain the original value, for: a string value, a nested-hash value, and an array-of-hashes value (mirrors the issue's own "array of exchange objects" acceptance item, now observed through the actual logger rather than through `Redactor` in isolation).
   - Logging with a context that does not contain `exchanges` (and contains no other registered key) produces output identical to what Version 1's pre-wiring behavior would have produced — no regression for ordinary log calls.
   - Logging with both a registered secret (value-based, via `register_secret`) and a registered key (key-based, via `register_redacted_key`) present in the same log call masks both, independently, confirming Requirement 11's end-to-end independence.

10. **Delegation** (`contextual_logger_spec.rb` or `redactor_spec.rb`, whichever already hosts the existing `register_secret`/`register_secret_regex`/`redact` delegation tests)
    - `logger.register_redacted_key(:some_key)` and `logger.redact_context(hash)` are callable directly on a logger instance (mirrors the existing delegation tests' shape for `register_secret`/`redact`).

No changes to any other spec file are required by this ticket.

---

## 7. Security Considerations

- This change is itself a data-exposure-prevention mechanism; its own risk surface is narrow: a key that is *not* registered is not redacted. That's inherent to an explicit-registration design (the same posture `register_secret`/`register_secret_regex` already has — nothing is redacted unless a caller registers it) and is not a new risk introduced by this spec; it is deferred to the caller (#85, for `exchanges` specifically) to register the right keys.
- `redact_context` and `redact` operate on two different representations (a `Hash`, vs. an already-serialized `String`) and are independent — nothing about adding `redact_context` changes what `redact` catches or misses, and vice versa. A context value that both contains a registered key *and* happens to also match a registered value-based secret pattern is still fully protected either way (masked by whichever mechanism's registration applies; if both apply, `redact_context` masks it before serialization, and `redact` has nothing left to additionally match in that span — this is not a conflict, since both mechanisms converge on the same `'<redacted>'` marker).
- Because `redact_context` returns a new, unfrozen `Hash` and never mutates its input, it introduces no risk of a caller's original (potentially shared/frozen) context object being silently altered as a side effect of redaction — see Requirement 5 and the Testing Requirements' non-mutation coverage.
- No new external attack surface, network boundary, or credential handling is introduced — this is an in-process data transformation over an in-memory hash, with the same trust boundary as the existing `redact` method it sits alongside.
- **(Version 2)** Prior to this amendment, the key-based redaction mechanism was fully implemented but reachable only from tests — any log line written through `write_entry_to_log` got no benefit from it, so a context containing `exchanges` (or any other explicitly-registered key) would have reached real log output unmasked. § 4.4's wiring closes that gap: `redact_context` now runs on every log write, before serialization, for every consumer of this gem. This is the central security-relevant change in this amendment — the preceding bullets (independence of the two mechanisms, non-mutation of input) continue to hold with the wiring in place, since the wiring only changes *when* `redact_context` is invoked, not what it does.
- **(Version 2)** `exchanges` being redacted by default (§ 4.3) means a consuming application gains this protection automatically on upgrade, with no code change on its part — the intended security property per the parent epic. The flip side (documented here, not a new risk this spec introduces, but worth naming explicitly): a consuming application that was relying on `exchanges` being *visible* in its own log output (if any such reliance exists) will see that output change the moment it upgrades to a version of this gem carrying this change — see the Plain-English Hand-off's Tradeoffs for the observable, non-technical framing of this.

---

## 8. Acceptance Criteria

- [ ] `Redactor#register_redacted_key` exists, registers a key (normalized across `Symbol`/`String`) into `redacted_keys`, and dedups repeated registrations of the same key (Requirements 1–2).
- [ ] `Redactor#redact_context` exists and masks a registered key's value at the **top level** of a context hash (Requirement 3; issue acceptance item "top-level key").
- [ ] `Redactor#redact_context` masks a registered key's value **nested** below the top level of a context hash (Requirements 3–4; issue acceptance item "nested key").
- [ ] `Redactor#redact_context` masks a registered key whose value is an **array of hashes**, replacing the entire value rather than recursing into it, while still finding a registered key nested *inside* an array-of-hashes value under a different, unmatched key (Requirements 3–4; issue acceptance item "array-of-hashes value").
- [ ] `Redactor#redact_context` returns a context hash **structurally unchanged** when a registered key is absent from it, and when no keys are registered at all (Requirements 6–7; issue acceptance item "key-absent").
- [ ] `Redactor#redact_context` never mutates its input, including frozen hashes/arrays (Requirement 5).
- [ ] Existing value-based redaction behavior (`register_secret`, `register_secret_regex`, `redact`, `redaction_set`, `redaction_regex`) is unchanged — the pre-existing `redactor_spec.rb` example groups pass unmodified, and new cross-checks confirm the two mechanisms' state is independent (Requirement 8).
- [ ] A freshly-constructed `Redactor` has `exchanges` registered as a redacted key with no caller action (Requirement 9).
- [ ] `exchanges` no longer appears in real log output written through a logger's normal log-level methods, in any environment, at any nesting depth, including when its value is an array of exchange objects (Requirements 10–11).
- [ ] `logger.register_redacted_key` and `logger.redact_context` are callable directly on a logger instance via `LoggerMixin` delegation (Requirement 12).
- [ ] README.md's Redaction section documents the new key-based API alongside the existing value-based one (Requirement 13).
- [ ] `CHANGELOG.md` and `lib/contextual_logger/version.rb` carry an entry/bump for this capability, following this repo's existing conventions (Requirement 14, § 4.7).
- [ ] No Staged-Rollout Exception record is present for the Category 9 finding (§ 4.5) — it is resolved, not exempted.
- [ ] No file outside `lib/contextual_logger/redactor.rb`, `lib/contextual_logger.rb`, `README.md`, `CHANGELOG.md`, `lib/contextual_logger/version.rb`, `spec/lib/contextual_logger/redactor_spec.rb`, and `spec/lib/contextual_logger_spec.rb` is modified by this ticket's implementation.

---

## 9. Implementation Status

**Anchor:** State as of `0a1b9bb27bf74d765ef7415979f3df80b14370d4`, immediately before this PR's own commits.

**Implementing commit(s)/PR:** `5c26fdb`, `24aa06f` implement Version 1 of this spec (the `Redactor`-only capability) and are already present on this PR's branch. The Version 2 additions specified above (write-path wiring, `exchanges` default, README, CHANGELOG/VERSION) are pending further commits on the same PR (#86).

**Backfilled:** No — implemented in this same PR.

---

## 10. Changelog

| Version | Date | Change | Rationale |
|---|---|---|---|
| 2 | 2026-10-09 | Absorbed sibling issue #85's full scope into this spec: write-path wiring (`write_entry_to_log`, `LoggerMixin` delegation), a built-in `exchanges` default (`DEFAULT_REDACTED_KEYS`), README documentation of the key-based API, and a CHANGELOG/VERSION bump. Rewrote § 1.4 Non-Goals to remove the write-path-wiring exclusion; added Requirements 9–14, §§ 4.3–4.7 design decisions, Version-2 implementation details and test coverage, and corresponding acceptance criteria. Did not add a Staged-Rollout Exception record for the PR #86 reviewer's Category 9 finding (resolved by the wiring, not exempted). Preserved the mask-not-drop semantic and the matched-key-masked/unmatched-key-recursed-into asymmetry unchanged. Did not touch #85's own ticket disposition. | PR #86 reviewer MAJOR finding: the Version 1 API had zero production call sites (Category 9, test-only production code). Raised to the operator directly, with the tradeoff made explicit; the operator's considered decision was option (b) — absorb #85's work into this ticket in full, rather than a Staged-Rollout Exception or tightening #85's scope. |
| 1 | 2026-10-09 | Initial specification | Decompose epic ODYS-1032 (#83): add the generic key-based context-redaction capability to `Redactor`, ahead of #85 wiring `exchanges` through it. |
