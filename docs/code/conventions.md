# Conventions — `contextual_logger`

Team standards and project conventions for `Invoca/contextual_logger`. Agents read this
before writing or reviewing code. Every rule below is drawn from code actually in this
repository; where the repository is inconsistent, that is called out rather than smoothed over.

---

## Language Standards

The files below are the language guidance that applies to this project. `code`, `test`,
and `reviewer` apply `universal.md` on every task, plus whichever stack-specific guide
matches the file under change.

| Guide | Applies to | Why selected |
|---|---|---|
| `adlc/methods/language-best-practices/universal.md` | every file | always applied |
| `adlc/methods/language-best-practices/ruby.md` | `lib/**/*.rb`, `spec/**/*.rb`, `Rakefile`, `*.gemspec`, `Gemfile`, `Appraisals` | Ruby (non-Rails). This is a **library gem**, not a Rails app — `rails.md` does **not** apply even though `activesupport` is a runtime dependency |
| `adlc/methods/language-best-practices/yaml.md` | `.github/workflows/*.yml`, `.dependabot/config.yml`, `catalog-info.yaml`, `.rubocop.yml` | `yaml.md` (detected: `.github/workflows/*.yml` present — named-directory/first-class-artifact rule, not the density fallback) |

Not selected: `terraform.md` (no `*.tf`), `jsonnet.md` (no `*.jsonnet`/`jsonnetfile.json`),
`python.md`, `typescript-javascript.md`, `kotlin-jvm.md` (no sources in those languages),
`rails.md` (see above — consuming `activesupport` is not the same as being a Rails app).

---

## Technology Stack

| Thing | Value | Source of truth |
|---|---|---|
| Language | Ruby | `.ruby-version` |
| Local/dev Ruby | `3.3.8` | `.ruby-version` |
| CI Ruby matrix | `3.3`, `3.4` | `.github/workflows/test.yml` |
| Runtime deps | `json`, `activesupport >= 6.0` | `contextual_logger.gemspec` |
| ActiveSupport matrix | `7.0`, `7.1`, `7.2`, `8.0` + default `Gemfile` | `.github/workflows/test.yml`, `gemfiles/` |
| Test framework | RSpec | `.rspec`, `Rakefile` |
| Multi-version harness | `appraisal` + `appraisal-matrix` | `Appraisals`, `gemfiles/` |
| Linter | `rubocop` pinned at `0.54.0` | `Gemfile` |
| Lint config | remote — `Invoca/style-guide` `ruby/.rubocop.yml` | `.rubocop.yml` |
| Coverage | `coveralls` (wired in `spec_helper.rb`) | `spec/spec_helper.rb` |
| Version bumping | `bump` gem | `Gemfile` |
| Release target | RubyGems (`allowed_push_host`) | `contextual_logger.gemspec` |
| Service catalog | Backstage — owner `octothorpe`, system `platform-observability` | `catalog-info.yaml` |

**`spec.files = Dir['lib/**/*']`** — the gemspec ships `lib/` only. Anything a consumer
needs at runtime must live under `lib/`, or it will not be in the published gem.

---

## File and Directory Organization

```
lib/
  contextual_logger.rb                  # entry point: requires, module-level helpers,
                                        #   LoggerMixin, BroadcastLoggerMixin
  contextual_logger/
    context.rb                          # Context — thread/fiber-local override storage
    context_handler.rb                  # ContextHandler — non-block with_context reset token
    global_context_lock_message.rb      # module accessor + GlobalContextIsLocked error
    logger_with_context.rb              # LoggerWithContext — delegating logger
    redactor.rb                         # Redactor — secret/regex redaction
    version.rb                          # VERSION
    overrides/                          # monkey-patches of *other* libraries
      active_support/tagged_logging/formatter.rb
spec/
  spec_helper.rb
  lib/                                  # mirrors lib/ one-for-one
    contextual_logger_spec.rb
    contextual_logger/
      <file>_spec.rb
    contextual_logger/mixins/           # exception: spec for an overrides/ file
      active_support_tagged_logging_spec.rb
```

**Conventions:**

- One top-level class or module per file; filename is the `snake_case` of the constant
  (`ContextualLogger::LoggerWithContext` → `lib/contextual_logger/logger_with_context.rb`).
- `lib/contextual_logger/overrides/` holds patches to **other** gems, and the path under it
  mirrors the patched library's own namespace
  (`ActiveSupport::TaggedLogging::Formatter` → `overrides/active_support/tagged_logging/formatter.rb`).
  These files are **not** required by `lib/contextual_logger.rb` — a consumer opts in with an
  explicit `require 'contextual_logger/overrides/...'`. Keep it that way: an override that
  loads by default changes behaviour for every consumer that never asked for it.
- `spec/lib/` mirrors `lib/`. The one divergence today is
  `spec/lib/contextual_logger/mixins/active_support_tagged_logging_spec.rb`, which covers a file
  under `overrides/`. New specs should mirror `lib/` exactly rather than copy that divergence.

---

## Naming Conventions

| Kind | Convention | Example |
|---|---|---|
| Files | `snake_case.rb`, matching the constant | `logger_with_context.rb` |
| Modules/classes | `CamelCase` under `ContextualLogger` | `ContextualLogger::Redactor` |
| Methods | `snake_case`; `?` for predicates, `!` for mutate-and-return | `log_level_enabled?`, `reset!` |
| Constants | `SCREAMING_SNAKE_CASE`, frozen | `LOG_LEVEL_NAMES_TO_SEVERITY`, `EMPTY_CONTEXT` |
| Context keys | **symbols only** — enforced at runtime | `log_source:`, `trace_id:` |
| Errors | noun phrase describing the state | `GlobalContextIsLocked` |
| Mixins | `...Mixin` suffix | `LoggerMixin`, `BroadcastLoggerMixin` |
| Specs | `<source_basename>_spec.rb` | `redactor_spec.rb` |

---

## Code Style

- **`# frozen_string_literal: true` is the first line of every `.rb` file** in `lib/` and
  `spec/`, with no exceptions in the current tree.
- RuboCop inherits from `Invoca/style-guide` over HTTP. The config is **remote**, so lint
  results can change without a commit here, and offline runs fail to fetch it. RuboCop is
  pinned at `0.54.0` and is **not** run by `.github/workflows/test.yml` — the only CI job is
  `bundle exec rspec`. Treat lint as advisory-by-tooling but binding-by-convention.
- Qualify constants that could collide with a host application's own with `::`
  (`::Logger::Severity::DEBUG`, `::ContextualLogger.global_context_lock_message`). This is a
  library loaded into someone else's namespace; commit `ffbb015` ("qualify some constants with
  `::`") made this deliberate.
- Comments explain **why**, and are used heavily for compatibility constraints — see the
  comment block above the generated level methods in `lib/contextual_logger.rb:91-99` and the
  memoization-tradeoff note at `lib/contextual_logger/logger_with_context.rb:28-30`.
  A known, accepted tradeoff is written down as a comment next to the code, not left implicit.
- Hash literals of related constants are aligned for readability
  (`LOG_LEVEL_NAMES_TO_SEVERITY` in `lib/contextual_logger.rb:13-21`).
- `and`/`or` are used for control flow in guard position
  (`LOG_LEVEL_NAMES_TO_SEVERITY[...] or raise ArgumentError`,
  `logger.is_a?(LoggerMixin) or raise ArgumentError`). Keep `&&`/`||` for boolean values.

---

## Public API Surface and Compatibility

This gem is published to RubyGems and mixed into host applications' loggers. The compatibility
contract is unusually tight, and most of the design constraints come from it:

- **`#add` must stay signature-compatible with `::Logger#add`** —
  `add(severity, message = nil, progname = nil)`. `LoggerMixin#add` takes exactly three
  positional parameters plus `**context` precisely so that `ActiveSupport::Logger.broadcast`
  and plain `::Logger` callers keep working. Do not add a fourth positional parameter.
- **Level methods accept every documented arity combination**: message only, context only,
  message + context, block, progname + block, context + block, progname + context + block.
  All seven are exercised in `spec/lib/contextual_logger_spec.rb`.
- **Blocks must not be evaluated unless the level is enabled.** The block is passed down to
  `add`, which checks `log_level_enabled?` first. This was a fixed bug (CHANGELOG `0.10.0`) —
  do not reintroduce an early `yield`.
- **Deprecation, not removal**: `ContextualLogger.new` is deprecated via
  `ActiveSupport::Deprecation` with an explicit removal version, not deleted
  (`lib/contextual_logger.rb:27`). Aliases kept for backward compatibility carry a `TODO`
  naming the version they may go in (`current_context_for_thread`, `lib/contextual_logger.rb:72-73`).
- Every ActiveSupport major/minor in the support window gets a row in the CI matrix and a
  generated `gemfiles/*.gemfile`. Widening or narrowing the window is a CHANGELOG-worthy change
  (see `1.3.0` and `1.4.0` entries).

---

## Testing Conventions

- **RSpec**, run with `bundle exec rspec` (also `rake spec` / `rake` via the `Rakefile`).
- `.rspec` auto-requires `spec_helper`, uses documentation format, and writes a JUnit XML
  report to `spec/reports/rspec.xml` for CI consumption.
- Spec files begin `# frozen_string_literal: true`, then `require 'spec_helper'`, then the
  explicit requires the subject needs (`require 'contextual_logger'`, `require 'logger'`, …).
  Specs do **not** rely on `spec_helper` to load the library.
- `describe ContextualLogger::Thing` with `subject { described_class.new }`; nested behaviour
  is organised with `describe '#method_name'` and `context 'when …' / 'with …'`.
- **Assert on the real log output, not on mocks of the logger.** The dominant pattern is a
  `StringIO` log stream plus a real `Logger`:
  ```ruby
  let(:log_stream) { StringIO.new }
  let(:logger)     { Logger.new(log_stream, level: log_level).extend(ContextualLogger::LoggerMixin) }
  ```
  then matching `log_stream.string`, or parsing it as JSON.
- JSON log lines are compared **semantically**, not as strings — `spec/lib/contextual_logger_spec.rb`
  defines an `a_json_log_line_like` matcher that parses both sides before comparing, so key
  ordering never makes a test brittle.
- Time is frozen by assigning `Time.now_override`, using the `Time.now` shim installed in
  `spec/spec_helper.rb`. There is no timecop-style gem; use the shim.
- `Helpers` (in `spec_helper.rb`) is included into every example group and provides
  `log_at_every_level`, `log_message_at_every_level`, and `log_message_levels`. Reach for these
  rather than re-rolling a six-level loop.
- **Global state must be reset.** `ContextualLogger.global_context_lock_message` is process-global,
  so every spec that touches context carries `after { ::ContextualLogger.global_context_lock_message = nil }`.
  Omitting it leaks `GlobalContextIsLocked` failures into unrelated, later-running examples.
- `mocks.verify_partial_doubles = true` — partial doubles are verified; a stub of a method that
  does not exist fails.
- Coverage is reported to Coveralls from `spec_helper.rb` (`Coveralls.wear!`). There is no
  enforced minimum coverage threshold in-repo.

---

## Git Workflow

- **Default branch: `master`** (not `main`). Never commit to it directly.
- **Branch naming** — the repository has two live conventions:
  - Current, dominant: `<JIRA-KEY>/<short-kebab-description>` —
    e.g. `TECH-19528/support-predicates-for-debug-warn-info-error-fatal`.
    Older variants use `_` instead of `/` (`STORY-18706_update_to_new_ci_standard`).
  - `CONTRIBUTING.md` documents `bug/<issue>_<description>` and `feature/<issue>_<description>`
    for outside contributors.
  Use the Jira-key form for Invoca-internal work; it is what `TECH-19528`, `STORY-18706`, and
  `TECH-13430` all used. ADLC work uses whatever `adlc-cli git name-for <issue>` emits.
- **Commit subjects are prefixed with the ticket key**: `TECH-19528: add predicate methods: …`.
  Work with no ticket uses `No-Jira` (the prefix Dependabot is configured to use in
  `.dependabot/config.yml`) or `non-production:` for repo-chore commits (`c1a3405`, `d44f3e5`).
- Subject line ≤ 50 characters where practical, capitalized, no trailing period, phrased to
  complete *"If applied, this commit will …"* (`CONTRIBUTING.md`).
- Commits are kept small and atomic — a single ticket routinely lands as ten or more commits
  (see the `TECH-19528` run).
- **PRs are merged with a merge commit**, not squashed: `Merge pull request #78 from Invoca/<branch>`.
  History is therefore readable per-commit; keep it that way.
- Never auto-merge. The PR author presents the PR; a human merges it.

---

## Release Conventions

A release is a normal PR containing, together:

1. `lib/contextual_logger/version.rb` — bump `VERSION` per SemVer.
2. `CHANGELOG.md` — a new `## [X.Y.Z] - YYYY-MM-DD` section following
   [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), with `Added` / `Changed` /
   `Deprecated` / `Removed` / `Fixed` subsections as applicable.
3. `README.md` — updated if the public API or support window changed.

The CHANGELOG is maintained in the same commits as the work, and the release date is corrected
at the end if the release slips (`7b07968` "bump v1.5.0 release date"). Publication is to
RubyGems; `allowed_push_host` in the gemspec pins the target.

---

## Dependency Management

- `Gemfile` declares `gemspec` plus development-only gems; runtime dependencies live in
  `contextual_logger.gemspec` and nowhere else.
- `gemfiles/*.gemfile` are **generated** by `appraisal` from `Appraisals`
  (`appraisal_matrix(activesupport: "7.0")`). Edit `Appraisals` and regenerate; never hand-edit
  a file in `gemfiles/`.
- Dependabot is configured via the legacy `.dependabot/config.yml` with
  `version_requirement_updates: "off"` — it bumps the lockfile, never the gemspec constraint.
  Widening a runtime constraint is always a human decision.
- `.github/workflows/dependabot_auto_merge.yml` auto-merges passing Dependabot PRs.

---

## Where Other Knowledge Lives

| Topic | File |
|---|---|
| Recurring code patterns, DO/DON'T | [`patterns.md`](patterns.md) |
| What to avoid and why | [`anti-patterns.md`](anti-patterns.md) |
| Symptom → cause → fix | [`troubleshooting-playbook.md`](troubleshooting-playbook.md) |
| Full project knowledge dump | [`adlc-init.md`](adlc-init.md) |
| Subsystem boundaries, dependency graph | [`../architecture/overview.md`](../architecture/overview.md) |
| Unpromoted learning candidates | [`learnings/`](learnings/) |
