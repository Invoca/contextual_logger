# {Project Name} — Internal Priority Weighting

> **Internal, not customer-facing.** This document ranks the *execution weighting* of work already deemed in-scope. It answers "of the things we will do, in what order and how urgently?" — **not** "should we do this at all?" (that is [`strategic-priorities.md`](../strategic-priorities.md), the strategic-fit reference).
>
> The **orchestrator** reads this to sequence work and answer "what should we work on next?"; the **product** agent reads it in triage to weight a Ready item's urgency. Keep it current — a stale weighting doc silently mis-sequences the queue. Unlike `strategic-priorities.md`, this file may name specific issue numbers and internal arcs, so it must never be surfaced through any user-facing product surface.

---

## P0 — {gating condition, e.g. "gates the next launch / blocks release"}

The highest-urgency arc. Work here preempts P1/P2. An in-scope issue that advances a P0 arc is worked before anything below.

- {P0 arc 1 — e.g. "privacy by construction (#<N>)"}
- {P0 arc 2}

## P1 — {hardening already-shipped capabilities}

Important but not gating. Worked once P0 has no ready work.

- {P1 arc 1 — e.g. "multi-agent runtime follow-ups (#<N>, #<N>)"}
- {P1 arc 2}

## P2 — background

Hygiene and debt worked opportunistically / when higher tiers are drained.

- {P2 arc 1 — e.g. "dead-code / YAGNI hygiene (#<N>, #<N>)"}
- {P2 arc 2 — e.g. "tech-debt refactors (#<N>, #<N>)"}

## Out of P0–P2

Categories that are in-scope per `strategic-priorities.md` but carry no execution urgency right now — worked only after the tiers above are drained, or explicitly deferred.

- {e.g. "features that aren't launch-completion or compliance"}

---

## Last Updated

{YYYY-MM-DD — who updated it and why, e.g. "2026-07-09 — jb-brown — added the m2 architectural caveat to P2"}
