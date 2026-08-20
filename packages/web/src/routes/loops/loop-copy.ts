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
