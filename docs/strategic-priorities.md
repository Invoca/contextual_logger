# Strategic Priorities — Building Trust in ADLC

> This document is the project's strategic-fit reference. The product agent reads it at the start of every triage cycle to evaluate issues for strategic fit and to decide Ready vs. Needs Info vs. Backlog vs. Won't Do. Keep it current — a stale priorities doc produces stale triage decisions. The default below is written for a team still building trust in ADLC; replace or extend it once that trust is established and project-specific priorities take over.

---

## Current Priority

Build trust in ADLC, end to end, on this repo.

Until the team trusts the process, that trust is the priority — not throughput, not the feature list. Select issues that are meaningful to complete and easy for a human to understand and evaluate at spec review and at code review alike, so attention stays on trusting the mechanics of the process rather than being divided onto complex domain work. As confidence builds, issue complexity ramps up with it.

---

## In Focus

Issues that build trust are Ready candidates:

- Small and self-contained, with a narrow blast radius
- Clear acceptance criteria a reviewer can check against, not infer
- A spec and a diff a human can read start to finish in one sitting
- Exercises the full ADLC loop — triage, spec, code, review, merge — without requiring deep domain context to evaluate
- Fixes or clarifies the process itself: templates, docs, agent instructions, tooling

## Out of Focus (Backlog)

Sprawling, multi-subsystem, or deeply domain-complex issues are valid work — they are just not the current focus. They are Backlog candidates, not Won't Do; revisit them as complexity ramps up and trust in the process compounds.

- Multi-subsystem changes that touch several architectural layers at once
- Work that requires deep, pre-existing domain knowledge to review meaningfully
- Large refactors or migrations whose spec and diff can't be reviewed in one sitting

---

## Won't Do Criteria

Categories of request that are out of scope for this project regardless of quality or effort. Issues matching these criteria are candidates for **Won't Do**, closed with an explanation referencing the specific criterion.

- Duplicates of an issue already tracked or already closed
- Requests out of scope for this repo
- {Add project-specific Won't Do criteria as they emerge — e.g. a hard dependency on a vendor's proprietary API, or a feature that requires infrastructure this project doesn't run}

---

## As the Team Matures

This default is deliberately generic — trust-building applies to any team new to ADLC, regardless of domain. Once the team has run enough of the loop to trust the mechanics, layer in the priorities that actually matter here: replace the Current Priority with the project's real north star, and update In Focus / Out of Focus with the themes specific to this product.

---

## Last Updated

{YYYY-MM-DD — who updated it and why, e.g. "2026-07-03 — jb-brown — refocused Q3 priorities on billing reliability"}
