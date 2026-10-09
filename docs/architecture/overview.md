# Architecture Overview

## Source Roots

- `lib/`

**`max_depth`**: `2`

> Reported, not configured -- the deepest INDEX→...→LEAF path that actually exists in this tree, as measured by the last `architecture-pipeline generate` run.

**R9.1 folds**: `2` sub-threshold algorithm-derived cluster(s) folded, `2` file(s) total, of which `2` routed to directory banding (zero measured coupling to any eligible target) rather than an arbitrary merge. See each affected LEAF's own File Membership section for the per-file basis.

---

## Children (Routing Table)

1. **Lib Contextual Logger** (LEAF)
    - Purpose: Boundary-constrained cluster derived from the reference graph: 6 file(s) under `lib/contextual_logger/` (region cluster-000).
    - Keywords: lib, contextual, logger
    - Path glob(s): `lib/** (partial)`
    - Doc: [`sub-systems/lib-contextual-logger.md`](sub-systems/lib-contextual-logger.md)
2. **Root** (LEAF)
    - Purpose: Directory-banded region containing resolver-claimed files that are sub-threshold or isolated (real resolver edges, but below R9.1's minimum region size and with zero measured coupling to any surviving target, so R9.1 does not force-merge them) -- distinct from files no resolver claims at all; see R1, R9.1.
    - Keywords: root
    - Path glob(s): `lib/contextual_logger/overrides/**`, `lib/contextual_logger/version.rb`
    - Doc: [`sub-systems/root.md`](sub-systems/root.md)

---

## Dependency Graph

Graph omitted — no cross-subsystem dependency edges owned by this INDEX were derived for this tree.

**How to read this graph**: an edge `A --> B` means "subsystem A may import from subsystem B's public contract." The reverse direction is NOT permitted unless a reverse edge is also drawn. Nodes are always **LEAFs** (subsystems) — never intermediate INDEX docs, never this doc itself. An INDEX is a routing fiction, not an importable unit, and does not appear in this graph regardless of how many INDEX levels sit between it and the root.

**Complete-or-nothing**: draw the complete edge set this doc owns under the scope above, or draw no graph and state why in one line with a pointer to the authoritative source (e.g. "graph omitted — dependency data not yet derived for this tree; see PR #NNN"). Never draw a filtered or top-N subset — a partial graph reads as the whole picture while hiding edges, and a reader cannot tell which.

**How to extend**:
- New subsystem (LEAF)? Add a node — but only if the edge(s) it participates in are owned here (cross-subtree, or a direct-child intra edge at depth 2); otherwise the edge belongs on the owning intermediate INDEX instead.
- New cross-subsystem import? Add an edge — but first justify it in the architect's plan, and confirm this is the doc whose scope owns it (its lowest common ancestor). New edges should be rare; most new code fits inside an existing subsystem or its existing dependencies.
- Cycles are bugs. The graph must remain a DAG. If two subsystems need to depend on each other, one of them is two subsystems pretending to be one — split before drawing a cycle.

---

## File Membership

File membership lives at LEAF docs, not here — see each LEAF's own File Membership section.

---

### Invariant I4 — a documented exception: `lib/**`

- **Affected glob(s)**: `lib/**` — marked `(partial)` in the routing-table entries below.
- **Routing entries involved**: Lib Contextual Logger.
- **Rationale**: architecture-pipeline's declared-boundary-constrained clustering (R9) produced a region whose member files are not exactly coverable by one directory subtree -- exact file ownership stays authoritative at each involved LEAF's own File Membership section (I1 holds exactly); only glob-level disjointness (I4) is non-literal here, per the ADLC framework's `subsystem-architecture.md` § I4 in Layer-Organised Repos.
