#!/usr/bin/env -S node --experimental-strip-types
// board-status-sync.ts — event-driven board-Status executor
// ("Close the ticket at merge when the PR completes it: reinstate closing
// keywords + event-driven merge/deploy handling").
//
// This is the extracted, directly-testable core of the "board-status-sync"
// GitHub Action (.github/workflows/board-status-sync.yml — a thin
// trigger/wiring layer around this script, per docs/specs/235-....md §12/§15
// and the precedent set by create-deployment-signal.ts/.test.ts).
//
// Two event modes, matching the workflow's two triggers:
//
//   board-status-sync.ts merge
//     Fired by `pull_request: closed` (filtered by the workflow to
//     `merged == true`). Scopes to every issue number the merged PR completes
//     — `prIssueNumbers()`'s union of the title/branch convention and the
//     merged PR's **body** `<!-- ADLC:closing-keywords:start/end -->` footer
//     block (pure intent data; GitHub's own auto-close is fully disabled
//     repo-wide, so this Action is the sole closer). EVERY scoped ticket
//     takes the same `Code Review`/`Manual QA` -> `Ready to Deploy` Status
//     Transition Matrix edge, footer-named or not: `Ready to Deploy` means
//     "merged, not yet live", which is equally true of a fully-complete
//     ticket, so the board's `Closed` column still waits for the deploy
//     signal below. Close intent is narrower than scope and comes from the
//     footer alone: for each ticket with a `Closes #N` line inside the
//     footer, this mode additionally calls `gh issue close N --reason
//     completed` at merge, closing the GitHub issue's own `state`
//     immediately. Scoped tickets the footer does *not* list (partial-scope)
//     get the Status edge only, no close call, awaiting the deploy-time path
//     below.
//
//     Independent of that transition loop, this mode unconditionally invokes
//     the Slack journal-entry hook (`postDemoVideoForMergedPr()`,
//     scripts/lib/demo-slack-post.ts) — one entry per issue number the merged
//     PR completes, or a single PR-level entry when it completes none — using
//     the PR the merge event itself already carries. No deploy signal or
//     terminal board Status is required for the post to fire.
//
//   board-status-sync.ts deploy
//     Fired by `deployment_status` (filtered by the workflow to
//     `state == success`). Finds every recently-merged PR whose merge
//     commit is now an ancestor of (or equal to) the deployment SHA, and for
//     every issue each such PR completes (`prIssueNumbers()`, the same
//     title/branch-or-footer union merge mode scopes with) performs the
//     terminal `Ready to Deploy` -> `Post Deploy` (requires_post_deploy: true
//     projects) or -> `Closed` (otherwise) transition. The `Closed` case is
//     the terminal two-write close: Status write + `gh issue close`, the
//     latter skipped when the ticket already closed at merge (checked via
//     `gh issue view --json state` first) — idempotent against this
//     Action's own prior merge-time write, not against a second closer,
//     since none exists.
//
// Version 3 (docs/specs/235-...md changelog): the operator manually disabled
// GitHub's own "Automatically close issues linked to pull requests" setting
// repo-wide on Invoca/ADLC, after discovering it was auto-closing issues
// purely from the `gh issue develop` linked-branch relationship with zero
// closing keyword present. Consequence: this script is now the **only**
// thing that ever calls `gh issue close`, at either merge or deploy time —
// the PR-body footer records intent only and is never itself a GitHub-native
// closing mechanism. The Version 2 "check before closing to avoid
// double-closing the keyword's own GitHub-native close" ownership split is
// removed (§9a.5) — there is no second closer left to race against.
//
// Idempotency (§9a.4): every write is read-current-Status-before-write,
// no-op-if-already-at-target. This makes a double-fire from this Action and
// a live orchestrator session polling the same signal safe by construction
// — both always compute the same target Status for a given signal. The
// Status write and the `gh issue close` are two separate, non-atomic calls,
// so they are each idempotent *independently*: any of the three close
// triggers (a merge event whose footer names the ticket, a `Closed` target,
// or a Status already reading `Closed` from a prior, possibly interrupted,
// run) always re-checks the issue's actual OPEN/CLOSED state and closes it
// only if still OPEN, regardless of whether the Status write itself had
// anything left to do this time — see transitionIssue().
//
// Per-ticket error isolation: main()'s batch loops (one footer-named ticket
// per merge, one covered ticket per deploy) wrap each ticket's transition in
// its own try/catch, so one ticket's transient `gh` failure is logged and
// does not abort its unprocessed siblings in the same batch. The run still
// exits non-zero (via a summary `die()` after the loop) when any ticket
// failed, so the workflow surfaces the failure even though it made partial
// progress.
//
// Test hooks (see test/board-status-sync.test.ts):
//   ADLC_BOARD_SYNC_GH     — overridable `gh` executable path (default 'gh')
//   ADLC_BOARD_SYNC_GIT    — overridable `git` executable path (default 'git')
//   ADLC_BOARD_SYNC_ROUTING — overridable path to the github-routing.yml-shaped
//                             config file (default 'docs/github-routing.yml')
//   ADLC_BOARD_SYNC_MAX_BUFFER — overridable execFileSync maxBuffer, in bytes
//                             (default 64 MiB; #362 — lets tests exercise the
//                             ENOBUFS path with a small configured cap)
//
// Historical mode (#258 Part 3): the one-time board Status hygiene
// correction over items already on a board (as opposed to Part 1's newly
// backfilled items) runs as a SEPARATE driver script,
// `board-status-backfill.ts`, rather than a third CLI mode here — it needs
// to sweep 28/29 repos' worth of historical merged-PR/deployment data in one
// run, a batch shape this file's single-repo, single-event `main()` was not
// built for. Per docs/specs/258-...md §3.2, that driver reuses this file's
// exported pure decision functions (`mergeSignalTarget`, `deploySignalTarget`,
// `shouldWriteStatus`, `shouldCloseIssue`) and this file's exported I/O
// (`transitionIssue`, `findProjectItem`, `getStatusField`, `writeStatus`,
// `getIssueStateAndBody`, `closeIssue`, `listRecentMergedPrs`, `isAncestor`)
// rather than re-deriving any of that logic — it is a historical-mode entry
// point INTO this file's code, not a parallel implementation of it.
//
// Known limitation, flagged rather than silently skipped: the per-close Jira
// epic annotation (epic-bridge.md § Annotate) that the session-polled Deploy
// Signal checkpoint posts is a Jira/Atlassian write. This Action carries only
// a short-lived token minted from the `invoca-adlc` GitHub App installation
// (`ADLC_APP_ID` / `ADLC_APP_PRIVATE_KEY` — a GitHub credential) — no
// Atlassian credential is provisioned for it in this ticket (docs/specs/235-
// ...md §9a.3 scopes only the GitHub-side token). When a closed ticket
// declares a Jira epic, this script logs that fact and skips the annotation
// rather than fabricating a call it cannot make; the orchestrator's own
// Board Hygiene sweep still posts it idempotently (epic-bridge.md's own
// idempotency check means a later session posting it is always safe).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCaptured, errorDetail } from '../../scripts/lib/toolchain.ts';
import {
  postJournalEntryForIssue,
  postJournalEntryForPr,
  parseSlackRoutingConfig,
  extractVideoUrl,
  extractAcCoverageRows,
  extractScreenshotUrls,
  getPrCommitAuthors,
  fetchPrBodyHtml,
  type GhRunner,
  type FetchLike,
  type SlackRoutingConfig,
  type CommitAuthor,
} from '../../scripts/lib/demo-slack-post.ts';

const ADLC_BOARD_SYNC_GH = process.env.ADLC_BOARD_SYNC_GH || 'gh';
const ADLC_BOARD_SYNC_GIT = process.env.ADLC_BOARD_SYNC_GIT || 'git';
const ROUTING_PATH = process.env.ADLC_BOARD_SYNC_ROUTING || 'docs/github-routing.yml';

/**
 * `execFileSync`'s own default `maxBuffer` (1 MiB) is per-stream (stdout OR
 * stderr alone), not a combined cap — and once either stream exceeds it,
 * Node kills the child (`err.code === 'ENOBUFS'`, `err.status === null`,
 * `err.signal === 'SIGTERM'`) rather than truncating gracefully. This is not
 * hypothetical: `listRecentMergedPrs()`'s own `gh pr list ... --json
 * number,title,headRefName,mergeCommit,body` call already hit this for real
 * against Invoca/web, where full PR bodies pushed a single response to 1.32
 * MiB. 64 MiB matches this repo's own existing `GH_MAX_BUFFER` precedent
 * (scripts/adlc-adoption-audit.ts) — comfortably above any realistic single
 * `gh`/`git` call this file makes.
 */
const EXEC_MAX_BUFFER = process.env.ADLC_BOARD_SYNC_MAX_BUFFER !== undefined ? parseInt(process.env.ADLC_BOARD_SYNC_MAX_BUFFER, 10) : 64 * 1024 * 1024;

class DieError extends Error {}
function die(message: string): never {
  throw new DieError(message);
}

interface ShResult {
  /** stdout+stderr concatenated — the existing diagnostic shape every `die()` call below already formats with. */
  output: string;
  /**
   * stdout ALONE (#264). `gh api graphql` can exit non-zero while still
   * emitting a parseable JSON body on stdout (GraphQL errors, e.g. `issue`
   * resolving to `null` with a `NOT_FOUND` error) — callers that need to
   * distinguish *which* GraphQL failure occurred (vs. a `gh`
   * network/auth/exec failure that never produced JSON at all) must parse
   * `stdout` alone; parsing `output` would corrupt the JSON with stderr text
   * appended.
   */
  stdout: string;
  status: number;
}

/** Captures combined output and exit status without throwing, via `toolchain.ts`'s shared maxBuffer/ENOBUFS-diagnosis primitive (mirrors create-deployment-signal.ts's adlcGh wrapper). */
function adlcGh(args: string[]): ShResult {
  return runCaptured(ADLC_BOARD_SYNC_GH, args, { maxBuffer: EXEC_MAX_BUFFER });
}

function adlcGit(args: string[]): ShResult {
  return runCaptured(ADLC_BOARD_SYNC_GIT, args, { maxBuffer: EXEC_MAX_BUFFER });
}

// ===========================================================================
// Pure logic — no process spawn, no file I/O. This is the part §12/§15 asks
// to be directly unit-testable: issue-number extraction, the Status-
// transition decision, the idempotency check, and terminal-close sequencing.
// ===========================================================================

export type StatusName =
  | 'Open'
  | 'Ready to Plan'
  | 'On Deck'
  | 'In Progress'
  | 'Code Review'
  | 'Manual QA'
  | 'Ready to Deploy'
  | 'Post Deploy'
  | 'Closed';

/**
 * Extracts every GitHub issue number a merged PR's title/branch names.
 *
 * Title: the bracket-list convention (single-issue `[#N]`, repeated for a
 * batch PR whose title names several sibling tickets, e.g.
 * `[#195][#223][#224][#225]` — and/or a range `[#N-#M]`, e.g.
 * `[#195][#213-#217]`), per
 * orchestrator-github-issues-git-integration.md and release-pipeline.md's
 * `\[#([0-9]+)\]` extraction, extended to the range shape.
 *
 * Branch: the single-issue `issue-{N}_` convention (optionally prefixed by a
 * Jira story/epic key), per orchestrator-github-issues-git-integration.md
 * § Extracting the Key and Issue Number from a Branch. This is the same
 * regex documented there — not a second parser.
 */
// `title` is user-controlled (a PR's own title, `${{ github.event.pull_request.title }}`
// in the workflow), and every extracted number costs its own downstream
// `gh api graphql` call (transitionIssue(), and now also addProjectItem()/
// postDemoVideoForMergedPr()) — so an unbounded `[#N-#M]` range expands
// straight into that many calls. A malformed or typo'd title like
// `[#1-#999999999]` must fail fast, not grind for up to the Actions job's
// own timeout. 1000 is generous for any legitimate batch PR.
const MAX_ISSUE_RANGE_SPAN = 1000;

export function extractIssueNumbers(title: string, branch: string): number[] {
  const numbers = new Set<number>();

  const bracketPattern = /\[#(\d+)(?:-#(\d+))?\]/g;
  for (const m of title.matchAll(bracketPattern)) {
    const start = parseInt(m[1], 10);
    const end = m[2] !== undefined ? parseInt(m[2], 10) : start;
    if (end >= start && end - start <= MAX_ISSUE_RANGE_SPAN) {
      for (let n = start; n <= end; n++) numbers.add(n);
    }
  }

  const branchMatch = branch.match(/^([A-Z][A-Z0-9]*-[0-9]+\/)?issue-([0-9]+)_/);
  if (branchMatch) numbers.add(parseInt(branchMatch[2], 10));

  return [...numbers].sort((a, b) => a - b);
}

/**
 * Merge-signal edge: `Code Review`/`Manual QA` -> `Ready to Deploy`. `null`
 * means no-op (already past this edge, or not yet reachable from the current
 * status). This is the ONLY merge-time Status edge (#268) — it applies to
 * every ticket the merged PR names, whether or not the PR's closing-keywords
 * footer also names it. The footer drives the independent `gh issue close`
 * call and nothing else; it never alters the board's pipeline position, since
 * `Ready to Deploy` ("merged, not yet live") is a real tracking state that
 * remains true for a fully-complete ticket.
 */
export function mergeSignalTarget(currentStatus: string | null): StatusName | null {
  if (currentStatus === 'Code Review' || currentStatus === 'Manual QA') return 'Ready to Deploy';
  return null;
}

/** Deploy-signal terminal edge: `Ready to Deploy` -> `Post Deploy` (requires_post_deploy) or -> `Closed`. `null` means no-op (not at `Ready to Deploy`, e.g. already advanced). */
export function deploySignalTarget(currentStatus: string | null, requiresPostDeploy: boolean): StatusName | null {
  if (currentStatus !== 'Ready to Deploy') return null;
  return requiresPostDeploy ? 'Post Deploy' : 'Closed';
}

/** Read-current-Status-before-write idempotence (§9a.4): never write when there is no target, or the current Status already equals it. */
export function shouldWriteStatus(currentStatus: string | null, target: StatusName | null): boolean {
  return target !== null && currentStatus !== target;
}

/**
 * Terminal-close idempotency (§9a.5, Version 3): this Action is now the sole
 * caller of `gh issue close`, at merge (footer-named tickets) or deploy
 * (everything else). The caller has ALREADY decided that this event closes
 * the ticket — the merged PR's footer named it (merge time), or the board
 * reached its terminal `Closed` (deploy time) — and passes that decision in
 * as `'Closed'`; this helper only adds the "is the issue still OPEN?" guard,
 * so a retried workflow run, or a deploy event covering a ticket this same
 * Action already closed at merge, never closes twice. Note (#268) that the
 * asserted close intent is deliberately NOT the board Status target: at merge
 * time a footer-named ticket's Status target is `Ready to Deploy` (or `null`)
 * while its close intent is still `'Closed'`.
 */
export function shouldCloseIssue(target: StatusName | null, issueState: 'OPEN' | 'CLOSED'): boolean {
  return target === 'Closed' && issueState === 'OPEN';
}

const CLOSING_KEYWORDS_BLOCK = /<!--\s*ADLC:closing-keywords:start\s*-->([\s\S]*?)<!--\s*ADLC:closing-keywords:end\s*-->/;

/**
 * Parses the merged PR's **body** for the `<!-- ADLC:closing-keywords:start
 * -->` / `<!-- ADLC:closing-keywords:end -->` footer block (§3.2) and
 * returns every ticket named by a `Closes #N` line inside it. As of Version
 * 3 this is pure intent data — GitHub's own auto-close is fully disabled
 * repo-wide, so this Action is the only consumer of the footer. Returns an
 * empty array when the block is absent or empty (the default,
 * not-closing-at-merge state, §3.3).
 */
export function parseClosingKeywords(body: string): number[] {
  const blockMatch = body.match(CLOSING_KEYWORDS_BLOCK);
  if (!blockMatch) return [];
  const numbers = new Set<number>();
  for (const m of blockMatch[1].matchAll(/^\s*Closes #(\d+)\s*$/gm)) numbers.add(parseInt(m[1], 10));
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Every issue number a merged PR completes: the union of
 * `extractIssueNumbers(pr.title, pr.headRefName)` (the `[#N]` title-bracket /
 * `issue-{N}_` branch-name convention) and `parseClosingKeywords(pr.body)`
 * (the closing-keywords footer). This is the single, shared answer to "which
 * issues does this merged PR complete" — every call site that needs that
 * composite answer (deploy-mode coverage scanning, merge-mode scope,
 * historical backfill indexing, and demo-Slack reverse PR lookup) calls this
 * function rather than re-deriving its own ad-hoc combination of the two
 * inputs.
 */
export function prIssueNumbers(pr: { title: string; headRefName: string; body: string }): number[] {
  const numbers = new Set<number>([...extractIssueNumbers(pr.title, pr.headRefName), ...parseClosingKeywords(pr.body)]);
  return [...numbers].sort((a, b) => a - b);
}

/** Extracts the declared Jira epic key from an issue body (universal/issue-ticket-declaration.md § The Epic Declaration) — tolerates trailing prose on the same line. */
export function parseDeclaredEpic(body: string): string | null {
  const m = body.match(/^\*\*Jira Epic:\*\* *([A-Z][A-Z0-9]*-[0-9]+)/m);
  return m ? m[1] : null;
}

export interface RoutingConfig {
  owner: string;
  project: number;
  requiresPostDeploy: boolean;
  deployEnvironment: string | null;
}

/** Regex-based extraction (not a YAML parser), same posture as create-deployment-signal.test.ts's routing-drift check — this repo's docs/github-routing.yml is a small, hand-authored, flat-enough file that a full YAML dependency isn't justified. */
export function parseRoutingConfig(text: string): RoutingConfig {
  const ownerMatch = text.match(/^\s*owner:\s*(\S+)/m);
  const projectMatch = text.match(/^\s*project:\s*(\d+)/m);
  const requiresPostDeployMatch = text.match(/^\s*requires_post_deploy:\s*(true|false)/m);
  // Terminates on a true next same-or-lower-indentation key, or true end of string via `(?![\s\S])` —
  // NOT a bare `$`, which under the `/m` flag (needed so `^` matches mid-string line starts) matches at
  // the end of *every* line, so with the non-greedy `[\s\S]*?` it would stop after the block's first line.
  const deployBlockMatch = text.match(/^ {2}deploy:\n([\s\S]*?)(?:\n {0,2}\S|(?![\s\S]))/m);
  let deployEnvironment: string | null = null;
  if (deployBlockMatch) {
    const envMatch = deployBlockMatch[1].match(/^\s*environment:\s*(\S+)/m);
    if (envMatch && envMatch[1] !== 'null') deployEnvironment = envMatch[1];
  }
  if (!ownerMatch) die(`could not find 'owner:' in routing config at ${ROUTING_PATH}`);
  if (!projectMatch) die(`could not find 'project:' in routing config at ${ROUTING_PATH}`);
  return {
    owner: ownerMatch![1],
    project: parseInt(projectMatch![1], 10),
    requiresPostDeploy: requiresPostDeployMatch ? requiresPostDeployMatch[1] === 'true' : false,
    deployEnvironment,
  };
}

// ===========================================================================
// gh-mediated I/O
// ===========================================================================

/**
 * GraphQL query for the ONE target issue's own `projectItems` connection
 * (#264). Deliberately does NOT enumerate the project's items — an Issue
 * node's own `projectItems(first: N)` connection already resolves straight
 * to the item(s) that issue has on whatever project(s) it's been added to,
 * each with its own `project { id number }` (so the project's node id — used
 * by `writeStatus()`'s `--project-id` — comes back for free, no separate
 * `gh project view` lookup needed) and its own Status value via
 * `fieldValueByName`. No other item on the board is ever named or touched by
 * this query, so a broken/inaccessible field on some UNRELATED item can no
 * longer produce a partial error that blocks this one target issue — there
 * is nothing unrelated left in the response for that error to be rooted in.
 * `pullRequests` is deliberately not requested: nothing downstream in this
 * script consumes a linked-PR sub-connection.
 */
const PROJECT_ITEM_QUERY = `
  query($owner: String!, $repo: String!, $issueNumber: Int!, $itemsFirst: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        projectItems(first: $itemsFirst) {
          nodes {
            id
            project { id number }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
`;

// An issue realistically ends up on only a handful of project boards at
// most; 20 is generous headroom, not a "list everything" limit like the
// whole-project `--limit 1000` this replaces.
const PROJECT_ITEMS_FIRST = 20;

interface ProjectItemNode {
  id: string;
  project: { id: string; number: number } | null;
  fieldValueByName: { name: string } | null;
}

interface ProjectItemGraphqlResponse {
  data?: {
    repository?: {
      issue?: {
        projectItems?: { nodes: ProjectItemNode[] } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ type?: string; message: string }>;
}

/**
 * Finds the ONE project item (its id, its project's node id, and its
 * current Status) for a given issue number and project number — via a
 * query scoped to that single issue's own `projectItems` connection
 * (see `PROJECT_ITEM_QUERY` above), never enumerating the whole project.
 *
 * This is the #264 fix: the prior implementation ran `gh project item-list
 * <project> --limit 1000` and filtered client-side via
 * `.find(i => i.content?.number === issueNumber)` — walking EVERY item on
 * the whole 90-item, multi-repo project board just to find the one item
 * this call already knew it wanted. When GraphQL couldn't fully resolve a
 * sub-field on some completely unrelated item elsewhere in that response
 * (here, the Projects v2 linked-PR field's nested `pullRequests.nodes`), it
 * returned a partial error for that node path, `gh` exited non-zero for the
 * WHOLE response, and the old code's `result.status !== 0` check treated
 * that as fatal via `die()` — aborting before the one already-known target
 * issue's own Status transition ever ran. A query that only ever asks about
 * the target issue's own items structurally cannot suffer that failure
 * mode: there's no other item in the response for an error to be rooted in.
 *
 * Failure/outcome shapes:
 *  1. The issue itself doesn't exist (`errors` all `NOT_FOUND`) -> `die()`.
 *  2. No node in `projectItems` matches `projectNumber` (issue exists, has
 *     no item on this project, or has items only on OTHER projects) ->
 *     returns `null`. The caller (`transitionIssue()`) adds the issue to the
 *     board via `addProjectItem()` on this outcome rather than skipping
 *     (#265) — this function's own contract is unchanged: it still only
 *     ever reports whether an item already exists.
 *  3. A genuine GraphQL error not scoped to "issue not found" (rate limit,
 *     bad field/argument, permissions) -> `die()`.
 *  4. `gh` fails before producing any parseable JSON at all (network/auth
 *     failure, non-GraphQL error) -> `die()`.
 *  5. `gh` exits 0 but the body doesn't parse, or doesn't shape as expected
 *     (missing `data.repository.issue`) with no `errors` explaining why ->
 *     `die()`.
 *  6. A node matches `projectNumber` -> success: returns
 *     `{ itemId, projectId, status }`.
 */
export function findProjectItem(owner: string, repo: string, projectNumber: number, issueNumber: number): { itemId: string; projectId: string; status: string | null } | null {
  const result = adlcGh([
    'api',
    'graphql',
    '-f',
    `query=${PROJECT_ITEM_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `issueNumber=${issueNumber}`,
    '-F',
    `itemsFirst=${PROJECT_ITEMS_FIRST}`,
  ]);

  let parsed: ProjectItemGraphqlResponse;
  try {
    parsed = JSON.parse(result.stdout) as ProjectItemGraphqlResponse;
  } catch {
    // Case 4: no parseable JSON on stdout at all — a `gh` network/auth/exec
    // failure, not a GraphQL-level error. `output` (stdout+stderr) is the
    // useful diagnostic here since stdout alone was empty/garbage.
    die(`cannot query project item for issue #${issueNumber}: ${result.output.trim()}`);
  }

  if (parsed!.errors && parsed!.errors.length > 0) {
    const messages = parsed!.errors.map((e) => e.message).join('; ');
    if (parsed!.errors.every((e) => e.type === 'NOT_FOUND')) {
      // Case 1: the issue itself doesn't exist.
      die(`issue #${issueNumber} not found in ${owner}/${repo}: ${messages}`);
    }
    // Case 3: a genuine GraphQL error — and since this query only ever
    // names the ONE target issue's own projectItems connection, it is
    // necessarily about *this* issue's own lookup, never an unrelated node.
    die(`GraphQL error resolving project item for issue #${issueNumber}: ${messages}`);
  }

  if (result.status !== 0) {
    // Defensive: non-zero exit with no `errors` array to explain why.
    die(`cannot query project item for issue #${issueNumber}: ${result.output.trim()}`);
  }

  const issueData = parsed!.data?.repository?.issue;
  if (!issueData) {
    // Case 5: well-formed JSON, HTTP/exit success, but no issue data and no
    // `errors` explaining why — malformed/unexpected response shape.
    die(`unexpected empty response resolving project item for issue #${issueNumber} in ${owner}/${repo}`);
  }

  const nodes = issueData.projectItems?.nodes ?? [];
  const item = nodes.find((n) => n.project?.number === projectNumber);
  if (!item || !item.project) return null; // Case 2: no item on this project.

  return {
    itemId: item.id,
    projectId: item.project.id,
    status: item.fieldValueByName?.name ?? null,
  };
}

/**
 * GraphQL query for the project's Status field schema ONLY — its node id and
 * its single-select options' id/name (#272). Scoped by owner+project number,
 * with zero item traversal: no `items`/`projectItems` connection anywhere in
 * this query, so there is nothing item-level in the response for a
 * permission error to be rooted in.
 *
 * Uses `repositoryOwner(login: $owner)` — the `ProjectV2Owner` interface —
 * rather than `organization(login: $owner)`: this script ships unchanged to
 * every consumer repo via `adlc-init.md`, and a consumer's project may be
 * owned by a *user*, not an organization. `organization(login:)` resolves to
 * `null` (a NOT_FOUND-shaped GraphQL error) for a user-owned project;
 * `repositoryOwner` resolves correctly for both, so this query works
 * regardless of which kind of owner a given consumer repo's project has.
 * (Invoca/ADLC's own project 9 happens to be org-owned today, so
 * `organization(login:)` would also pass CI here — but that's not portable,
 * and portability is exactly the point.)
 *
 * Filters server-side via `field(name: "Status")` — resolving directly to
 * the Status field or `null` — rather than fetching `fields(first: N) {
 * nodes { ... } }` and finding the Status field client-side. The latter is
 * the field-list-shaped version of the same enumerate-then-filter
 * anti-pattern #264 already eliminated at item granularity: asking the
 * server for every field just to keep one, when the server can resolve the
 * one field directly.
 */
const STATUS_FIELD_QUERY = `
  query($owner: String!, $number: Int!) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          field(name: "Status") {
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
        }
      }
    }
  }
`;

interface StatusFieldGraphqlResponse {
  data?: {
    repositoryOwner?: {
      projectV2?: {
        field?: { id?: string; name?: string; options?: Array<{ id: string; name: string }> } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ type?: string; message: string }>;
}

export interface StatusField {
  fieldId: string;
  options: Array<{ id: string; name: string }>;
}

/**
 * Reads the Status field's option ids fresh (never cached, per
 * board-state.md's ID-freshness rule) via a query scoped to ONLY the
 * project's field schema (see `STATUS_FIELD_QUERY`) — never the
 * whole-project `gh project field-list` porcelain command.
 *
 * This is the #272 fix: `gh project field-list` was found, on #264's own
 * merge (its first live production trigger), to fail with the identical
 * shape #264 had just fixed for `findProjectItem()` — a `gh`-internal quirk
 * where `field-list`'s query, despite needing only the field *schema*, also
 * embeds a whole-project `items(first:N)` connection with the same per-item
 * `fieldValues.pullRequests` sub-connection that caused #264. A query with
 * no `items`/`projectItems` anywhere structurally cannot suffer that
 * failure — and, per `ShResult.stdout`'s own documented `gh api graphql`
 * behavior, a GraphQL response can carry usable `data` and a non-zero exit
 * status at the same time (a *partial* error), so the check below looks at
 * whether the targeted field itself resolved BEFORE consulting `errors` or
 * exit status — exactly the distinction that makes this query immune: since
 * `STATUS_FIELD_QUERY` names nothing but the field we want, any error that
 * shows up here despite the field having resolved is necessarily about
 * something else entirely, and must not block the write.
 *
 * Failure/outcome shapes:
 *  1. `gh` fails before producing any parseable JSON at all -> die().
 *  2. `data.repositoryOwner.projectV2.field` resolved (has `id` and
 *     `options`) -> success, regardless of any `errors` present alongside it
 *     or of `gh`'s exit status — the one thing this query asked for came
 *     back, so nothing else in the response can be about it.
 *  3. The field did NOT resolve, and a GraphQL error explains why -> die()
 *     with that message. Unlike findProjectItem(), there is no narrower
 *     soft-skip case here: a Status write cannot proceed at all without
 *     this field's schema.
 *  4. `gh` exits non-zero with no `errors` array to explain why (defensive)
 *     -> die().
 *  5. Well-formed success but no 'Status' single-select field exists on
 *     this project (the field resolved to null/missing with no error to
 *     explain why) -> die(). `STATUS_FIELD_QUERY` filters server-side via
 *     `field(name: "Status")`, so there is no `fields.nodes` array to
 *     enumerate here at all — unlike the old `gh project field-list` call,
 *     which fetched the whole field list and filtered for "Status"
 *     client-side; the server now does that filtering directly.
 */
export function getStatusField(owner: string, projectNumber: number): StatusField {
  const result = adlcGh(['api', 'graphql', '-f', `query=${STATUS_FIELD_QUERY}`, '-f', `owner=${owner}`, '-F', `number=${projectNumber}`]);

  let parsed: StatusFieldGraphqlResponse;
  try {
    parsed = JSON.parse(result.stdout) as StatusFieldGraphqlResponse;
  } catch {
    // Case 1: no parseable JSON on stdout at all — a `gh` network/auth/exec
    // failure, not a GraphQL-level error.
    die(`cannot query Status field schema for project ${projectNumber}: ${result.output.trim()}`);
  }

  const resolvedField = parsed!.data?.repositoryOwner?.projectV2?.field;
  if (resolvedField && resolvedField.id && resolvedField.options) {
    // Case 2: the targeted field resolved — success, independent of any
    // unrelated `errors`/exit status riding alongside it.
    return { fieldId: resolvedField.id, options: resolvedField.options };
  }

  if (parsed!.errors && parsed!.errors.length > 0) {
    // Case 3: the field did not resolve, and a GraphQL error explains why.
    const messages = parsed!.errors.map((e) => e.message).join('; ');
    die(`GraphQL error resolving Status field schema for project ${projectNumber}: ${messages}`);
  }

  if (result.status !== 0) {
    // Case 4: defensive — non-zero exit with no `errors` array to explain why.
    die(`cannot query Status field schema for project ${projectNumber}: ${result.output.trim()}`);
  }

  // Case 5: well-formed, no `errors`, `gh` exited 0 — but the field itself
  // never resolved (null/missing), with nothing explaining why.
  die(`project ${projectNumber} has no 'Status' single-select field`);
}

/**
 * GraphQL mutation to write the Status field's value for ONE project item —
 * with a response selection that asks for nothing beyond confirming the
 * write succeeded (#272): no `fieldValues`, no other item content, nothing
 * that could embed any sub-connection.
 *
 * This is the #272 fix for `writeStatus()`'s call site: an independent
 * wire-level trace (`GH_DEBUG=api gh project item-edit ...` — tracing the
 * query shape `gh` sends over the wire, not a live permission failure, so no
 * restricted token was needed to discover this) showed that `gh project
 * item-edit`'s own mutation response selection requests the edited item's
 * full `fieldValues(first:100){ nodes { ... on
 * ProjectV2ItemFieldPullRequestValue { pullRequests(first:10){ nodes { url
 * } } } ... } }` — the identical linked-PR sub-connection shape that caused
 * #264/#272's other two bugs, just scoped to the ONE edited item (blast
 * radius 1, not ~93) rather than eliminated entirely. `writeStatus()` runs on
 * every single Status write, and the item being edited always has a
 * genuinely populated linked-PR field (it is only ever called on an issue
 * whose merged PR/deployment triggered the sync) — so unlike #264's
 * unrelated-item risk, this sub-connection is guaranteed-populated on the
 * very item this call touches, not a rare edge case. A response selection
 * asking for nothing beyond `projectV2Item { id }` is structurally immune:
 * there is no sub-connection anywhere in it for that shape to recur in.
 */
const WRITE_STATUS_MUTATION = `
  mutation($project: ID!, $item: ID!, $field: ID!, $value: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $project, itemId: $item, fieldId: $field,
      value: { singleSelectOptionId: $value }
    }) {
      projectV2Item { id }
    }
  }
`;

interface WriteStatusGraphqlResponse {
  data?: {
    updateProjectV2ItemFieldValue?: {
      projectV2Item?: { id?: string } | null;
    } | null;
  };
  errors?: Array<{ type?: string; message: string }>;
}

/**
 * Writes the Status field's value for one project item, via a targeted
 * mutation whose response selection asks for nothing beyond confirming
 * success (see `WRITE_STATUS_MUTATION` above) — never `gh project item-edit`,
 * whose own response selection embeds the same linked-PR sub-connection
 * shape that caused #264/#272's other bugs (see the mutation's doc comment).
 *
 * Failure/outcome shapes (mirrors `getStatusField()`'s model — all-fatal,
 * no soft-skip case, since a Status write that doesn't confirm success
 * cannot be treated as a no-op):
 *  1. `gh` fails before producing any parseable JSON at all -> die().
 *  2. `data.updateProjectV2ItemFieldValue.projectV2Item.id` resolved (present
 *     and truthy) -> success, regardless of any `errors` present alongside
 *     it or of `gh`'s exit status — the one thing this mutation asked to
 *     confirm came back, so nothing else in the response can be about it.
 *  3. The write did NOT resolve, and a GraphQL error explains why -> die()
 *     with that message.
 *  4. `gh` exits non-zero with no `errors` array to explain why (defensive)
 *     -> die().
 *  5. Well-formed, no `errors`, `gh` exited 0 — but the mutation's own
 *     result never resolved (null/missing id), with nothing explaining why
 *     -> die().
 */
export function writeStatus(projectId: string, itemId: string, fieldId: string, optionId: string): void {
  const result = adlcGh([
    'api',
    'graphql',
    '-f',
    `query=${WRITE_STATUS_MUTATION}`,
    '-f',
    `project=${projectId}`,
    '-f',
    `item=${itemId}`,
    '-f',
    `field=${fieldId}`,
    '-f',
    `value=${optionId}`,
  ]);

  let parsed: WriteStatusGraphqlResponse;
  try {
    parsed = JSON.parse(result.stdout) as WriteStatusGraphqlResponse;
  } catch {
    // Case 1: no parseable JSON on stdout at all — a `gh` network/auth/exec
    // failure, not a GraphQL-level error.
    die(`cannot write Status for item ${itemId}: ${result.output.trim()}`);
  }

  const writtenItem = parsed!.data?.updateProjectV2ItemFieldValue?.projectV2Item;
  if (writtenItem && writtenItem.id) {
    // Case 2: the mutation's own edited item resolved — success, independent
    // of any unrelated `errors`/exit status riding alongside it.
    return;
  }

  if (parsed!.errors && parsed!.errors.length > 0) {
    // Case 3: the write did not resolve, and a GraphQL error explains why.
    const messages = parsed!.errors.map((e) => e.message).join('; ');
    die(`GraphQL error writing Status for item ${itemId}: ${messages}`);
  }

  if (result.status !== 0) {
    // Case 4: defensive — non-zero exit with no `errors` array to explain why.
    die(`cannot write Status for item ${itemId}: ${result.output.trim()}`);
  }

  // Case 5: well-formed, no `errors`, `gh` exited 0 — but the mutation's own
  // result never resolved (null/missing id), with nothing explaining why.
  die(`cannot write Status for item ${itemId}: unexpected empty response`);
}

/**
 * Resolves the two node ids `addProjectItem()`'s mutation needs but that
 * `PROJECT_ITEM_QUERY` never returns on a miss (#265) — the target issue's
 * own content node id, and the project's own node id. One query, two
 * independent root selections, rather than two separate `gh` calls.
 *
 * Uses `repositoryOwner(login: $owner)` — the `ProjectV2Owner` interface —
 * never `organization(login: $owner)`: same portability rationale as
 * `STATUS_FIELD_QUERY` above (this script ships unchanged to every consumer
 * repo, and a consumer's project may be owned by a user, not an
 * organization).
 */
const ADD_ITEM_RESOLVE_QUERY = `
  query($owner: String!, $repo: String!, $issueNumber: Int!, $projectNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) { id }
    }
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $projectNumber) { id }
      }
    }
  }
`;

interface AddItemResolveGraphqlResponse {
  data?: {
    repository?: { issue?: { id?: string } | null } | null;
    repositoryOwner?: { projectV2?: { id?: string } | null } | null;
  };
  errors?: Array<{ type?: string; message: string }>;
}

/**
 * Failure/outcome shapes (mirrors `writeStatus()`'s model — all-fatal, no
 * soft-skip case, since these ids feed a subsequent write that cannot
 * proceed without them):
 *  1. `gh` fails before producing any parseable JSON at all -> die().
 *  2. Both `repository.issue.id` and `repositoryOwner.projectV2.id` resolved
 *     -> success, regardless of any `errors`/exit status riding alongside.
 *  3. Either id did NOT resolve, and a GraphQL error explains why -> die()
 *     with that message.
 *  4. `gh` exits non-zero with no `errors` array to explain why (defensive)
 *     -> die().
 *  5. Well-formed, no `errors`, `gh` exited 0 — but one or both ids never
 *     resolved, with nothing explaining why -> die().
 */
function resolveAddInputs(owner: string, repo: string, projectNumber: number, issueNumber: number): { contentId: string; projectId: string } {
  const result = adlcGh([
    'api',
    'graphql',
    '-f',
    `query=${ADD_ITEM_RESOLVE_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `issueNumber=${issueNumber}`,
    '-F',
    `projectNumber=${projectNumber}`,
  ]);

  let parsed: AddItemResolveGraphqlResponse;
  try {
    parsed = JSON.parse(result.stdout) as AddItemResolveGraphqlResponse;
  } catch {
    // Case 1.
    die(`cannot resolve add-inputs for issue #${issueNumber} on project ${projectNumber}: ${result.output.trim()}`);
  }

  const contentId = parsed!.data?.repository?.issue?.id;
  const projectId = parsed!.data?.repositoryOwner?.projectV2?.id;
  if (contentId && projectId) {
    // Case 2.
    return { contentId, projectId };
  }

  if (parsed!.errors && parsed!.errors.length > 0) {
    // Case 3.
    const messages = parsed!.errors.map((e) => e.message).join('; ');
    die(`GraphQL error resolving add-inputs for issue #${issueNumber} on project ${projectNumber}: ${messages}`);
  }

  if (result.status !== 0) {
    // Case 4.
    die(`cannot resolve add-inputs for issue #${issueNumber} on project ${projectNumber}: ${result.output.trim()}`);
  }

  // Case 5.
  die(`unexpected empty response resolving add-inputs for issue #${issueNumber} on project ${projectNumber}`);
}

/**
 * GraphQL mutation adding one issue's content node to one project — no
 * `Status` input, ever (a freshly-added item's Status is always `null`;
 * GitHub sets no default for a new item). Mirrors board-backfill.ts's own
 * `addProjectV2ItemById` mutation SHAPE (its `addProjectItem()`, §1.4 of its
 * historical-sweep), but through THIS file's own `adlcGh`/`die` idiom —
 * deliberately not extracted/shared: `board-status-sync.ts` ships unchanged
 * to every consumer repo via adlc-init.md, while `board-backfill.ts` is a
 * one-time internal sweep with its own parallel-but-independent infra. The
 * two stay parallel-but-independent so backfill-only concerns never leak
 * into the shipped sync path.
 */
const ADD_PROJECT_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

interface AddProjectItemGraphqlResponse {
  data?: {
    addProjectV2ItemById?: {
      item?: { id?: string } | null;
    } | null;
  };
  errors?: Array<{ type?: string; message: string }>;
}

/** Failure/outcome shapes: same model as `resolveAddInputs()` above, applied to the add mutation's own response. */
function runAddItemMutation(projectId: string, contentId: string, issueNumber: number, projectNumber: number): string {
  const result = adlcGh(['api', 'graphql', '-f', `query=${ADD_PROJECT_ITEM_MUTATION}`, '-f', `projectId=${projectId}`, '-f', `contentId=${contentId}`]);

  let parsed: AddProjectItemGraphqlResponse;
  try {
    parsed = JSON.parse(result.stdout) as AddProjectItemGraphqlResponse;
  } catch {
    die(`cannot add issue #${issueNumber} to project ${projectNumber}: ${result.output.trim()}`);
  }

  const itemId = parsed!.data?.addProjectV2ItemById?.item?.id;
  if (itemId) {
    return itemId;
  }

  if (parsed!.errors && parsed!.errors.length > 0) {
    const messages = parsed!.errors.map((e) => e.message).join('; ');
    die(`GraphQL error adding issue #${issueNumber} to project ${projectNumber}: ${messages}`);
  }

  if (result.status !== 0) {
    die(`cannot add issue #${issueNumber} to project ${projectNumber}: ${result.output.trim()}`);
  }

  die(`cannot add issue #${issueNumber} to project ${projectNumber}: unexpected empty response`);
}

/**
 * Adds one issue to one project board (#265): `findProjectItem()` returning
 * `null` means the issue has no item on this project yet, and
 * orchestrator-github-issues-status-updates.md's add-then-transition
 * contract requires this is never skipped in that case. Two `gh api
 * graphql` calls — resolve the node ids (`resolveAddInputs()`), then the
 * actual add (`runAddItemMutation()`) — each following this file's own
 * JSON.parse -> errors -> status -> shape-check `die()` cascade (mirrors
 * `writeStatus()`'s validation exactly): an add that cannot be confirmed to
 * have succeeded is never silently treated as a no-op.
 */
export function addProjectItem(owner: string, repo: string, projectNumber: number, issueNumber: number): { itemId: string; projectId: string } {
  const { contentId, projectId } = resolveAddInputs(owner, repo, projectNumber, issueNumber);
  const itemId = runAddItemMutation(projectId, contentId, issueNumber, projectNumber);
  return { itemId, projectId };
}

export function getIssueStateAndBody(owner: string, repo: string, issueNumber: number): { state: 'OPEN' | 'CLOSED'; body: string } {
  const result = adlcGh(['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'state,body']);
  if (result.status !== 0) die(`cannot view issue #${issueNumber}: ${result.output.trim()}`);
  let parsed: { state: 'OPEN' | 'CLOSED'; body: string };
  try {
    parsed = JSON.parse(result.output) as typeof parsed;
  } catch {
    die(`cannot parse issue view output for #${issueNumber}: ${result.output.trim()}`);
  }
  return parsed!;
}

export function closeIssue(owner: string, repo: string, issueNumber: number): void {
  const result = adlcGh(['issue', 'close', String(issueNumber), '--repo', `${owner}/${repo}`, '--reason', 'completed']);
  if (result.status !== 0) die(`cannot close issue #${issueNumber}: ${result.output.trim()}`);
}

export function annotateEpicIfDeclared(body: string, issueNumber: number): void {
  const epic = parseDeclaredEpic(body);
  if (!epic) return;
  console.log(
    `Note: issue #${issueNumber} declares Jira epic ${epic} — this Action carries no Atlassian credential, so the per-close epic annotation (epic-bridge.md § Annotate) is not posted here. A session's Board Hygiene sweep posts it idempotently on its next pass.`,
  );
}

/**
 * Applies one transition (merge or deploy signal) to one issue, end to end:
 * read -> decide -> write (idempotent) -> terminal close (idempotent) ->
 * epic-annotation note.
 *
 * `footerCloses` (merge mode only — main()'s deploy loop never passes it,
 * §9a.2): true when the merged PR's `<!-- ADLC:closing-keywords -->` footer
 * named this ticket with a `Closes #N` line. Per #268 it feeds ONLY the
 * close/annotate branch below, never the Status target: the Status target is
 * a pure function of (mode, current Status), so a footer-named ticket takes
 * exactly the same `Code Review`/`Manual QA` -> `Ready to Deploy` merge edge
 * as a partial-scope one, while its GitHub issue closes immediately at that
 * same merge event. Two independent signals, two independent decisions — the
 * issue tracker's `state` answers "is any work left declared here?" (the
 * footer knows that at merge), the board's Status answers "where is this in
 * the pipeline?" (only the deploy event moves it past `Ready to Deploy`).
 *
 * The close/annotate branch therefore runs on three independent triggers —
 * this footer intent, a `Closed` Status target (the deploy-time terminal
 * close), or a board Status that already reads `Closed` (crash recovery) —
 * and never on whether the Status write itself was needed this call, since
 * the two writes are non-atomic and independently idempotent (see the
 * Idempotency note at the top of this file).
 *
 * Exported (#258 Part 3): `board-status-backfill.ts`'s historical-mode
 * driver calls this SAME function, unmodified, for the merge and deploy
 * edges of its retroactive Status-hygiene sweep — feeding it issue numbers
 * derived from historical merged-PR/deployment data instead of a live
 * webhook event's env vars. Because this function always re-reads the
 * item's current Status fresh via `findProjectItem()` before deciding,
 * calling it once for a historical merge signal and then once for a
 * historical deploy signal (in that order) chains through the same
 * Code Review/Manual QA -> Ready to Deploy -> Post Deploy/Closed matrix a
 * live merge event followed by a live deploy event would have produced —
 * no separate historical decision logic is needed for those two signals.
 * The historical driver passes `addIfMissing: false`, so a historical miss
 * (no item on the board for that issue) is left as found and skipped, never
 * added — see `addIfMissing` below.
 *
 * `addIfMissing` (default `true`): governs the miss branch immediately
 * below. The two live callers (merge/deploy webhook handling) rely on the
 * default so a live event still add-then-transitions an issue with no prior
 * board item (#265). The historical driver passes `false`: a miss during a
 * historical sweep can only mean a deliberate concurrent removal from the
 * board (a TOCTOU race against the sweep itself), and re-adding would fight
 * that removal — so historical mode skips instead.
 */
export interface TransitionOutcome {
  /** The Status target this call's own signal-matrix computation produced — `null` when the item wasn't at an edge this signal advances. */
  target: StatusName | null;
  /** Whether THIS call actually performed the Status write, vs. a no-op against an already-advanced, or freshly-added-with-no-target, item. */
  wroteStatus: boolean;
}

export function transitionIssue(owner: string, repo: string, projectNumber: number, requiresPostDeploy: boolean, issueNumber: number, mode: 'merge' | 'deploy', footerCloses = false, addIfMissing = true): TransitionOutcome {
  let item = findProjectItem(owner, repo, projectNumber, issueNumber);
  let wasJustAdded = false;
  if (!item) {
    if (!addIfMissing) {
      console.log(`Issue #${issueNumber}: not on project ${projectNumber}'s board; skipping (add-then-transition disabled for this caller).`);
      return { target: null, wroteStatus: false };
    }
    // orchestrator-github-issues-status-updates.md § Project Workflow Status Options
    // > Add-Then-Transition: add-then-transition, never skipped (#265) when
    // addIfMissing is true. A freshly-added item's Status is always `null`
    // — GitHub sets no default — so it is constructed directly here rather
    // than re-read via a second findProjectItem() call.
    const added = addProjectItem(owner, repo, projectNumber, issueNumber);
    item = { itemId: added.itemId, projectId: added.projectId, status: null };
    wasJustAdded = true;
    console.log(`Issue #${issueNumber}: added to the board (Status defaults to empty).`);
  }

  // The Status target depends only on the event and the item's current
  // Status — never on the footer (#268).
  const target = mode === 'merge' ? mergeSignalTarget(item.status) : deploySignalTarget(item.status, requiresPostDeploy);
  const wroteStatus = shouldWriteStatus(item.status, target);

  if (wroteStatus) {
    const field = getStatusField(owner, projectNumber);
    const option = field.options.find((o) => o.name === target);
    if (!option) die(`project ${projectNumber} has no Status option named "${target}"`);
    writeStatus(item.projectId, item.itemId, field.fieldId, option.id);
    console.log(`Issue #${issueNumber}: Status "${item.status ?? '(none)'}" -> "${target}".`);
  } else if (wasJustAdded) {
    console.log(`Issue #${issueNumber}: added with empty Status, which the ${mode}-signal matrix has no target for; no-op.`);
  } else {
    console.log(`Issue #${issueNumber}: status "${item.status ?? '(none)'}" already at/beyond the ${mode}-signal target; no-op.`);
  }

  // The Status write above and the issue-close below are two independent,
  // non-atomic operations (§9a.4/§9a.5), so this check is deliberately NOT
  // nested inside the shouldWriteStatus branch above. Three independent
  // triggers, OR'd into ONE branch so a case satisfying more than one still
  // performs at most one `gh issue view` + one `gh issue close`:
  //
  //   footerCloses           — merge time, the merged PR's footer named this
  //                            ticket as complete (#268). Fires whatever the
  //                            Status target turned out to be ("Ready to
  //                            Deploy", or `null` when the ticket wasn't on
  //                            the merge edge at all): the footer is an
  //                            assertion about the issue tracker, not about
  //                            deploy readiness.
  //   target === 'Closed'    — deploy time, the terminal two-write close for
  //                            a ticket that did not already close at merge.
  //   item.status ===        — crash recovery: a failure between the two
  //     'Closed'               writes must not permanently strand the issue
  //                            OPEN once Status has already converged on
  //                            "Closed" (both target functions collapse to
  //                            `target === null` in that state).
  //
  // This branch is reached even for a freshly-added item (#265): the miss
  // branch above falls through into this same logic rather than
  // early-returning, so a footer-named ticket with no prior item on this
  // project still gets its `gh issue close`.
  if (footerCloses || target === 'Closed' || item.status === 'Closed') {
    const { state, body } = getIssueStateAndBody(owner, repo, issueNumber);
    if (shouldCloseIssue('Closed', state)) {
      closeIssue(owner, repo, issueNumber);
      console.log(`Issue #${issueNumber}: closed (gh issue close --reason completed).`);
    } else {
      console.log(`Issue #${issueNumber}: already ${state}; skipping gh issue close (already closed by this Action's own prior write).`);
    }
    annotateEpicIfDeclared(body, issueNumber);
  }

  return { target, wroteStatus };
}

// ===========================================================================
// Deploy-mode PR discovery: which merged PRs does this deployment cover?
// ===========================================================================

/**
 * `body` feeds `prIssueNumbers()`'s closing-keywords half of the union, for
 * both this file's own `deploy` mode (the covered-PR scan) and
 * `board-status-backfill.ts`'s historical driver — both build a
 * `prsByIssue`/`issues` index from a `listRecentMergedPrs()` result, and both
 * need the footer available on each entry to compute that index correctly.
 */
export interface MergedPrEntry {
  number: number;
  title: string;
  headRefName: string;
  mergeCommitOid: string | null;
  body: string;
}

export function listRecentMergedPrs(owner: string, repo: string, limit = 100): MergedPrEntry[] {
  const result = adlcGh(['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'merged', '--json', 'number,title,headRefName,mergeCommit,body', '--limit', String(limit)]);
  if (result.status !== 0) die(`cannot list merged PRs for ${owner}/${repo}: ${result.output.trim()}`);
  let parsed: Array<{ number: number; title: string; headRefName: string; mergeCommit: { oid: string } | null; body: string | null }>;
  try {
    parsed = JSON.parse(result.output) as typeof parsed;
  } catch {
    die(`cannot parse merged PR list for ${owner}/${repo}: ${result.output.trim()}`);
  }
  return parsed!.map((pr) => ({ number: pr.number, title: pr.title, headRefName: pr.headRefName, mergeCommitOid: pr.mergeCommit?.oid ?? null, body: pr.body ?? '' }));
}

/**
 * `git merge-base --is-ancestor <sha> <deploySha>` — true if `sha` is an
 * ancestor of (or equal to) `deploySha`, mirroring the session-polled Deploy
 * Signal checkpoint's own containment check. Operates on whatever git
 * repository `process.cwd()` is inside of (via `ADLC_BOARD_SYNC_GIT`'s
 * un-cwd-scoped `execFileSync` call) — for this file's own `deploy` mode
 * that is always the live GitHub Actions checkout of the one target repo.
 * Exported (#258 Part 3) so `board-status-backfill.ts`'s historical driver
 * can reuse this SAME check against a temporary clone of each historical
 * target repo in turn, by `process.chdir()`-ing into that clone first —
 * the function itself needed no change to be reusable that way.
 */
export function isAncestor(sha: string, deploySha: string): boolean {
  return adlcGit(['merge-base', '--is-ancestor', sha, deploySha]).status === 0;
}

// ===========================================================================
// Slack journal-entry hook: invoked once per merge event, after the Status
// transition pass, for every issue number the merged PR completes — or, when
// it completes none, once for the PR itself.
// ===========================================================================

/**
 * Posts each of `issueNumbers`' merge update to Slack — one journal entry per
 * issue, all completed by the same merged PR — or, when `issueNumbers` is
 * empty, a single PR-level entry for the merged PR itself. Every entry
 * carries whichever enrichments are mechanically resolvable from the PR body
 * alone (a real Press Release or the pinned fallback line, Jira/issue/PR
 * links, author mentions, a threaded video, per-AC thread replies) — no
 * enrichment ever blocks the entry itself.
 *
 * A merged PR naming 2+ issues gets one full, separate journal entry per
 * issue — its own anchor message, video thread, and AC replies — never
 * deduplicated into a single entry for the whole PR.
 *
 * `resolvedPr` is built directly from the merge event's own
 * `pr.number`/`pr.title`/`pr.body` — no `listRecentMergedPrs()`/
 * `resolveMergedPrForIssue()` lookup, since the merge event already carries
 * the PR that completes these issues. `pr.number` is `null` when the
 * workflow's own `PR_NUMBER` env var is absent or non-numeric — there is no
 * merged PR to post about in that case, so the whole hook is a no-op.
 *
 * `bodyHtml` is fetched at most once for the whole call (not once per
 * issue), whenever the PR body carries a video URL or at least one AC
 * Coverage Report row carries a screenshot embed (a screenshot re-upload
 * needs the same rendered HTML). A `fetchPrBodyHtml` failure degrades to a
 * logged warning, never a throw — the journal-entry composer already treats
 * a missing `bodyHtml` as a safe, retryable skip of just the
 * binary-attachment step.
 *
 * Commit authors (`getPrCommitAuthors()`) are resolved unconditionally —
 * every entry carries a best-effort Shipped-by line.
 *
 * Never throws: each entry's own posting call runs inside its own
 * try/catch, so one issue's `gh`/Slack failure never stops its siblings, or
 * the caller's own Status-transition batch, from completing.
 */
export async function postDemoVideoForMergedPr(
  owner: string,
  repo: string,
  issueNumbers: number[],
  pr: { number: number | null; title: string; body: string },
  slackRouting: SlackRoutingConfig,
  deps: { gh: GhRunner; slackToken: string | undefined; fetchImpl?: FetchLike },
): Promise<void> {
  if (pr.number === null) {
    console.log('PR_NUMBER was not set or non-numeric; cannot resolve a merged PR to post about, skipping Slack post entirely.');
    return;
  }
  const resolvedPr: { number: number; title: string; body: string; bodyHtml?: string } = { number: pr.number, title: pr.title, body: pr.body };

  const acRows = extractAcCoverageRows(resolvedPr.body);
  const needsBodyHtml = extractVideoUrl(resolvedPr.body) !== null || acRows.some((row) => extractScreenshotUrls(row.evidence).length > 0);
  if (needsBodyHtml) {
    try {
      resolvedPr.bodyHtml = fetchPrBodyHtml(deps.gh, owner, repo, resolvedPr.number);
    } catch (error) {
      console.error(`warning: merged PR #${resolvedPr.number}: could not fetch body_html for video/screenshot-URL resolution: ${errorDetail(error)}`);
    }
  }

  let authors: CommitAuthor[] = [];
  try {
    authors = getPrCommitAuthors(deps.gh, owner, repo, resolvedPr.number);
  } catch (error) {
    console.error(`warning: merged PR #${resolvedPr.number}: could not resolve commit authors for Shipped-by mentions: ${errorDetail(error)}`);
  }

  const deps2 = { gh: deps.gh, slackToken: deps.slackToken, channelId: slackRouting.channelId, fetchImpl: deps.fetchImpl };

  if (issueNumbers.length === 0) {
    try {
      const outcome = await postJournalEntryForPr(deps2, owner, repo, resolvedPr, authors);
      console.log(`PR #${resolvedPr.number}: journal-entry outcome: ${outcome}.`);
    } catch (error) {
      console.error(`warning: PR #${resolvedPr.number}: Slack post failed: ${errorDetail(error)}`);
    }
    return;
  }

  for (const issueNumber of issueNumbers) {
    try {
      const outcome = await postJournalEntryForIssue(deps2, owner, repo, issueNumber, issueNumbers, resolvedPr, authors);
      console.log(`Issue #${issueNumber}: journal-entry outcome: ${outcome}.`);
    } catch (error) {
      console.error(`warning: issue #${issueNumber}: Slack post failed (Status transition above is unaffected): ${errorDetail(error)}`);
    }
  }
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'merge' && mode !== 'deploy') {
    die(`usage: ${process.argv[1]} <merge|deploy>`);
  }

  const repoSlug = process.env.GITHUB_REPOSITORY || '';
  const parts = repoSlug.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    die(`GITHUB_REPOSITORY must be set as 'owner/repo'; got '${repoSlug}'`);
  }
  const [owner, repo] = parts;

  const routingText = readFileSync(ROUTING_PATH, 'utf8');
  const routing = parseRoutingConfig(routingText);

  if (mode === 'merge') {
    if (process.env.PR_MERGED !== 'true') {
      console.log('PR closed without merging; not a completion signal, no-op.');
      return;
    }
    const title = process.env.PR_TITLE || '';
    const branch = process.env.PR_HEAD_REF || '';
    const body = process.env.PR_BODY || '';
    const issues = prIssueNumbers({ title, headRefName: branch, body });
    const failures: number[] = [];
    if (issues.length > 0) {
      const closingKeywords = parseClosingKeywords(body);
      for (const issueNumber of issues) {
        try {
          transitionIssue(owner, repo, routing.project, routing.requiresPostDeploy, issueNumber, 'merge', closingKeywords.includes(issueNumber));
        } catch (error) {
          failures.push(issueNumber);
          console.error(`error: issue #${issueNumber}: ${errorDetail(error)}`);
        }
      }
    } else {
      console.log(`No issue numbers extracted from PR title '${title}' / branch '${branch}' / closing-keywords footer; posting a PR-level journal entry instead.`);
    }
    // Slack journal-entry hook: unconditional for every issue this merged PR
    // completes (or, when it completes none, for the PR itself), independent
    // of the transition loop's own per-ticket outcome above — run before the
    // failures-gated die() below, so a partial-failure transition batch still
    // gets its post attempt.
    const prNumberRaw = process.env.PR_NUMBER || '';
    const prNumber = /^\d+$/.test(prNumberRaw) ? Number(prNumberRaw) : null;
    await postDemoVideoForMergedPr(owner, repo, issues, { number: prNumber, title, body }, parseSlackRoutingConfig(routingText), {
      gh: adlcGh,
      slackToken: process.env.ADLC_DEMO_AGENT_SLACK_TOKEN,
    });
    if (failures.length > 0) die(`failed to transition ${failures.length} of ${issues.length} issue(s): ${failures.join(', ')}`);
    return;
  }

  // mode === 'deploy'
  const deploySha = process.env.DEPLOY_SHA || '';
  const deployEnvironment = process.env.DEPLOY_ENVIRONMENT || '';
  if (deploySha === '') die('DEPLOY_SHA must be set for deploy mode');
  if (routing.deployEnvironment === null) {
    console.log('No deploy environment configured (deploy.environment: null); this repo has no GitHub Deployments signal, so deploy mode is a no-op.');
    return;
  }
  if (deployEnvironment !== routing.deployEnvironment) {
    console.log(`Deployment environment '${deployEnvironment}' does not match the configured '${routing.deployEnvironment}'; no-op.`);
    return;
  }

  const prs = listRecentMergedPrs(owner, repo);
  const covered = prs.filter((pr) => pr.mergeCommitOid !== null && isAncestor(pr.mergeCommitOid, deploySha));
  const issues = new Set<number>();
  for (const pr of covered) {
    for (const issueNumber of prIssueNumbers(pr)) issues.add(issueNumber);
  }
  if (issues.size === 0) {
    console.log(`No merged PR's issue(s) are covered by deployment ${deploySha}; no-op.`);
    return;
  }
  const failures: number[] = [];
  for (const issueNumber of [...issues].sort((a, b) => a - b)) {
    try {
      transitionIssue(owner, repo, routing.project, routing.requiresPostDeploy, issueNumber, 'deploy');
    } catch (error) {
      failures.push(issueNumber);
      console.error(`error: issue #${issueNumber}: ${errorDetail(error)}`);
    }
  }
  if (failures.length > 0) die(`failed to transition ${failures.length} of ${issues.size} issue(s): ${failures.join(', ')}`);
}

// process.argv[1] can be a relative path (e.g. invoked as
// `.github/scripts/board-status-sync.ts` from a workflow step), while
// fileURLToPath(import.meta.url) is always absolute — resolve both sides
// before comparing (same pattern as publish-homebrew-adlc.ts's isMain()) so
// this still fires under a relative invocation, and so test code can import
// the pure functions above without triggering main() as a side effect.
function isMainModule(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => {
    if (error instanceof DieError) {
      console.error(`error: ${errorDetail(error)}`);
    } else {
      console.error(errorDetail(error));
    }
    process.exit(1);
  });
}
