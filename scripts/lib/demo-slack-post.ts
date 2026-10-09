// scripts/lib/demo-slack-post.ts — pure/testable logic for posting a merged
// ticket's demo video to a public Slack channel, exactly once.
//
// Every gh/network call this file makes goes through an injected function
// (`GhRunner` for `gh`, `FetchLike` for HTTP) rather than a hardcoded
// subprocess/network call, so this file's own logic — video-URL extraction,
// merged-PR resolution, the sentinel-comment exactly-once check, and the
// Slack upload request/response shapes — is unit-testable with no real `gh`
// process or network access. `scripts/demo-slack-post.ts` wires the real
// `gh`/`fetch` implementations for its two live call sites (in-process from
// `.github/scripts/board-status-sync.ts`'s `merge` mode, and as the
// standalone CLI the orchestrator's session-polled checkpoint invokes).
//
// This file ships byte-for-byte to consumer repos (`/adlc-init`'s
// provisioned set). It may import only `node:*` built-ins and its copied
// siblings — no bare package specifiers.

import { redactDetail, errorDetail } from './toolchain.ts';

/** The entire body of the marker comment — presence anywhere in an issue's comments means this issue's demo video was already posted, by either writer. */
export const SENTINEL_COMMENT = '<!-- ADLC:demo-slack-posted -->';

/** Shape every `gh` call in this file expects back — the same `{ output, stdout, status }` triple `.github/scripts/board-status-sync.ts`'s own `adlcGh()` already returns, so that file's `adlcGh` is a drop-in `GhRunner`. */
export interface GhResult {
  output: string;
  stdout: string;
  status: number;
}

export type GhRunner = (args: string[]) => GhResult;

/**
 * Per demoer-artifact-storage.md § Embed recipes / demoer-coverage-report-format.md:
 * the full-session video is always emitted as a bare markdown line — nothing
 * else on that line — of exactly this shape. A per-AC screenshot is always
 * wrapped in `![](...)`, never bare, so this line-anchored check structurally
 * cannot mistake a screenshot for a video.
 */
const VIDEO_LINE_PATTERN = /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/;

/**
 * Extracts the demo video URL from a merged PR's body: every trimmed line
 * matching the bare-line `user-attachments` shape, in document order, taking
 * the LAST match (the issue's own multiple-videos rule) — this also
 * naturally selects the current, non-stale video, since a fix-loop rerun
 * always appends a fresh `## Demo` section after the prior one, per
 * orchestrator-demo-stage.md's stale/re-record handling. Returns `null` when
 * no such line exists (no video attached).
 */
export function extractVideoUrl(prBody: string): string | null {
  const matches = prBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => VIDEO_LINE_PATTERN.test(line));
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Resolves the merged PR completing `issueNumber`, reusing whatever
 * issues-for-PR function the caller already has in scope (`prIssueNumbers`
 * from `.github/scripts/board-status-sync.ts`) rather than importing it
 * directly — this file stays fully decoupled from that file's own module
 * graph (see this file's header comment). The injected function receives the
 * whole PR object (so it can read title, branch, and body alike), not just
 * its title/branch.
 *
 * `prs` is assumed already ordered most-recently-merged-first (`gh pr list
 * --state merged`'s own default order, and `board-status-sync.ts`'s deploy
 * mode's own `covered` list preserves that order) — the FIRST matching entry
 * is therefore the most recently merged one, per the "more than one merged
 * PR names the same issue -> take the most recent" rule.
 */
export function resolveMergedPrForIssue<T>(
  prs: T[],
  issueNumber: number,
  issueNumbersForPr: (pr: T) => number[],
): T | null {
  const match = prs.find((pr) => issueNumbersForPr(pr).includes(issueNumber));
  return match ?? null;
}

/** One comment on an issue, as `gh issue view --json comments` returns it — `viewerDidAuthor` is `gh`'s own report of whether the authenticated identity posted it. */
interface IssueComment {
  body: string;
  viewerDidAuthor?: boolean;
}

/** Shared by `hasSentinelComment` and `getPostProgress` — both need every comment on an issue. */
function readIssueComments(gh: GhRunner, owner: string, repo: string, issueNumber: number): IssueComment[] {
  const result = gh(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'comments']);
  if (result.status !== 0) throw new Error(`cannot read comments for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
  let parsed: { comments: IssueComment[] };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error(`cannot parse comments for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
  }
  return parsed.comments;
}

/** Checked before doing any of the rest of the check-then-post sequence. */
export function hasSentinelComment(gh: GhRunner, owner: string, repo: string, issueNumber: number): boolean {
  return readIssueComments(gh, owner, repo, issueNumber).some((c) => c.body.includes(SENTINEL_COMMENT));
}

/** Posted only once the Slack upload succeeds — append-only, no body-mutation race. */
export function postSentinelComment(gh: GhRunner, owner: string, repo: string, issueNumber: number): void {
  const result = gh(['issue', 'comment', String(issueNumber), '--repo', `${owner}/${repo}`, '--body', SENTINEL_COMMENT]);
  if (result.status !== 0) throw new Error(`cannot post sentinel comment on issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
}

/** The issue's title — read fresh only on the actual-post path (the message text needs it; the skip paths above never need it). */
export function getIssueTitle(gh: GhRunner, owner: string, repo: string, issueNumber: number): string {
  const result = gh(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'title']);
  if (result.status !== 0) throw new Error(`cannot read title for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
  let parsed: { title: string };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error(`cannot parse title for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
  }
  return parsed.title;
}

/** The issue's body — read fresh only on the journal-entry path (Jira-key parsing needs it; the plain video-or-nothing path never needs it). */
export function getIssueBody(gh: GhRunner, owner: string, repo: string, issueNumber: number): string {
  const result = gh(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'body']);
  if (result.status !== 0) throw new Error(`cannot read body for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
  let parsed: { body: string };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error(`cannot parse body for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
  }
  return parsed.body;
}

/**
 * Escapes Slack mrkdwn's three special characters so untrusted text (an
 * issue title) interpolated into a message can never be read as mrkdwn
 * formatting or a `<...>` link/mention by the Slack client rendering it.
 * Per Slack's own escaping contract, these three characters, in this order,
 * are the entire required set — `&` first, so escaping it doesn't also
 * escape the entities just produced for `<`/`>`.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The accompanying `initial_comment` text, identical in wording
 * regardless of which edge (`Post Deploy` or `Closed`) triggered the post —
 * the message describes the ticket shipping, not which edge fired. The
 * issue title is untrusted (attacker-controlled ticket text reaching a
 * public channel), so it is mrkdwn-escaped before interpolation; the static
 * surrounding text and the URL need no escaping.
 */
export function buildMessageText(issueNumber: number, issueTitle: string, owner: string, repo: string): string {
  return `:movie_camera: *#${issueNumber} ${escapeSlackMrkdwn(issueTitle)}* shipped\n<https://github.com/${owner}/${repo}/issues/${issueNumber}|View ticket>`;
}

/**
 * The `https://github.com/user-attachments/assets/<uuid>` embed URL is
 * browser-only: it renders GitHub's React SPA shell for any HTTP client,
 * never the raw file bytes (confirmed live — unauthenticated: HTTP 404; a
 * real user OAuth token: HTTP 200 but an HTML auth-shell page). The rendered
 * PR body HTML resolves each embed to a DIFFERENT, short-lived, pre-signed
 * `https://private-user-images.githubusercontent.com/...?jwt=...` URL that
 * DOES serve the real bytes with no auth header required. This applies
 * identically to a video embed and an image (screenshot) embed — both
 * resolve through the same `private-user-images.githubusercontent.com`
 * mechanism, differing only in file extension.
 *
 * Neither the rendered `<video>`/`<img>` tag's `src` nor its
 * `data-canonical-src` attribute preserves the original raw embed URL
 * anywhere (both are the resolved signed URL, confirmed identical against a
 * real rendered PR) — so matching by attribute equality doesn't work. The
 * real correlation mechanism (confirmed against real captured data):
 * `embedUrl`'s own UUID (its last path segment) appears VERBATIM AS A
 * SUBSTRING inside the resolved signed URL's path segment, prefixed there by
 * an unrelated numeric id. This correctly disambiguates a PR carrying
 * multiple attachments (e.g. a stale + re-recorded pair, or several
 * per-AC screenshots), since each resolved URL contains its own distinct
 * UUID.
 *
 * Returns `null` (never throws) when no `private-user-images` URL in
 * `bodyHtml` contains `embedUrl`'s UUID as a substring, including when
 * `bodyHtml`'s shape doesn't match at all.
 */
const SIGNED_VIDEO_URL_PATTERN = /https:\/\/private-user-images\.githubusercontent\.com\/\S*?\.[A-Za-z0-9]+\?[^\s"'<>]*/g;

export function resolveSignedVideoUrl(bodyHtml: string, embedUrl: string): string | null {
  const uuid = embedUrl.slice(embedUrl.lastIndexOf('/') + 1);
  if (!uuid) return null;
  const candidates = bodyHtml.match(SIGNED_VIDEO_URL_PATTERN) ?? [];
  return candidates.find((signedUrl) => signedUrl.includes(uuid)) ?? null;
}

/**
 * Fetches a PR's fully-rendered body HTML — the input `resolveSignedVideoUrl`
 * resolves the raw embed URL against. Uses the same injected `GhRunner` every
 * other `gh` call in this module goes through.
 */
export function fetchPrBodyHtml(gh: GhRunner, owner: string, repo: string, prNumber: number): string {
  const result = gh(['api', `repos/${owner}/${repo}/pulls/${prNumber}`, '-H', 'Accept: application/vnd.github.html+json', '--jq', '.body_html']);
  if (result.status !== 0) throw new Error(`cannot fetch body_html for PR #${prNumber}: ${redactDetail(result.output.trim())}`);
  return result.stdout;
}

export type FetchLike = typeof fetch;

/**
 * Downloads the video bytes from a resolved, fetchable URL — always the
 * signed `private-user-images.githubusercontent.com` URL
 * `resolveSignedVideoUrl` produces, never the raw, browser-only
 * `user-attachments` embed URL. That signed URL's query-string JWT is a
 * complete, and the ONLY permitted, auth mechanism: attaching a second one
 * (an `Authorization` header) is rejected by the S3-compatible backend with
 * HTTP 400 InvalidArgument — live-confirmed in GH Actions run 34659735826.
 */
/**
 * Downloads any resolved, fetchable signed `private-user-images.
 * githubusercontent.com` asset URL (video or screenshot) — shared by
 * `downloadVideoBytes` (video, error-labeled "video") and per-AC screenshot
 * re-upload (error-labeled "screenshot"). That signed URL's query-string JWT
 * is a complete, and the ONLY permitted, auth mechanism: attaching a second
 * one (an `Authorization` header) is rejected by the S3-compatible backend
 * with HTTP 400 InvalidArgument — live-confirmed in GH Actions run
 * 34659735826.
 */
async function downloadAssetBytes(url: string, label: string, fetchImpl: FetchLike): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    let bodySnippet = '';
    try {
      const bodyText = await response.text();
      // A CDN/S3-style error body commonly echoes the full request URL
      // (including its query string) back in the error message — the same
      // live `jwt` this function's own url-stripping below guards against,
      // reachable through a second path. `redactDetail` redacts and
      // truncates it here too, independent of whatever the URL-stripping
      // catches.
      const redactedBody = redactDetail(bodyText);
      bodySnippet = redactedBody ? `: ${redactedBody}` : '';
    } catch {
      // Reading the body itself failed (or hung) — fall back to the
      // status-only message rather than let diagnostics make failure
      // reporting less reliable than before.
    }
    // `url` is the resolved private-user-images.githubusercontent.com signed
    // CDN link, whose query string carries a short-lived `jwt` bearer token
    // for downloading the asset. That token is fetched dynamically at
    // runtime (never registered as a GH secret), so Actions cannot mask it
    // in logs — interpolating the full url here would print a live,
    // unredactable credential into the job log via this error's eventual
    // console.error. Strip the query string before it goes into the message.
    throw new Error(`failed to download ${label} from ${url.split('?')[0]}: HTTP ${response.status}${bodySnippet}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function downloadVideoBytes(url: string, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  return downloadAssetBytes(url, 'video', fetchImpl);
}

/** Downloads a per-AC screenshot's resolved signed URL, for re-upload as a native Slack file (never posted as a `github.com/user-attachments` link). */
export async function downloadScreenshotBytes(url: string, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  return downloadAssetBytes(url, 'screenshot', fetchImpl);
}

interface SlackUploadResult {
  fileId: string;
}

/**
 * The current, non-deprecated three-call Slack file-upload flow:
 * `files.getUploadURLExternal` -> POST the bytes to the returned
 * `upload_url` -> `files.completeUploadExternal` (the call that actually
 * posts the file into `channelId` as a native, inline-playing video object,
 * carrying `initialComment` as its accompanying text).
 *
 * `threadTs`, when supplied, is passed through as `thread_ts` on the
 * `completeUploadExternal` call — this posts the file as a threaded reply
 * under the message identified by that `ts` rather than as a new top-level
 * channel message. Used both for the demo video (threaded under the
 * anchor announcement message) and per-AC screenshot re-uploads (threaded
 * under the same anchor).
 */
export async function uploadVideoToSlack(
  slackToken: string,
  channelId: string,
  filename: string,
  bytes: Buffer,
  initialComment: string,
  fetchImpl: FetchLike = fetch,
  threadTs?: string,
): Promise<SlackUploadResult> {
  const getUploadUrlResponse = await fetchImpl(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${bytes.length}`,
    { method: 'POST', headers: { Authorization: `Bearer ${slackToken}` } },
  );
  const getUploadUrlBody = (await getUploadUrlResponse.json()) as { ok?: boolean; upload_url?: string; file_id?: string; error?: string };
  if (!getUploadUrlBody.ok || !getUploadUrlBody.upload_url || !getUploadUrlBody.file_id) {
    throw new Error(`files.getUploadURLExternal failed: ${getUploadUrlBody.error ?? 'unexpected response'}`);
  }

  const uploadResponse = await fetchImpl(getUploadUrlBody.upload_url, { method: 'POST', body: new Uint8Array(bytes) });
  if (!uploadResponse.ok) throw new Error(`uploading video bytes to Slack failed: HTTP ${uploadResponse.status}`);

  const completeResponse = await fetchImpl('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: getUploadUrlBody.file_id, title: filename }],
      channel_id: channelId,
      initial_comment: initialComment,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
  const completeBody = (await completeResponse.json()) as { ok?: boolean; error?: string };
  if (!completeBody.ok) throw new Error(`files.completeUploadExternal failed: ${completeBody.error ?? 'unexpected response'}`);

  return { fileId: getUploadUrlBody.file_id };
}

/** Shared by every posting entry point (`postDemoVideoForIssue`, `postJournalEntryForIssue`, `postJournalEntryForPr`). `slackToken`/`channelId` are validated lazily, only once there is actually something to post. */
export interface SlackPostDeps {
  gh: GhRunner;
  /** The Slack bot token. */
  slackToken: string | undefined;
  /** `docs/github-routing.yml`'s `slack.channel_id`. */
  channelId: string | null;
  fetchImpl?: FetchLike;
}

export type PostDemoVideoDeps = SlackPostDeps;

/**
 * Shared `channelId`/`slackToken` guard for every posting entry point — a
 * type guard so a caller's `if (!checkSlackChannelConfigured(deps, ...))
 * return 'no-channel-configured';` narrows `deps.channelId`/`deps.slackToken`
 * to non-nullable for the rest of that function, same as the inline checks
 * this replaces. `channelId` absent is the documented opt-out
 * (github-routing.md's Config Schema: "omit the whole slack: block to skip
 * the post entirely") — a deliberate, silent skip, not a misconfiguration,
 * so it is checked first and never throws: returns `false`. `slackToken`
 * missing while a channel IS configured is a genuine misconfiguration and
 * still throws. `subjectLabel` (e.g. `Issue #123`, `PR #456`) names the
 * post's subject in the skip log line.
 */
function checkSlackChannelConfigured(deps: SlackPostDeps, subjectLabel: string, action: string): deps is SlackPostDeps & { channelId: string; slackToken: string } {
  if (!deps.channelId) {
    console.log(`${subjectLabel}: no slack.channel_id configured in docs/github-routing.yml; skipping Slack post.`);
    return false;
  }
  if (!deps.slackToken) throw new Error(`ADLC_DEMO_AGENT_SLACK_TOKEN must be set to ${action}`);
  return true;
}

export type PostDemoVideoOutcome =
  | 'posted'
  | 'already-posted'
  | 'no-merged-pr'
  | 'no-video'
  | 'no-channel-configured'
  | 'video-resolution-failed';

/**
 * The full check-then-post sequence — the ONE implementation both call sites
 * converge on: in-process from `board-status-sync.ts`'s `merge` mode
 * (`postDemoVideoForMergedPr()`, called once per issue a merged PR
 * completes, unconditionally — no deploy signal or terminal board Status
 * required), and the standalone CLI's session-polled invocation
 * (`scripts/demo-slack-post.ts`).
 */
export async function postDemoVideoForIssue(
  deps: PostDemoVideoDeps,
  owner: string,
  repo: string,
  issueNumber: number,
  resolvedPr: { number: number; body: string; bodyHtml?: string } | null,
): Promise<PostDemoVideoOutcome> {
  if (hasSentinelComment(deps.gh, owner, repo, issueNumber)) {
    console.log(`Issue #${issueNumber}: demo-slack-posted sentinel already present; skipping (the other writer already posted it).`);
    return 'already-posted';
  }

  if (!resolvedPr) {
    console.log(`Issue #${issueNumber}: no merged PR resolved; skipping Slack post.`);
    return 'no-merged-pr';
  }

  const videoUrl = extractVideoUrl(resolvedPr.body);
  if (!videoUrl) {
    console.log(`Issue #${issueNumber}: no video found in merged PR #${resolvedPr.number}'s body; skipping Slack post.`);
    return 'no-video';
  }

  if (!checkSlackChannelConfigured(deps, `Issue #${issueNumber}`, 'post a demo video to Slack')) return 'no-channel-configured';

  // Resolve the raw, browser-only embed URL to its real, fetchable signed CDN
  // URL before downloading anything — the fix for issue #836's confirmed-live
  // bug (the raw `user-attachments` embed URL returns HTTP 200 with an HTML
  // auth-shell page, not video bytes, to every HTTP client; `downloadVideoBytes`
  // only checks `response.ok`, so downloading it "succeeds" and would upload
  // garbage HTML to Slack, then post the sentinel — permanently marking this
  // ticket done with no retry possible). `bodyHtml` missing (the caller
  // couldn't fetch it) or resolution failing (no matching signed URL found)
  // are BOTH treated as a hard stop here: never fall back to the raw
  // `videoUrl`, never download, never post the sentinel. The caller can
  // re-run once the underlying issue (a transient `fetchPrBodyHtml` failure,
  // or a genuinely unresolvable embed) is addressed — the sentinel is only
  // ever posted on a real, verified success.
  if (!resolvedPr.bodyHtml) {
    console.error(`warning: issue #${issueNumber}: merged PR #${resolvedPr.number}'s rendered body_html was not available; cannot safely resolve the video's real download URL. Skipping Slack post (no sentinel posted) rather than risk uploading an unplayable page — retry once body_html can be fetched.`);
    return 'video-resolution-failed';
  }
  const downloadUrl = resolveSignedVideoUrl(resolvedPr.bodyHtml, videoUrl);
  if (!downloadUrl) {
    console.error(`warning: issue #${issueNumber}: could not resolve merged PR #${resolvedPr.number}'s raw video embed URL to a real signed download URL. Skipping Slack post (no sentinel posted) rather than risk uploading an unplayable page.`);
    return 'video-resolution-failed';
  }

  const issueTitle = getIssueTitle(deps.gh, owner, repo, issueNumber);
  const bytes = await downloadVideoBytes(downloadUrl, deps.fetchImpl);
  const messageText = buildMessageText(issueNumber, issueTitle, owner, repo);
  await uploadVideoToSlack(deps.slackToken, deps.channelId, `demo-issue-${issueNumber}.mp4`, bytes, messageText, deps.fetchImpl);
  postSentinelComment(deps.gh, owner, repo, issueNumber);
  console.log(`Issue #${issueNumber}: demo video uploaded to Slack channel ${deps.channelId}; sentinel comment posted.`);
  return 'posted';
}

// ===========================================================================
// Merge-mode journal entry: composed body text (a real Press Release, or a
// pinned fallback line), a links/mention trailer, an anchor message, threaded
// video, and per-AC thread replies — posted for every issue a merged PR
// completes, and for the PR itself when it completes none.
// `postDemoVideoForIssue` above remains the video-or-nothing post the
// deploy-mode, session-polled-checkpoint, and recheck trigger paths call.
// ===========================================================================

/**
 * Extracts the literal, pre-authored Slack mrkdwn press-release text from a
 * spec-backed PR's carried-forward Working Backwards PR/FAQ subsection — the
 * ONLY content the merge-time hook ever posts, read verbatim between the
 * inner `<!-- ADLC:press-release:start/end -->` markers (never the outer
 * working-backwards markers, the heading, the disclaimer, or the optional
 * Anticipated Questions block). Returns `null` when the markers are absent,
 * or the enclosed text is empty (the stub form) — the caller falls back to
 * the pinned fallback body text in that case; the journal entry still
 * posts.
 */
const PRESS_RELEASE_PATTERN = /<!--\s*ADLC:press-release:start\s*-->\n?([\s\S]*?)\n?<!--\s*ADLC:press-release:end\s*-->/;

export function extractPressRelease(prBody: string): string | null {
  const match = prBody.match(PRESS_RELEASE_PATTERN);
  if (!match) return null;
  const text = match[1].trim();
  return text.length > 0 ? text : null;
}

/**
 * §2.1: the pinned fallback anchor line when no Press Release block is
 * found — a single bold line, no video-specific emoji, no separate "View
 * ticket"/"View PR" link line (the links trailer already supplies every
 * resolvable link). Used uniformly for both an issue-completing entry and
 * the zero-issue PR-level entry — always keyed on the PR's own number and
 * title, never the issue's.
 */
export function buildFallbackBodyText(prNumber: number, prTitle: string): string {
  return `:package: *PR #${prNumber}: ${escapeSlackMrkdwn(prTitle)}* merged`;
}

/** A real Press Release block when the PR body carries one; `buildFallbackBodyText`'s pinned fallback otherwise. */
function resolveBodyText(prNumber: number, prTitle: string, prBody: string): string {
  return extractPressRelease(prBody) ?? buildFallbackBodyText(prNumber, prTitle);
}

/**
 * The Jira site every `**Jira Ticket:**`/`**Jira Epic:**` key links against
 * — `atlassian-access-setup.md`'s own site/cloudId discovery default.
 */
const JIRA_SITE = 'invoca.atlassian.net';

/**
 * Parses the `**Jira Ticket:**`/`**Jira Epic:**` lines from an issue body per
 * `issue-ticket-declaration.md`'s grammar — the ticket key wins the naming
 * contest when both are present, mirroring that doc's own resolution order.
 * Trailing prose on the same line (a key followed by a title) is tolerated
 * and ignored; only the key shape itself is captured.
 */
const JIRA_TICKET_LINE_PATTERN = /\*\*Jira Ticket:\*\*\s*([A-Z][A-Z0-9]*-[0-9]+)/;
const JIRA_EPIC_LINE_PATTERN = /\*\*Jira Epic:\*\*\s*([A-Z][A-Z0-9]*-[0-9]+)/;

export function extractJiraKey(issueBody: string): string | null {
  const ticketMatch = issueBody.match(JIRA_TICKET_LINE_PATTERN);
  if (ticketMatch) return ticketMatch[1];
  const epicMatch = issueBody.match(JIRA_EPIC_LINE_PATTERN);
  if (epicMatch) return epicMatch[1];
  return null;
}

/**
 * The PR body's plain `Epic: {KEY}` line
 * (`orchestrator-pr-creation-workflow.md`'s literal template line) — distinct
 * from `extractJiraKey()`'s bold `**Jira Ticket:**`/`**Jira Epic:**`
 * issue-body grammar; this line is never bolded and never carries a
 * Ticket-level key.
 */
const PR_BODY_EPIC_LINE_PATTERN = /^Epic:\s*([A-Z][A-Z0-9]*-[0-9]+)/m;

export function extractJiraKeyFromPrBody(prBody: string): string | null {
  const match = prBody.match(PR_BODY_EPIC_LINE_PATTERN);
  return match ? match[1] : null;
}

/**
 * §2.2's resolution order: a linked issue's own body wins when one is linked
 * (`issueBody` non-null); the PR body's `Epic:` line is a fallback (the
 * issue body declares neither Jira line) or the sole source (`issueBody` is
 * `null` — the zero-issue entry has no issue body to read at all).
 */
export function resolveJiraKey(issueBody: string | null, prBody: string): string | null {
  if (issueBody !== null) {
    const fromIssue = extractJiraKey(issueBody);
    if (fromIssue) return fromIssue;
  }
  return extractJiraKeyFromPrBody(prBody);
}

export function buildJiraLink(key: string): string {
  return `<https://${JIRA_SITE}/browse/${key}|${key}>`;
}

export function buildIssueLink(owner: string, repo: string, issueNumber: number): string {
  return `<https://github.com/${owner}/${repo}/issues/${issueNumber}|GH #${issueNumber}>`;
}

export function buildPrLink(owner: string, repo: string, prNumber: number): string {
  return `<https://github.com/${owner}/${repo}/pull/${prNumber}|PR #${prNumber}>`;
}

/** The links half of the trailer block: `<Jira link> | <issue link(s)> | <PR link>`, Jira omitted entirely when no key is declared. */
export function buildLinksLine(jiraKey: string | null, issueLinks: string[], prLink: string): string {
  const parts: string[] = [];
  if (jiraKey) parts.push(buildJiraLink(jiraKey));
  parts.push(...issueLinks, prLink);
  return parts.join(' | ');
}

/** One distinct commit author, keyed by email for lookup/dedup. */
export interface CommitAuthor {
  name: string;
  email: string;
}

/**
 * Case-insensitive-by-email dedup, preserving first-seen order and the
 * first-seen entry (display name, and any extra fields the caller's own
 * `T` carries, e.g. `ReleaseAuthor`'s `githubHandle`) for each email.
 * Generic over any `CommitAuthor`-shaped type so both `getPrCommitAuthors`
 * (`CommitAuthor[]`) and `scripts/lib/release-contributor-mentions.ts`'s
 * `aggregateReleaseAuthors` (`ReleaseAuthor[]`) share one implementation
 * instead of two near-identical copies.
 */
export function dedupeAuthors<T extends CommitAuthor>(authors: T[]): T[] {
  const seen = new Map<string, T>();
  for (const author of authors) {
    const key = author.email.toLowerCase();
    if (!seen.has(key)) seen.set(key, author);
  }
  return [...seen.values()];
}

/** `gh pr view --json commits`-shaped resolution of a merged PR's distinct commit authors, from a PR number alone. */
export function getPrCommitAuthors(gh: GhRunner, owner: string, repo: string, prNumber: number): CommitAuthor[] {
  const result = gh(['pr', 'view', String(prNumber), '--repo', `${owner}/${repo}`, '--json', 'commits']);
  if (result.status !== 0) throw new Error(`cannot read commits for PR #${prNumber}: ${redactDetail(result.output.trim())}`);
  let parsed: { commits: Array<{ authors?: Array<{ name: string; email: string }> }> };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error(`cannot parse commits for PR #${prNumber}: ${redactDetail(result.output.trim())}`);
  }
  const authors: CommitAuthor[] = [];
  for (const commit of parsed.commits ?? []) {
    for (const author of commit.authors ?? []) authors.push({ name: author.name, email: author.email });
  }
  return dedupeAuthors(authors);
}

/** Resolves a git-author email to a Slack user ID, or `null` when unresolvable. Injected so `resolveAuthorMentions` never depends directly on the Slack API shape. */
export type SlackUserLookup = (email: string) => Promise<string | null>;

/**
 * Slack's `users.lookupByEmail` Web API method (requires the bot token to
 * carry the `users:read.email` scope). Returns the resolved user ID on
 * success; returns `null` (never throws) on any failure — a missing scope, a
 * Slack API error response, or no matching workspace account all degrade
 * identically to "no mention for this author", per the graceful-degradation
 * requirement this resolution mechanism is built on.
 */
export async function lookupSlackUserByEmail(slackToken: string, email: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${slackToken}` },
    });
    const body = (await response.json()) as { ok?: boolean; user?: { id?: string } };
    if (!body.ok || !body.user?.id) return null;
    return body.user.id;
  } catch {
    return null;
  }
}

/**
 * Renders each author as `<@slackUserId>` on a successful lookup, or their
 * plain git-author display name (no `@`) on a failed/absent lookup. A git
 * author's display name is attacker-controllable (`git config user.name`),
 * so the fallback name is mrkdwn-escaped before interpolation — the same
 * threat class `escapeSlackMrkdwn()` already guards an issue title against.
 */
export async function resolveAuthorMentions(authors: CommitAuthor[], lookup: SlackUserLookup): Promise<string[]> {
  const mentions: string[] = [];
  for (const author of authors) {
    const slackUserId = await lookup(author.email);
    mentions.push(slackUserId ? `<@${slackUserId}>` : escapeSlackMrkdwn(author.name));
  }
  return mentions;
}

/** Returns `''` (no line at all) when `mentions` is empty — no author to credit is not the same as a dangling "Shipped by: " line with nothing after it. */
export function buildShippedByLine(mentions: string[]): string {
  return mentions.length > 0 ? `Shipped by: ${mentions.join(', ')}` : '';
}

/** Appends the links/mentions trailer to the verbatim press-release text, separated by a blank line. `shippedByLine` empty (no resolvable commit authors) omits that trailing line entirely rather than leaving a blank line. */
export function composeStructuredMessage(pressRelease: string, linksLine: string, shippedByLine: string): string {
  return shippedByLine ? `${pressRelease}\n\n${linksLine}\n${shippedByLine}` : `${pressRelease}\n\n${linksLine}`;
}

/** One row of the PR's own `## Demo` -> `### AC Coverage Report` table. */
export interface AcCoverageRow {
  ac: string;
  status: string;
  evidence: string;
}

const AC_COVERAGE_SECTION_PATTERN = /### AC Coverage Report\n([\s\S]*?)(?:\n###|\n##[^#]|$)/;

/**
 * Extracts every row of the PR's `### AC Coverage Report` table (per
 * `demoer-coverage-report-format.md`) — the same per-AC evidence the demoer
 * already produces. Returns `[]` when the table is absent (no `## Demo`
 * section at all, or a skip/degraded variant with no per-AC table).
 */
export function extractAcCoverageRows(prBody: string): AcCoverageRow[] {
  const sectionMatch = prBody.match(AC_COVERAGE_SECTION_PATTERN);
  if (!sectionMatch) return [];
  const rows: AcCoverageRow[] = [];
  for (const rawLine of sectionMatch[1].split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-{2,}/.test(line)) continue; // the `|---|---|---|` separator row
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const [ac, status] = cells;
    if (ac.toLowerCase() === 'ac') continue; // the header row
    rows.push({ ac, status, evidence: cells.slice(2).join('|').trim() });
  }
  return rows;
}

const SCREENSHOT_IMAGE_PATTERN = /!\[[^\]]*\]\((https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+)\)/g;

/** Extracts every `![...](https://github.com/user-attachments/assets/<uuid>)` embed URL from an AC row's Evidence cell — a flag-gated AC's row can carry more than one. */
export function extractScreenshotUrls(evidenceCell: string): string[] {
  return [...evidenceCell.matchAll(SCREENSHOT_IMAGE_PATTERN)].map((match) => match[1]);
}

function isGapRow(row: AcCoverageRow): boolean {
  return row.status.toLowerCase().includes('not covered');
}

async function postChatMessage(slackToken: string, channelId: string, text: string, fetchImpl: FetchLike, threadTs?: string): Promise<string> {
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const body = (await response.json()) as { ok?: boolean; ts?: string; error?: string };
  if (!body.ok || !body.ts) throw new Error(`chat.postMessage failed: ${body.error ?? 'unexpected response'}`);
  return body.ts;
}

/** Posts the composed announcement (§3.6) as a new top-level channel message, returning its `ts` — the anchor every threaded video/AC-reply below attaches under. */
export async function postAnchorMessage(slackToken: string, channelId: string, text: string, fetchImpl: FetchLike = fetch): Promise<string> {
  return postChatMessage(slackToken, channelId, text, fetchImpl);
}

/** Posts a plain-text threaded reply under `threadTs`, returning the reply's own `ts`. */
export async function postThreadReply(slackToken: string, channelId: string, threadTs: string, text: string, fetchImpl: FetchLike = fetch): Promise<string> {
  return postChatMessage(slackToken, channelId, text, fetchImpl, threadTs);
}

/**
 * Posts one thread reply for a single AC Coverage Report row, under the
 * anchor message's `ts`. A row with no screenshot evidence (a transcript-
 * backed AC, or a gap row) gets a plain-text reply naming its title and
 * status. A row with one or more screenshot embeds gets its evidence
 * re-uploaded as a native Slack file per screenshot (never posted as a
 * `github.com/user-attachments` link) — resolved through the same
 * `resolveSignedVideoUrl` UUID-substring correlation the video path uses.
 *
 * Never throws, and never drops the AC's reply entirely: a screenshot embed
 * `bodyHtml` cannot resolve, or whose download/re-upload itself throws
 * (a transient network error), degrades that ONE screenshot to a plain-text
 * "unavailable" note rather than aborting the row — every other screenshot
 * in the same row, and the row's own header line, still post. The header
 * (`text`) rides along on whichever message posts first for this row
 * (a resolved screenshot upload or an unavailable-note reply) and is
 * omitted from every message after that — so 2+ unresolvable/failed
 * screenshots on one row never repeat it.
 */
export async function postAcThreadReply(
  deps: { slackToken: string; channelId: string; fetchImpl?: FetchLike },
  anchorTs: string,
  row: AcCoverageRow,
  bodyHtml: string | null,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const statusLabel = isGapRow(row) ? ':warning: Not covered (gap)' : ':white_check_mark: Covered';
  // row.ac/row.evidence are raw, untrusted text lifted from the merged PR
  // body's AC Coverage Report table — the same threat class buildMessageText
  // and resolveAuthorMentions already guard an issue title/author name
  // against. extractScreenshotUrls() below still runs against the RAW
  // `row.evidence` (it needs the unescaped `![...](...)` markdown to match),
  // so escaping happens only here, at the point the reply's own `text` is
  // composed, never upstream on `row` itself.
  const screenshotUrls = bodyHtml ? extractScreenshotUrls(row.evidence) : [];
  const text = `*${escapeSlackMrkdwn(row.ac)}* — ${statusLabel}${isGapRow(row) ? `\n${escapeSlackMrkdwn(row.evidence)}` : ''}`;

  if (screenshotUrls.length === 0) {
    await postThreadReply(deps.slackToken, deps.channelId, anchorTs, text, fetchImpl);
    return;
  }

  let postedHeader = false;
  const withHeader = (note: string) => (postedHeader ? note : `${text}\n${note}`);
  for (const [index, embedUrl] of screenshotUrls.entries()) {
    const downloadUrl = bodyHtml ? resolveSignedVideoUrl(bodyHtml, embedUrl) : null;
    if (!downloadUrl) {
      await postThreadReply(deps.slackToken, deps.channelId, anchorTs, withHeader(`(screenshot ${index + 1} could not be resolved for re-upload)`), fetchImpl);
      postedHeader = true;
      continue;
    }
    try {
      const bytes = await downloadScreenshotBytes(downloadUrl, fetchImpl);
      await uploadVideoToSlack(deps.slackToken, deps.channelId, `ac-screenshot-${index + 1}.png`, bytes, postedHeader ? '' : text, fetchImpl, anchorTs);
      postedHeader = true;
    } catch (error) {
      console.error(`warning: screenshot ${index + 1} for '${row.ac}' failed to download/re-upload (other screenshots on this row are unaffected): ${errorDetail(error)}`);
      await postThreadReply(deps.slackToken, deps.channelId, anchorTs, withHeader(`(screenshot ${index + 1} unavailable — re-upload failed)`), fetchImpl);
      postedHeader = true;
    }
  }
}

/**
 * Records how far a journal-entry post attempt for an issue or a PR got
 * before it stopped — the anchor message's `ts` (once posted), which AC
 * Coverage Report rows already got their reply (matched by `row.ac`), and
 * whether the video already threaded. A later call for the same entry reads
 * this back and resumes past whatever it already recorded, instead of
 * re-running the whole sequence and duplicating every message it posts.
 */
export interface PostProgressState {
  anchorTs: string;
  postedAcLabels: string[];
  videoPosted: boolean;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a decoded progress-marker payload against the schema
 * `{ anchorTs: string, postedAcLabels: string[], videoPosted: boolean }`,
 * returning a freshly-constructed object on success or `null` on ANY schema
 * violation — a wrong type, a missing field, an empty/whitespace-only
 * `anchorTs`, a `postedAcLabels` entry that isn't a string, or a non-boolean
 * `videoPosted`. Modeled on `adlc/methods/hooks/lib/pr-ready-marker.ts`'s
 * `validateMarker()` pattern.
 */
export function validateProgressState(value: unknown): PostProgressState | null {
  if (!isPlainObject(value)) return null;
  const { anchorTs, postedAcLabels, videoPosted } = value;
  if (typeof anchorTs !== 'string' || anchorTs.trim() === '') return null;
  if (!Array.isArray(postedAcLabels) || !postedAcLabels.every((label) => typeof label === 'string')) return null;
  if (typeof videoPosted !== 'boolean') return null;
  return { anchorTs, postedAcLabels: [...(postedAcLabels as string[])], videoPosted };
}

/** Marks a comment as an entry's journal-post progress record, distinct from `SENTINEL_COMMENT` — the sentinel marks the WHOLE entry done; this marks how far an in-progress or incomplete one got. */
export const PROGRESS_COMMENT_MARKER = '<!-- ADLC:demo-slack-progress:';

/**
 * The payload between the marker and the trailing `-->` is base64, never raw
 * JSON — `progress.postedAcLabels` carries raw, untrusted `row.ac` text
 * lifted from the merged PR body's AC Coverage Report table, and
 * `JSON.stringify` does not escape `-`/`>`, so a hostile AC title containing
 * the literal substring `-->` could otherwise close this HTML comment early
 * when GitHub renders it. Standard base64's output alphabet
 * (`[A-Za-z0-9+/=]`) can never contain `<`, `>`, or `-`, so no input content
 * can ever produce a `-->` sequence in the encoded output, regardless of
 * what `row.ac`/`row.evidence` contain. The marker prefix and the
 * startsWith-based detection in `decodeProgressComment` below are unchanged
 * — only the payload's own encoding changes.
 */
function encodeProgressComment(progress: PostProgressState): string {
  return `${PROGRESS_COMMENT_MARKER}${Buffer.from(JSON.stringify(progress)).toString('base64')} -->`;
}

function decodeProgressComment(body: string): unknown {
  if (!body.startsWith(PROGRESS_COMMENT_MARKER)) return null;
  const closeIndex = body.lastIndexOf('-->');
  if (closeIndex === -1) return null;
  try {
    const encoded = body.slice(PROGRESS_COMMENT_MARKER.length, closeIndex).trim();
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads back the most recent progress record for this issue, or `null` when
 * no earlier attempt left one (a fresh post, one that already fully
 * completed and had its progress record superseded by the sentinel, or no
 * comment shaped like a marker was posted by the authenticated identity
 * itself). Only a comment with `viewerDidAuthor === true` is even considered
 * — `writePostProgress` below only ever writes this issue's OWN progress
 * comment via `--edit-last`, which can only ever edit a comment the
 * authenticated identity itself posted, so a candidate any other commenter
 * posted is never this attempt's own record, no matter how it's shaped.
 * A decoded candidate that doesn't pass `validateProgressState` is likewise
 * skipped rather than trusted.
 */
function getPostProgress(gh: GhRunner, owner: string, repo: string, issueNumber: number): PostProgressState | null {
  const comments = readIssueComments(gh, owner, repo, issueNumber);
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].viewerDidAuthor !== true) continue;
    const validated = validateProgressState(decodeProgressComment(comments[i].body));
    if (validated) return validated;
  }
  return null;
}

/**
 * Writes the progress record: a fresh `gh issue comment` the first time this
 * attempt (or an earlier one) has anything to record, `--edit-last` on every
 * write after that — one bookkeeping comment per issue tracks the whole
 * sequence, never one per step.
 */
function writePostProgress(gh: GhRunner, owner: string, repo: string, issueNumber: number, progress: PostProgressState, editInPlace: boolean): void {
  const args = ['issue', 'comment', String(issueNumber), '--repo', `${owner}/${repo}`, ...(editInPlace ? ['--edit-last'] : []), '--body', encodeProgressComment(progress)];
  const result = gh(args);
  if (result.status !== 0) throw new Error(`cannot record journal-entry progress for issue #${issueNumber}: ${redactDetail(result.output.trim())}`);
}

/** One comment on a PR, as `gh pr view --json comments` returns it — the same `{body, viewerDidAuthor}` shape `readIssueComments()`'s issue-comment equivalent relies on. */
function readPrComments(gh: GhRunner, owner: string, repo: string, prNumber: number): IssueComment[] {
  const result = gh(['pr', 'view', String(prNumber), '--repo', `${owner}/${repo}`, '--json', 'comments']);
  if (result.status !== 0) throw new Error(`cannot read comments for PR #${prNumber}: ${redactDetail(result.output.trim())}`);
  let parsed: { comments: IssueComment[] };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error(`cannot parse comments for PR #${prNumber}: ${redactDetail(result.output.trim())}`);
  }
  return parsed.comments;
}

/**
 * Checked before doing any of the rest of the check-then-post sequence — the
 * PR-comment-backed twin of `hasSentinelComment` (§2.3), for the zero-issue
 * journal entry. Same literal `SENTINEL_COMMENT` marker text; no collision
 * risk, since this lives in the PR's own comment thread, never an issue's.
 */
export function hasPrSentinelComment(gh: GhRunner, owner: string, repo: string, prNumber: number): boolean {
  return readPrComments(gh, owner, repo, prNumber).some((c) => c.body.includes(SENTINEL_COMMENT));
}

/** Posted only once the Slack post succeeds — append-only, no body-mutation race. The PR-comment-backed twin of `postSentinelComment`. */
export function postPrSentinelComment(gh: GhRunner, owner: string, repo: string, prNumber: number): void {
  const result = gh(['pr', 'comment', String(prNumber), '--repo', `${owner}/${repo}`, '--body', SENTINEL_COMMENT]);
  if (result.status !== 0) throw new Error(`cannot post sentinel comment on PR #${prNumber}: ${redactDetail(result.output.trim())}`);
}

/** The PR-comment-backed twin of `getPostProgress` — the same viewerDidAuthor-scan/`validateProgressState` logic, over `readPrComments()`'s result instead of `readIssueComments()`'s. */
function getPrPostProgress(gh: GhRunner, owner: string, repo: string, prNumber: number): PostProgressState | null {
  const comments = readPrComments(gh, owner, repo, prNumber);
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].viewerDidAuthor !== true) continue;
    const validated = validateProgressState(decodeProgressComment(comments[i].body));
    if (validated) return validated;
  }
  return null;
}

/** The PR-comment-backed twin of `writePostProgress`. */
function writePrPostProgress(gh: GhRunner, owner: string, repo: string, prNumber: number, progress: PostProgressState, editInPlace: boolean): void {
  const args = ['pr', 'comment', String(prNumber), '--repo', `${owner}/${repo}`, ...(editInPlace ? ['--edit-last'] : []), '--body', encodeProgressComment(progress)];
  const result = gh(args);
  if (result.status !== 0) throw new Error(`cannot record journal-entry progress for PR #${prNumber}: ${redactDetail(result.output.trim())}`);
}

export type PostJournalEntryOutcome =
  | 'posted'
  | 'already-posted'
  | 'no-channel-configured'
  | 'video-resolution-failed'
  | 'ac-reply-failed';

/**
 * The persistence triple (sentinel check / sentinel post / progress
 * read+write) a journal-entry post checks and updates against — an issue's
 * own comments for `postJournalEntryForIssue`, or an issue-completing PR's
 * own comments for `postJournalEntryForPr` (§2.3). `runJournalEntry` below
 * is identical either way; only where the check-then-post state lives
 * differs.
 */
interface JournalEntryStore {
  hasSentinel(): boolean;
  postSentinel(): void;
  getProgress(): PostProgressState | null;
  writeProgress(progress: PostProgressState, editInPlace: boolean): void;
}

/**
 * The full journal-entry post sequence (§3.3-§3.7): composed body text (a
 * real Press Release, or the pinned §2.1 fallback), the links/mention
 * trailer, an anchor message, threaded video (if present), and one threaded
 * reply per AC Coverage Report row (gap rows included). Shared byte-for-byte
 * by `postJournalEntryForIssue` and `postJournalEntryForPr` — `subjectLabel`
 * (`Issue #N` or `PR #N`) names the entry in every log line, `filenameSlug`
 * names the threaded video's upload filename, `store` supplies the
 * sentinel/progress persistence (§2.3), and `resolveEntryJiraKey` is a thunk
 * — not a plain value — so the issue-body `gh` read it wraps for
 * `postJournalEntryForIssue` only ever runs on the no-prior-progress path.
 *
 * Idempotent across retries of the SAME entry, not just within one call: a
 * `PostProgressState` comment (see `PROGRESS_COMMENT_MARKER` above) records
 * the anchor `ts` once posted, and each AC row's label once its reply posts.
 * A call that starts with an existing progress record resumes from it —
 * reusing the recorded anchor ts instead of posting a new top-level message,
 * and skipping every AC row already recorded — rather than re-running the
 * sequence from scratch. This is the same problem `postDemoVideoForIssue`'s
 * sentinel-withholding solves for the plain video-or-nothing path (never
 * mark an incomplete post done), extended with a resumable checkpoint
 * because this sequence has multiple independent steps a mid-run stop can
 * land between, not just one.
 */
async function runJournalEntry(
  deps: SlackPostDeps,
  owner: string,
  repo: string,
  store: JournalEntryStore,
  subjectLabel: string,
  filenameSlug: string,
  resolvedPr: { number: number; title: string; body: string; bodyHtml?: string },
  authors: CommitAuthor[],
  resolveEntryJiraKey: () => string | null,
  issueLinks: string[],
): Promise<PostJournalEntryOutcome> {
  if (store.hasSentinel()) {
    console.log(`${subjectLabel}: demo-slack-posted sentinel already present; skipping (the other writer already posted it).`);
    return 'already-posted';
  }

  if (!checkSlackChannelConfigured(deps, subjectLabel, 'post a journal entry to Slack')) return 'no-channel-configured';

  const priorProgress = store.getProgress();
  let progress: PostProgressState = priorProgress ?? { anchorTs: '', postedAcLabels: [], videoPosted: false };
  let progressCommentExists = priorProgress !== null;
  const recordProgress = (update: Partial<PostProgressState>): void => {
    progress = { ...progress, ...update };
    store.writeProgress(progress, progressCommentExists);
    progressCommentExists = true;
  };

  let anchorTs: string;
  if (priorProgress) {
    anchorTs = priorProgress.anchorTs;
    console.log(`${subjectLabel}: resuming an earlier journal-entry attempt under anchor ts ${anchorTs} (${priorProgress.postedAcLabels.length} AC repl${priorProgress.postedAcLabels.length === 1 ? 'y' : 'ies'} already posted).`);
  } else {
    const jiraKey = resolveEntryJiraKey();
    const prLink = buildPrLink(owner, repo, resolvedPr.number);
    const linksLine = buildLinksLine(jiraKey, issueLinks, prLink);
    const mentions = await resolveAuthorMentions(authors, (email) => lookupSlackUserByEmail(deps.slackToken!, email, deps.fetchImpl));
    const shippedByLine = buildShippedByLine(mentions);
    const bodyText = resolveBodyText(resolvedPr.number, resolvedPr.title, resolvedPr.body);
    const messageText = composeStructuredMessage(bodyText, linksLine, shippedByLine);

    anchorTs = await postAnchorMessage(deps.slackToken, deps.channelId, messageText, deps.fetchImpl);
    recordProgress({ anchorTs });
  }

  // Per #836's precedent (postDemoVideoForIssue): the sentinel is only ever
  // posted on a real, verified success. A video line present but never
  // actually threaded (missing body_html, unresolvable embed URL, or a
  // download/upload throw) withholds the sentinel below so a retry can
  // still complete the video attachment — the anchor message and AC replies
  // already posted are unaffected either way.
  let videoResolutionFailed = false;
  const videoUrl = extractVideoUrl(resolvedPr.body);
  if (videoUrl && !progress.videoPosted) {
    if (!resolvedPr.bodyHtml) {
      console.error(`warning: ${subjectLabel}: merged PR #${resolvedPr.number} carries a video line but its rendered body_html was not available; skipping video threading (anchor message and AC replies are unaffected).`);
      videoResolutionFailed = true;
    } else {
      const downloadUrl = resolveSignedVideoUrl(resolvedPr.bodyHtml, videoUrl);
      if (!downloadUrl) {
        console.error(`warning: ${subjectLabel}: could not resolve merged PR #${resolvedPr.number}'s video embed URL to a real signed download URL; skipping video threading.`);
        videoResolutionFailed = true;
      } else {
        try {
          const bytes = await downloadVideoBytes(downloadUrl, deps.fetchImpl);
          await uploadVideoToSlack(deps.slackToken, deps.channelId, `demo-${filenameSlug}.mp4`, bytes, '', deps.fetchImpl, anchorTs);
          recordProgress({ videoPosted: true });
        } catch (error) {
          console.error(`warning: ${subjectLabel}: video threading failed (anchor message and AC replies are unaffected): ${errorDetail(error)}`);
          videoResolutionFailed = true;
        }
      }
    }
  }

  // Mirrors `videoResolutionFailed` above: a row whose reply throws (a
  // genuine Slack-API-level failure, not the already-handled degraded-
  // screenshot case inside `postAcThreadReply` itself) must withhold the
  // sentinel below, exactly like an unresolved video does — otherwise the
  // sentinel marks the entry permanently done while a real AC reply never
  // reached Slack, with no way for a retry to ever post it (the resumability
  // this same progress-tracking mechanism exists to provide).
  let acReplyFailed = false;
  const acRows = extractAcCoverageRows(resolvedPr.body);
  for (const row of acRows) {
    if (progress.postedAcLabels.includes(row.ac)) {
      console.log(`${subjectLabel}: AC reply for '${row.ac}' already posted by an earlier attempt; skipping.`);
      continue;
    }
    try {
      await postAcThreadReply({ slackToken: deps.slackToken, channelId: deps.channelId, fetchImpl: deps.fetchImpl }, anchorTs, row, resolvedPr.bodyHtml ?? null);
      recordProgress({ postedAcLabels: [...progress.postedAcLabels, row.ac] });
    } catch (error) {
      console.error(`warning: ${subjectLabel}: AC thread reply failed for '${row.ac}' (other AC replies are unaffected): ${errorDetail(error)}`);
      acReplyFailed = true;
    }
  }

  if (videoResolutionFailed) {
    console.log(`${subjectLabel}: journal entry posted to Slack channel ${deps.channelId} (${acRows.length} AC thread replies) but video threading failed; sentinel comment withheld so a retry can complete the video attachment.`);
    return 'video-resolution-failed';
  }

  // A distinct outcome value rather than reusing 'video-resolution-failed':
  // the two failure modes are unrelated (an AC reply's own post throwing vs.
  // the video's download/upload/resolution path), and this file's outcome
  // union already gives every distinct "why the sentinel was withheld"
  // reason its own value instead of collapsing them — a caller logging the
  // outcome (board-status-sync.ts's merge-mode loop) gets an accurate
  // diagnostic naming which part of the entry is still incomplete.
  if (acReplyFailed) {
    console.log(`${subjectLabel}: journal entry posted to Slack channel ${deps.channelId} but at least one AC thread reply failed; sentinel comment withheld so a retry can complete the missing reply/replies.`);
    return 'ac-reply-failed';
  }

  store.postSentinel();
  console.log(`${subjectLabel}: journal entry posted to Slack channel ${deps.channelId} (${acRows.length} AC thread replies); sentinel comment posted.`);
  return 'posted';
}

/**
 * The journal-entry post for one issue a merged PR completes (§3.5) — #1020's
 * `postStructuredUpdateForIssue`, extended to always resolve body text
 * (§3.3's fallback replaces the old press-release-or-skip gate) and to
 * resolve its Jira key through §3.4's issue-body-then-PR-body precedence.
 * `allIssueNumbers` is the full set of issue numbers the merged PR completes
 * — every one of them gets its own GitHub issue link in the trailer,
 * independent of which single `issueNumber` this particular call posts and
 * sentinel-checks (the per-issue loop shape is unchanged; only the trailer's
 * link list reflects the whole batch).
 */
export async function postJournalEntryForIssue(
  deps: SlackPostDeps,
  owner: string,
  repo: string,
  issueNumber: number,
  allIssueNumbers: number[],
  resolvedPr: { number: number; title: string; body: string; bodyHtml?: string },
  authors: CommitAuthor[],
): Promise<PostJournalEntryOutcome> {
  const store: JournalEntryStore = {
    hasSentinel: () => hasSentinelComment(deps.gh, owner, repo, issueNumber),
    postSentinel: () => postSentinelComment(deps.gh, owner, repo, issueNumber),
    getProgress: () => getPostProgress(deps.gh, owner, repo, issueNumber),
    writeProgress: (progress, editInPlace) => writePostProgress(deps.gh, owner, repo, issueNumber, progress, editInPlace),
  };
  const issueLinks = allIssueNumbers.map((n) => buildIssueLink(owner, repo, n));
  return runJournalEntry(
    deps,
    owner,
    repo,
    store,
    `Issue #${issueNumber}`,
    `issue-${issueNumber}`,
    resolvedPr,
    authors,
    () => resolveJiraKey(getIssueBody(deps.gh, owner, repo, issueNumber), resolvedPr.body),
    issueLinks,
  );
}

/**
 * The journal-entry post for a merged PR that completes zero issues (§3.5,
 * new for this ticket) — structurally identical to `postJournalEntryForIssue`
 * except its sentinel/progress state lives on the PR itself (§2.3, via
 * `hasPrSentinelComment`/`postPrSentinelComment`/`getPrPostProgress`/
 * `writePrPostProgress`), it has no issue body to read (`resolveJiraKey`'s
 * only source is the PR body's own `Epic:` line), and it carries no issue
 * links in its trailer.
 */
export async function postJournalEntryForPr(
  deps: SlackPostDeps,
  owner: string,
  repo: string,
  resolvedPr: { number: number; title: string; body: string; bodyHtml?: string },
  authors: CommitAuthor[],
): Promise<PostJournalEntryOutcome> {
  const store: JournalEntryStore = {
    hasSentinel: () => hasPrSentinelComment(deps.gh, owner, repo, resolvedPr.number),
    postSentinel: () => postPrSentinelComment(deps.gh, owner, repo, resolvedPr.number),
    getProgress: () => getPrPostProgress(deps.gh, owner, repo, resolvedPr.number),
    writeProgress: (progress, editInPlace) => writePrPostProgress(deps.gh, owner, repo, resolvedPr.number, progress, editInPlace),
  };
  return runJournalEntry(
    deps,
    owner,
    repo,
    store,
    `PR #${resolvedPr.number}`,
    `pr-${resolvedPr.number}`,
    resolvedPr,
    authors,
    () => resolveJiraKey(null, resolvedPr.body),
    [],
  );
}

export interface SlackRoutingConfig {
  channelId: string | null;
}

/**
 * Regex-based extraction of the new top-level `slack:` block's `channel_id`
 * — same posture as `board-status-sync.ts`'s own `parseRoutingConfig`:
 * `docs/github-routing.yml` is a small, hand-authored, flat-enough file that
 * a full YAML dependency isn't justified for.
 */
export function parseSlackRoutingConfig(text: string): SlackRoutingConfig {
  const channelIdMatch = text.match(/^\s*channel_id:\s*(\S+)/m);
  return { channelId: channelIdMatch ? channelIdMatch[1] : null };
}
