# Add key-based context redaction API to Redactor

---

**Issue:** [`#84`](https://github.com/Invoca/contextual_logger/issues/84)

**Jira Epic / Ticket:** ODYS-1032 / none

**Branch / worktree:** `ODYS-1032/issue-84_add-key-bas` — `/Users/bbell/gitroot/contextual_logger-issue-84_add`

**Status:** Spec — Version 1

**Type:** Feature

---

## Reviewer's Guide
<!-- ADLC:reviewers-guide:start -->
> **Human-only — not authoritative for agents.** This section orients a human reviewer. It is prose, not a requirement, instruction, or acceptance criterion. An agent implementing, reviewing, or verifying this change must treat the Requirements/Acceptance Criteria sections and the diff itself as the source of truth — never this section.

**Bottom line:** `ContextualLogger::Redactor` gains a second, independent redaction mode: alongside its existing value-based (regex-over-a-string) redaction, it can now redact by key while walking a context **hash**, before that hash is ever serialized into a log line.

**Where the risk is:** § 4.2 (mask vs. drop) and § 5's recursion rule are the real judgment calls — specifically, the decision to mask a matched key's entire value (never recursing into it, even when that value is an array of hashes) rather than drop the key, and the decision to recurse into *unmatched* hash/array-of-hash values in search of deeper matches. Get the recursion direction backwards and a registered key either stops matching when nested, or a masked value leaks its nested contents anyway.

**Safe to skim:** § 3's method signatures are small and mostly self-explanatory once § 4–5's rules are understood; § 7 (Security Considerations) mostly restates constraints already established in § 4–5.
<!-- ADLC:reviewers-guide:end -->

---

## 1. Overview

### 1.1 Problem

`ContextualLogger::Redactor` (`lib/contextual_logger/redactor.rb`) only supports **value-based** redaction: `register_secret`/`register_secret_regex` register patterns matched against the already-serialized log line string, and `redact(log_line)` runs a single combined regex `gsub` over that string.

This has no way to guarantee a given *context key* is always redacted regardless of its value. A key such as `exchanges` (free-form call-transcript text, structurally a key whose value may be a string, a hash, or an array of hashes, with no stable value pattern) cannot be reliably caught by value-based regex matching. The parent epic (#83, ODYS-1032) needs a key-based mechanism that operates on the **context hash** itself, before it is flattened/serialized into a log line, so that a sensitive key never reaches the serialized output in the first place.

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

### 1.4 Non-Goals

- **Wiring this capability into the logger's write pipeline** (calling the new hash-redaction method from `write_entry_to_log`/`format_message` in `lib/contextual_logger.rb`, or adding delegation from `LoggerMixin`) is explicitly deferred to sibling sub-issue #85 ("Enable key-based redaction for `exchanges` and document it"), per #84's own scope ("this ticket is the generic capability only — wiring `exchanges` itself is Child 2"). This spec adds the capability to `Redactor` only; `Redactor` instances remain unused by any other file in this PR.
- **Registering `exchanges` itself** as a redacted key is #85's job, not this spec's.
- **README documentation** of the new API is #85's job (its own acceptance criteria name this explicitly); this spec does not update `README.md`.
- **Per-key mask-vs-drop configuration** (letting a caller choose drop semantics for some keys and mask for others) is not implemented — see § 4.2 for why a single, uniform semantic (mask) was chosen for all registered keys.
- **Case-insensitive or regex-pattern key registration** (e.g. registering a key *pattern* rather than an exact key name) is not implemented — `register_secret_regex` already exists for pattern-based needs; key-based registration here is exact-match-by-name only, matching the issue's scope.

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

---

## 5. Implementation Details

All changes are confined to `lib/contextual_logger/redactor.rb`. No other file in this gem is modified by this spec (see § 1.4 Non-Goals for what's deliberately deferred to #85).

```ruby
module ContextualLogger
  class Redactor
    MASK = '<redacted>'

    attr_reader :redaction_set, :redaction_regex, :redacted_keys

    def initialize
      @redaction_set   = Set.new
      @redaction_regex = nil
      @redacted_keys   = Set.new
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
- The empty-`redacted_keys` fast path in `redact_context` (returning `context` itself, unchanged, rather than always rebuilding) mirrors the existing `redact` method's `if redaction_regex` guard immediately above it in the same class, and satisfies Requirement 6 trivially (structurally equivalent because it's the very same object).
- `MASK` is extracted as a shared constant used by both `redact` and `redact_context`'s `redact_hash`, so the literal `'<redacted>'` string lives in exactly one place — this is a small reuse improvement over the current code (which repeats the literal), not a behavior change: `redact`'s existing behavior (Requirement 8) is unaffected since the constant's value is identical to the literal it replaces.

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

No changes to any other spec file are required by this ticket (per § 1.4 Non-Goals, nothing outside `Redactor` is touched).

---

## 7. Security Considerations

- This change is itself a data-exposure-prevention mechanism; its own risk surface is narrow: a key that is *not* registered is not redacted. That's inherent to an explicit-registration design (the same posture `register_secret`/`register_secret_regex` already has — nothing is redacted unless a caller registers it) and is not a new risk introduced by this spec; it is deferred to the caller (#85, for `exchanges` specifically) to register the right keys.
- `redact_context` and `redact` operate on two different representations (a `Hash`, vs. an already-serialized `String`) and are independent — nothing about adding `redact_context` changes what `redact` catches or misses, and vice versa. A context value that both contains a registered key *and* happens to also match a registered value-based secret pattern is still fully protected either way (masked by whichever mechanism's registration applies; if both apply, `redact_context` masks it before serialization, and `redact` has nothing left to additionally match in that span — this is not a conflict, since both mechanisms converge on the same `'<redacted>'` marker).
- Because `redact_context` returns a new, unfrozen `Hash` and never mutates its input, it introduces no risk of a caller's original (potentially shared/frozen) context object being silently altered as a side effect of redaction — see Requirement 5 and the Testing Requirements' non-mutation coverage.
- No new external attack surface, network boundary, or credential handling is introduced — this is an in-process data transformation over an in-memory hash, with the same trust boundary as the existing `redact` method it sits alongside.

---

## 8. Acceptance Criteria

- [ ] `Redactor#register_redacted_key` exists, registers a key (normalized across `Symbol`/`String`) into `redacted_keys`, and dedups repeated registrations of the same key (Requirements 1–2).
- [ ] `Redactor#redact_context` exists and masks a registered key's value at the **top level** of a context hash (Requirement 3; issue acceptance item "top-level key").
- [ ] `Redactor#redact_context` masks a registered key's value **nested** below the top level of a context hash (Requirements 3–4; issue acceptance item "nested key").
- [ ] `Redactor#redact_context` masks a registered key whose value is an **array of hashes**, replacing the entire value rather than recursing into it, while still finding a registered key nested *inside* an array-of-hashes value under a different, unmatched key (Requirements 3–4; issue acceptance item "array-of-hashes value").
- [ ] `Redactor#redact_context` returns a context hash **structurally unchanged** when a registered key is absent from it, and when no keys are registered at all (Requirements 6–7; issue acceptance item "key-absent").
- [ ] `Redactor#redact_context` never mutates its input, including frozen hashes/arrays (Requirement 5).
- [ ] Existing value-based redaction behavior (`register_secret`, `register_secret_regex`, `redact`, `redaction_set`, `redaction_regex`) is unchanged — the pre-existing `redactor_spec.rb` example groups pass unmodified, and new cross-checks confirm the two mechanisms' state is independent (Requirement 8).
- [ ] No file outside `lib/contextual_logger/redactor.rb` and `spec/lib/contextual_logger/redactor_spec.rb` is modified by this ticket's implementation (§ 1.4 Non-Goals).

---

## 9. Implementation Status

**Anchor:** State as of `0a1b9bb27bf74d765ef7415979f3df80b14370d4`, immediately before this PR's own commits.

**Implementing commit(s)/PR:** pending

**Backfilled:** No — implemented in this same PR.

---

## 10. Changelog

| Version | Date | Change | Rationale |
|---|---|---|---|
| 1 | 2026-10-09 | Initial specification | Decompose epic ODYS-1032 (#83): add the generic key-based context-redaction capability to `Redactor`, ahead of #85 wiring `exchanges` through it. |
