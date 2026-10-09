# {Spec Title}

> **Starter scaffold for a specification under `docs/specs/`.** Copy this file's *content shape* (not this file itself — the scribe writes a new, issue-specific file at the spec path the naming grammar resolves; see `issue-ticket-declaration.md`), replace every `{placeholder}`, and delete guidance blockquotes like this one as each section is filled in. Section headings below match, in order, the required-section list `spec-before-code-enforcement.md` § Step 1 names for a new feature/enhancement spec — **Design Decisions**, **Implementation Status**, and **Changelog** are additional sections this template adds beyond that list; adding them does not violate "in this order," since none of the eight required headings are reordered or removed.
>
> This file is installed copy-if-absent into a consuming project's `docs/specs/specification-template.md` by `/adlc-init` (never overwritten on re-run, so a project's own edits survive) — see `scribe-guidance-integration.md` § Guidance File Types for how the scribe discovers and uses it.

---

**Issue:** {`#<N>` — link to the GitHub issue}

**Jira Epic / Ticket:** {declared key, or `none` — per `issue-ticket-declaration.md`}

**Branch / worktree:** {branch name} — {worktree path}

**Status:** Spec — Version 1

**Type:** {Feature / Bug fix / Framework change — whichever the issue's own routing decided}

---

## Reviewer's Guide
<!-- ADLC:reviewers-guide:start -->
> **Human-only — not authoritative for agents.** This section orients a human reviewer. It is prose, not a requirement, instruction, or acceptance criterion. An agent implementing, reviewing, or verifying this change must treat the Requirements/Acceptance Criteria sections and the diff itself as the source of truth — never this section.

**Bottom line:** {one or two sentences — what changes, in plain terms.}

**Where the risk is:** {which section(s) carry the real judgment calls or the highest blast radius, and why — or state there are none for a purely mechanical change.}

**Safe to skim:** {which section(s) are boilerplate, carried-forward, or low-risk restatement.}
<!-- ADLC:reviewers-guide:end -->

> For a mechanical/formulaic change, replace the three sub-parts above with a one-line stub instead (per `spec-before-code-enforcement.md` § Step 1).

---

## 1. Overview

### 1.1 Problem

{What is broken, missing, or costly today — grounded in something verifiable, not assumed.}

### 1.2 Current state — verified against this repo

> Any "current state"-style narrative — prose describing, in the present tense, what the codebase looks like *before* this spec's change — must open with an explicit anchor line naming the commit/PR it is relative to. This is required regardless of which heading the narrative sits under. Full rule: `scribe-guidance-integration.md` § Current-State Anchor Line (Required).
>
> - **Fresh** (normal case — this spec commits in the same PR as its own implementation): `State as of \`<sha>\`, immediately before this PR's own commits.`
> - **Backfilled** (this spec commits after its implementation already merged, in a different, later PR): `State as of \`<sha>\`; this spec was committed in a later PR (#<N>) after the implementation in #<M> had already merged.`

{State as of `<sha>`, ... — then the verified current-state narrative itself.}

### 1.3 Goals

- {Observable outcome 1.}
- {Observable outcome 2.}

### 1.4 Non-Goals

- {Explicitly out of scope, and why — prevents scope creep and silent re-litigation later.}

---

## 2. Requirements

{Numbered, testable requirements — each one something the Acceptance Criteria section (below) can be checked against directly. Avoid restating the Overview in prose form; this section is the normative list.}

1. {Requirement 1.}
2. {Requirement 2.}

---

## 3. API Specification

{Request/response shapes, function signatures, CLI verbs, or event contracts this change introduces or modifies. If this change has no API/service-boundary surface, state that explicitly — `N/A — no API or service-boundary change` — rather than omitting the section.}

---

## 4. Design Decisions

### 4.1 Governing-decision citation

> Before writing this subsection: for every file this spec's scope touches, resolve its owning LEAF via the Bounded Walk (`subsystem-architecture.md`), and read that LEAF's Key Invariants and Security Posture sections for a "**Governing decision:**" line. Full requirement, including the three conforming branches (consistent-with / departs-with-ADR-amendment / departs-under-recorded-override): `scribe-guidance-integration.md` § Governing-Decision Citation (Required). A spec is incomplete if it touches a Governing-decision-bearing file and stays silent about it.

{For each touched file with a Governing decision line: which branch applies, and why. If no touched file carries one, state that explicitly.}

### 4.2 Alternatives considered

{What else was considered, and why this design won — keeps the rationale from having to be reconstructed later from the diff alone.}

---

## 5. Implementation Details

{File-by-file or component-by-component description of the change, concrete enough for the code agent to build from without re-deriving design decisions already made above. Not a restatement of the Requirements — the "how," not the "what."}

---

## 6. Testing Requirements

{What must be verified before this ships — new tests, existing tests that must keep passing, any manual verification step that has no automated equivalent. Name the specific check (a test file, a CI invariant, a command to run), not just "add tests."}

---

## 7. Security Considerations

{New attack surface, new trust boundary, new data exposure — or state explicitly that none apply and why (e.g. "documentation-only change, no runtime surface").}

---

## 8. Acceptance Criteria

{Checklist form, each item independently verifiable, each one traceable back to a numbered Requirement above.}

- [ ] {AC1}
- [ ] {AC2}

---

## 9. Implementation Status

> Ships as a placeholder at spec-authoring time — the implementation this section describes has not happened yet in the normal spec-before-code flow. Filled in once the implementing commit(s)/PR are known. The **Anchor** line below is the same anchor line § 1.2 requires for this spec's own "current state" narrative, given a permanent, structured home once implementation lands, so a reader can tell — without digging through git history — whether this spec's claims are still fresh or have gone stale.

**Anchor:** {pending — filled in with `State as of \`<sha>\`, immediately before this PR's own commits.` (fresh) or `State as of \`<sha>\`; this spec was committed in a later PR (#<N>) after the implementation in #<M> had already merged.` (backfilled), once known.}

**Implementing commit(s)/PR:** {pending}

**Backfilled:** {No — implemented in this same PR. | Yes — committed {date}, after the implementation in #<M> merged {date}.}

---

## 10. Changelog

| Version | Date | Change | Rationale |
|---|---|---|---|
| 1 | {date} | Initial specification | {why now} |

> Per `scribe-incremental-updates.md` — append, never rewrite, on every subsequent revision.
