# Learn Command

Capture an informal project discovery — a misleading error, a non-obvious fix, a recurring gotcha —
so future agents don't re-derive it.

## Capture contract

**Write-through is the default.** When the discovery's **Home** (this repository), **Category**
(exactly one of `patterns.md` / `anti-patterns.md` / `troubleshooting-playbook.md` /
`conventions.md`), and **Placement** (one specific section in that file) are all settled, apply a
direct edit to that destination file under `docs/code/`. Always ask for and receive explicit human
confirmation of the edit first — never apply a write-through unattended. On a decline, or when no
human is present to confirm, fall back to staging below.

**Staging is the fallback-only exception**, for a discovery whose destination is genuinely
unresolved at capture time — Home, Category, or Placement is ambiguous (for example, the discovery
spans two destination documents, or belongs to a different repository).

Store path (staging only), one file per discovery:

```
docs/code/learnings/<YYYY-MM-DD>-<short-slug>.md
```

`<short-slug>` is two or three hyphenated words from the observation, e.g.
`2026-08-21-misleading-timeout-error.md`. If that path already exists, pick a distinct slug.

Entry skeleton:

```markdown
# [Short title]

**Observation**: [What future agents should know — one or two sentences]
**Proposed destination**: [patterns.md | anti-patterns.md | troubleshooting-playbook.md | conventions.md]
**Evidence**: [Optional. `path/to/file`, a reproduction command, a log line, a symptom, or a version]
```

Required fields: **Observation** and **Proposed destination** (exactly one). **Evidence** is
optional — add it when available, concrete enough for the promoting human to re-check.

**No status field.** A staged file is *not* authoritative guidance; it is a candidate. It exists
until a human lands its content in the destination it proposes and deletes the file in the same
commit. `ls docs/code/learnings/` is the open backlog.

@adlc/methods/commands/adlc-learn.md
