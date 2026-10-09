# Learnings

Write-through is the default for `/adlc-learn`: when a discovery's destination is clear, it becomes a committed edit to that destination file, after explicit confirmation. This directory holds only the exception — a discovery whose destination is genuinely unresolved at capture time — one file per discovery, named `<YYYY-MM-DD>-<short-slug>.md`.

**Not authoritative guidance.** A file here is a candidate. It becomes guidance when a human lands its content in the destination it proposes and deletes the file in the same commit.

What is present is what is open. There is no status field: the directory listing is the backlog, and its length is the signal that promotion has stalled.

Capture with `/adlc-learn`. `/adlc-init verify` does not evaluate this store — it plays no role in learning promotion.
