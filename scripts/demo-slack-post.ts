#!/usr/bin/env -S node --experimental-strip-types
// scripts/demo-slack-post.ts — standalone CLI entry point for posting a
// merged ticket's demo video to a public Slack channel, exactly once, when
// the ticket reaches its terminal `Post Deploy`/`Closed` board Status.
//
// Usage: scripts/demo-slack-post.ts <owner> <repo> <issueNumber> [--pr <N>]
//
// Two call sites converge on the same underlying check-then-post sequence
// (`postDemoVideoForIssue` in scripts/lib/demo-slack-post.ts):
//
//   - `.github/scripts/board-status-sync.ts`'s deploy-mode loop imports that
//     function directly and calls it in-process, reusing the deploy-mode
//     run's own already-resolved `covered` merged-PR list — no new gh/GraphQL
//     call for PR resolution.
//   - The orchestrator's session-polled Deploy Signal checkpoint
//     (orchestrator-github-issues-status-updates.md § Checkpoint: Deploy
//     Signal) invokes THIS file as a subprocess after performing the
//     terminal Ready to Deploy -> Post Deploy/Closed write, since a live
//     session has no `covered`/deploySha in scope. `--pr <N>` skips PR
//     resolution entirely when the session already knows the PR number.
//
// Env vars:
//   ADLC_DEMO_AGENT_SLACK_TOKEN — required; the Slack bot token
//   GH_TOKEN / GITHUB_TOKEN — required; used for every `gh` call below
//   ADLC_DEMO_SLACK_GH      — overridable `gh` executable path (default 'gh')
//   ADLC_DEMO_SLACK_ROUTING — overridable path to the github-routing.yml-shaped
//                             config file (default 'docs/github-routing.yml'),
//                             read for `slack.channel_id`

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCaptured } from './lib/toolchain.ts';
import {
  postDemoVideoForIssue,
  resolveMergedPrForIssue,
  parseSlackRoutingConfig,
  hasSentinelComment,
  extractVideoUrl,
  fetchPrBodyHtml,
  type GhResult,
} from './lib/demo-slack-post.ts';
import { prIssueNumbers, listRecentMergedPrs } from '../.github/scripts/board-status-sync.ts';

const ADLC_DEMO_SLACK_GH = process.env.ADLC_DEMO_SLACK_GH || 'gh';
const ROUTING_PATH = process.env.ADLC_DEMO_SLACK_ROUTING || 'docs/github-routing.yml';

class DieError extends Error {}
function die(message: string): never {
  throw new DieError(message);
}

function adlcGh(args: string[]): GhResult {
  return runCaptured(ADLC_DEMO_SLACK_GH, args);
}

interface PrView {
  number: number;
  title: string;
  headRefName: string;
  body: string;
  /** The PR's rendered body HTML, attached by `demoSlackPostForIssue` below only when a video URL was actually found in `body` — needed to resolve that raw, browser-only embed URL to its real, fetchable signed CDN URL before download (issue #836's fix). */
  bodyHtml?: string;
}

/**
 * Resolves the merged PR completing `issueNumber` for the standalone case,
 * which (unlike `board-status-sync.ts`'s deploy-mode loop) has no `covered`
 * list in scope: `--pr <N>` skips resolution entirely (`gh pr view`);
 * otherwise `listRecentMergedPrs()` + `prIssueNumbers()` — the SAME functions
 * `board-status-sync.ts`'s deploy mode already uses, minus the
 * deployment-containment filter, which doesn't apply outside a specific
 * deployment event.
 */
function resolvePr(owner: string, repo: string, issueNumber: number, prNumber?: number): PrView | null {
  if (prNumber !== undefined) {
    const result = adlcGh(['pr', 'view', String(prNumber), '--repo', `${owner}/${repo}`, '--json', 'number,title,headRefName,body']);
    if (result.status !== 0) die(`cannot view PR #${prNumber}: ${result.output.trim()}`);
    let parsed: Omit<PrView, 'body'> & { body: string | null };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      die(`cannot parse PR #${prNumber} view output: ${result.output.trim()}`);
    }
    // `gh pr view --json body` returns `null` for an empty PR body, same as
    // `listRecentMergedPrs()`'s own `pr.body ?? ''` guard below coerces —
    // ungated, this null reaches extractVideoUrl()'s unguarded `.split('\n')`
    // and throws.
    return { ...parsed, body: parsed.body ?? '' };
  }
  const prs = listRecentMergedPrs(owner, repo);
  return resolveMergedPrForIssue(prs, issueNumber, prIssueNumbers);
}

/** Exported so a future in-repo caller (besides the CLI below) can invoke the standalone-resolution path without shelling out to this file as a subprocess. */
export async function demoSlackPostForIssue(owner: string, repo: string, issueNumber: number, opts: { prNumber?: number } = {}): Promise<void> {
  // Checked before resolvePr()'s own gh call: in the already-posted case (the
  // other writer got there first) this short-circuits without spending a
  // second gh round-trip just to resolve a PR whose result won't be used.
  if (hasSentinelComment(adlcGh, owner, repo, issueNumber)) {
    console.log(`Issue #${issueNumber}: demo-slack-posted sentinel already present; skipping (the other writer already posted it).`);
    return;
  }
  const routing = parseSlackRoutingConfig(readFileSync(ROUTING_PATH, 'utf8'));
  const resolvedPr = resolvePr(owner, repo, issueNumber, opts.prNumber);
  // Fetch the PR's rendered body_html so postDemoVideoForIssue can resolve
  // the raw embed URL to its real, fetchable signed URL (issue #836's fix) --
  // only attempted when a video URL is actually present (no point fetching
  // otherwise), and never allowed to block this run: a failure here just
  // means the resolution step is skipped, leaving postDemoVideoForIssue's own
  // (unchanged) credential checks and outcomes to fire exactly as before.
  if (resolvedPr && extractVideoUrl(resolvedPr.body)) {
    try {
      resolvedPr.bodyHtml = fetchPrBodyHtml(adlcGh, owner, repo, resolvedPr.number);
    } catch (error) {
      console.error(`warning: issue #${issueNumber}: could not fetch PR #${resolvedPr.number}'s rendered body_html for video-URL resolution: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const outcome = await postDemoVideoForIssue(
    {
      gh: adlcGh,
      slackToken: process.env.ADLC_DEMO_AGENT_SLACK_TOKEN,
      channelId: routing.channelId,
    },
    owner,
    repo,
    issueNumber,
    resolvedPr,
  );
  // Unlike board-status-sync.ts's deploy-mode loop (where this hook is a
  // side effect that must never block the more important Status-transition
  // it's attached to, so every failure here — including this outcome — is
  // swallowed as a non-fatal warning), posting the demo video IS this CLI's
  // entire job. A `video-resolution-failed` outcome already logged its own
  // `warning:` line (in postDemoVideoForIssue), but silently exiting 0 would
  // read as success to whoever invoked this CLI (e.g. the orchestrator's
  // session-polled checkpoint) when no video was actually posted — so this
  // is the one outcome the CLI itself still turns into a hard, non-zero-exit
  // failure. Every other outcome (already-posted, no-merged-pr, no-video,
  // no-channel-configured) is a legitimate skip, not a failure, and exits 0.
  if (outcome === 'video-resolution-failed') {
    die(`issue #${issueNumber}: could not resolve a safe download URL for the demo video; see the warning above for details`);
  }
}

function parseCli(argv: string[]): { owner: string; repo: string; issueNumber: number; prNumber?: number } {
  const [owner, repo, issueNumberArg, ...rest] = argv;
  if (!owner || !repo || !issueNumberArg) {
    die(`usage: scripts/demo-slack-post.ts <owner> <repo> <issueNumber> [--pr <N>]`);
  }
  const issueNumber = parseInt(issueNumberArg, 10);
  if (Number.isNaN(issueNumber)) die(`issueNumber must be numeric, got '${issueNumberArg}'`);

  let prNumber: number | undefined;
  const prFlagIdx = rest.indexOf('--pr');
  if (prFlagIdx !== -1) {
    const value = rest[prFlagIdx + 1];
    prNumber = value !== undefined ? parseInt(value, 10) : NaN;
    if (Number.isNaN(prNumber)) die('--pr requires a numeric PR number');
  }

  return { owner, repo, issueNumber, prNumber };
}

async function main(): Promise<void> {
  const { owner, repo, issueNumber, prNumber } = parseCli(process.argv.slice(2));
  await demoSlackPostForIssue(owner, repo, issueNumber, { prNumber });
}

// process.argv[1] can be a relative path, while fileURLToPath(import.meta.url)
// is always absolute — resolve both sides before comparing (same pattern as
// board-status-sync.ts's own isMainModule()) so test code can import
// demoSlackPostForIssue without triggering main() as a side effect.
function isMainModule(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => {
    if (error instanceof DieError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
