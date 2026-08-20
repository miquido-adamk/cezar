/**
 * Every user-facing string for the task-loops views (spec
 * `.ai/specs/2026-08-19-task-loops.md`, § UI/UX).
 *
 * The spec specifies loop copy as an interaction contract — the literal strings to
 * ship, not descriptions of them — so they live here as data and are asserted by
 * the view tests. The per-item reason line is the debuggability contract: it is
 * always rendered, never hidden behind a tooltip, because "why did the loop stop
 * here" is the only question the timeline exists to answer.
 */
import type { LoopReceipt, LoopStatus } from '@open-mercato/cezar-api-client'

/** Status pill text, one per definition status. */
export const LOOP_STATUS_LABEL: Record<LoopStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
}

export const LOOPS_EMPTY_HEADING = 'No loops yet'
export const LOOPS_EMPTY_BODY =
  'A loop runs a list of tasks one at a time — each in its own worktree, in the order you write them.'
export const LOOPS_EMPTY_ACTION = 'New loop'
export const LOOPS_LOAD_FAILED = "Couldn't load loops."
export const LOOPS_RETRY = 'Try again'
export const LOOP_DELETE_CONFIRM =
  'Delete this loop? Tasks it already started keep running, and their branches are kept.'

/** The composer's items field, and the ceiling that makes a 100-item cap legible. */
export const LOOP_ITEMS_LABEL = 'Items — one per line'
export const LOOP_ITEMS_HELP =
  'Each line starts its own task, in its own worktree. They run one at a time, in order.'
export const LOOP_VARIANTS_OFF_HINT = 'Variants are off while Loop is on.'
export const loopItemsOverCap = (over: number) => `Loops are limited to 100 items. Remove ${over} to continue.`
export const loopItemCount = (count: number) => (count === 1 ? '1 item' : `${count} items`)

/** Progress line — "4 of 12 done · 1 skipped", with the skipped clause only when nonzero. */
export function loopProgressLine(input: { completedCount: number; skippedCount: number; totalCount: number }): string {
  const done = `${input.completedCount} of ${input.totalCount} done`
  return input.skippedCount > 0 ? `${done} · ${input.skippedCount} skipped` : done
}

/**
 * The consequential-action confirmation. Starting a loop spawns N unattended paid
 * sessions — the one hard-to-reverse act in the feature — so the primary button is
 * never a bare "Start" and this step states the scale before anything launches.
 */
export const loopStartConfirm = (count: number) => ({
  heading: 'Start this loop?',
  body: [
    `${loopItemCount(count)} will run one at a time, each as its own task with its own worktree and branch. Each one is a real agent session.`,
    'Nothing is merged. You review the branches yourself.',
  ],
  cancel: 'Cancel',
  confirm: `Start ${loopItemCount(count)}`,
})

/** Item timeline row status, derived from the item's latest receipt (absent = pending). */
export type LoopItemView =
  | { kind: 'pending' }
  | { kind: 'running'; startedAt?: string }
  | { kind: 'queued' }
  | { kind: 'done'; branch?: string }
  | { kind: 'skipped'; reason?: string }
  | { kind: 'stalled'; reason?: string }
  | { kind: 'vanished' }
  | { kind: 'never-started' }
  | { kind: 'launch-error'; reason?: string }
  | { kind: 'merged'; prNumber?: number }
  | { kind: 'merge-blocked'; reason?: string; prNumber?: number }

/** Short status word for the row's pill. */
export const LOOP_ITEM_STATUS_LABEL: Record<LoopItemView['kind'], string> = {
  pending: 'Pending',
  running: 'Running',
  queued: 'Queued',
  done: 'Done',
  skipped: 'Skipped',
  stalled: 'Stalled',
  vanished: 'Vanished',
  'never-started': 'Never started',
  'launch-error': 'Launch error',
  merged: 'Merged',
  'merge-blocked': 'Not merged',
}

/**
 * The row's explanation line. Every non-`Done` state names its cause, because a loop
 * that stopped without saying why is the failure mode the receipts exist to prevent.
 */
export function loopItemLine(view: LoopItemView, relativeTime: (iso: string) => string): string {
  switch (view.kind) {
    case 'pending':
      return 'Not started yet'
    case 'queued':
      return 'Waiting for a free slot'
    case 'running':
      return view.startedAt ? `Running · started ${relativeTime(view.startedAt)}` : 'Running'
    case 'done':
      return view.branch ? `Done · branch ${view.branch}` : 'Done'
    case 'skipped':
      return view.reason ? `Skipped · ${view.reason}` : 'Skipped'
    case 'stalled':
      return view.reason ? `Stalled · ${view.reason}` : 'Stalled · this task has been monitoring for too long'
    case 'vanished':
      return "Stopped · this task's history was pruned, so the loop can't tell whether it finished"
    case 'never-started':
      return 'Never started · no free agent account for 30 minutes'
    case 'launch-error':
      return `Couldn't start · ${view.reason ?? 'the task could not be created'}`
    case 'merged':
      return view.prNumber ? `Merged · PR #${view.prNumber}` : 'Merged'
    // Says the PR survived, because the recovery action is to go review it.
    case 'merge-blocked':
      return view.prNumber
        ? `Not merged · ${view.reason ?? 'still not mergeable'} · PR #${view.prNumber} is open for you`
        : `Not merged · ${view.reason ?? 'still not mergeable'}`
  }
}

export const LOOP_ITEM_RETRY = 'Retry this item'

/**
 * Map an item's latest receipt onto its view state. A launched-but-unsettled item is
 * `running`; no receipt at all means the loop has not reached it yet.
 *
 * `reserved` deliberately reads as `running` rather than as its own state: from the
 * user's side a reserved receipt whose run exists IS the item running, and a reserved
 * receipt whose run does not exist is reconciled to `launch-error` at boot before any
 * view sees it.
 */
export function loopItemViewOf(receipt: LoopReceipt | undefined, isAwaited: boolean): LoopItemView {
  if (!receipt) return { kind: 'pending' }
  switch (receipt.status) {
    case 'reserved':
      return isAwaited ? { kind: 'running', startedAt: receipt.observedAt } : { kind: 'queued' }
    case 'completed':
      return { kind: 'done' }
    case 'skipped':
      return { kind: 'skipped', reason: receipt.reason }
    case 'stalled':
      return { kind: 'stalled', reason: receipt.reason }
    case 'vanished':
      return { kind: 'vanished' }
    case 'never-started':
      return { kind: 'never-started' }
    case 'launch-error':
      return { kind: 'launch-error', reason: receipt.reason }
    case 'merged':
      return { kind: 'merged', prNumber: receipt.prNumber }
    case 'merge-blocked':
      return { kind: 'merge-blocked', reason: receipt.reason, prNumber: receipt.prNumber }
    // A detached project leaves the loop paused with the item mid-flight; the row reads
    // as skipped-with-a-reason rather than inventing a tenth visual state for it.
    case 'project-detached':
      return { kind: 'skipped', reason: receipt.reason ?? 'the project was removed while this item was running' }
  }
}

/**
 * The paused banner — the primary recovery path, not an error state. It names the
 * cause and offers exactly the two moves that exist, plus a link to the run for
 * cancelling it, which stays the user's own action on that run.
 */
export function loopPausedBanner(input: { itemNumber: number; reason?: string }) {
  return {
    heading: input.reason
      ? `Paused — item ${input.itemNumber}: ${input.reason}`
      : `Paused at item ${input.itemNumber}.`,
    body: `The task is still running; the loop won't start item ${input.itemNumber + 1} until you decide.`,
    resume: 'Resume loop',
    skip: `Skip item ${input.itemNumber}`,
    open: `Open item ${input.itemNumber}`,
  }
}

// ---- drafting items from a brief (follow-up to Q1) ----------------------------------------

export const LOOP_BRIEF_LABEL = 'Describe the work'
export const LOOP_BRIEF_HELP =
  'One sentence is enough — for example "fix all open issues one by one". The agent drafts the item list; you review it before anything runs.'
export const LOOP_BRIEF_ACTION = 'Draft items'
export const LOOP_BRIEF_BUSY = 'Drafting…'

/** Drafting produced nothing. Never silently becomes a one-item loop — running
 *  "fix all open issues" as a single task would spend real money looking like success. */
export const LOOP_BRIEF_EMPTY =
  "Couldn't turn that into a list of independent items. Try naming the work more concretely, or write the items yourself."

/**
 * What the planner actually saw, so the UI never implies it filtered issues it
 * could not read. A repo with no `gh`, no remote, or offline drafts blind.
 */
export function loopDraftContextNote(context: {
  issues: number
  pullRequests: number
  forgeAvailable: boolean
}): string {
  if (!context.forgeAvailable) {
    return 'Drafted without repository issues — GitHub was unavailable, so nothing was filtered out.'
  }
  const issues = context.issues === 1 ? '1 open issue' : `${context.issues} open issues`
  const prs = context.pullRequests === 1 ? '1 open PR' : `${context.pullRequests} open PRs`
  return `Drafted from ${issues}, skipping work already covered by ${prs}.`
}

export const loopDraftedCount = (count: number) =>
  count === 1 ? 'Drafted 1 item — review it before starting.' : `Drafted ${count} items — review them before starting.`

// ---- extending a loop that is already running ----------------------------------------------

export const LOOP_ADD_HEADING = 'Add more work'
export const LOOP_ADD_HELP =
  'New items go on the end as pending. Anything already running is untouched, and the loop picks them up when the current item finishes.'
export const LOOP_ADD_ACTION = 'Add items'
export const LOOP_ADD_BUSY = 'Adding…'
export const loopAddedCount = (count: number) =>
  count === 1 ? 'Added 1 item to the end of the loop.' : `Added ${count} items to the end of the loop.`

/** A completed loop that gains work starts again — said out loud, because the loop
 *  changing state under the user is otherwise a surprise. */
export const LOOP_ADD_REVIVED = 'This loop had finished, so it is running again.'
export const LOOP_ADD_STALE =
  'This loop changed while you were typing. Reload it and add the items again.'

// ---- landing policy (what a finished item leaves behind) ------------------------------------

import type { LoopLanding } from '@open-mercato/cezar-api-client'

export function loopLandingLabel(landing: LoopLanding): string {
  switch (landing) {
    case 'none':
      return 'Leave a branch'
    case 'pr':
      return 'Open a draft PR'
    case 'merge':
      return 'Open a PR and merge it when green'
  }
}

/**
 * What each choice actually does to the repository. `merge` is the only one that
 * lands code without a human looking at it, so its note says so plainly rather
 * than describing it as a convenience.
 */
export function loopLandingNote(landing: LoopLanding): string {
  switch (landing) {
    case 'none':
      return 'Each item ends as a branch you review and merge yourself. Nothing is pushed for you.'
    case 'pr':
      return 'Each item opens a draft PR when it finishes. You still review and merge every one.'
    case 'merge':
      return 'Each item opens a PR and cezar merges it once it is genuinely mergeable, so the next item starts from it. This overrides the review gate — an item whose PR cannot be merged in time is left open for you and the loop moves on.'
  }
}

/** Why the merge option is absent, naming the flag so the answer is actionable. */
export const LOOP_AUTO_MERGE_DISABLED =
  'Merging is unavailable: set CEZ_LOOP_AUTO_MERGE=1 and restart cezar to allow a loop to merge its own items.'

/** Header summary of what this loop does with finished work. */
export function loopLandingSummary(landing: LoopLanding | undefined): string {
  switch (landing ?? 'none') {
    case 'none':
      return 'Leaves a branch per item'
    case 'pr':
      return 'Opens a draft PR per item'
    case 'merge':
      return 'Opens a PR per item and merges it when green'
  }
}
