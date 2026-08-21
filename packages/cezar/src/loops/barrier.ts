/**
 * The completion barrier (spec `.ai/specs/2026-08-19-task-loops.md`).
 *
 * One question, asked per store event: *is the run this loop awaits finished, and
 * if not, is it still plausibly going to finish?*
 *
 * A scheduled task fires when the clock strikes. A loop fires when the previous
 * run finishes — so where a scheduler owns a timer, this owns a classification.
 * Everything subtle here comes from two properties of the run store:
 *
 * 1. **There is no terminal event.** The store emits `run` on every mutation via
 *    `touch()`, so the barrier keeps an O(1) map from awaited run id to loop and
 *    diffs against its own last-seen status. It never scans the run list.
 * 2. **A store event is necessary but not sufficient.** Three paths end an awaited
 *    run's life without a usable event, each verified in the store:
 *      - `pruneOldRuns` deletes with NO `touch()` and no emit — the awaited run
 *        can vanish in total silence.
 *      - `deleteRun` emits `'deleted'`, a second event name entirely.
 *      - A `queued` run can wait indefinitely when its agent account is held.
 *
 * Hence: event-driven, with a low-frequency reconciling floor. The floor is not a
 * poller in disguise — it never advances a loop on its own; it only converts
 * silence into a named, durable classification.
 */
import {
  LAUNCH_DEADLINE_MS,
  STALL_DEADLINE_MS,
  type LoopReceiptStatus,
} from './types.ts';
import type { RunRecord, RunStatus } from '../runs/store.ts';

/**
 * What the barrier concludes about one awaited run.
 *
 * - `pending`     — still legitimately working; nothing to do.
 * - `finished`    — reached a terminal state; the loop may advance.
 * - `blocked`     — will not finish on its own; the loop pauses and settles the receipt,
 *                   because there is nothing left to wait FOR (the run is presumed lost —
 *                   `skip-current` is the only supported way past it).
 * - `needs-input` — the run asked a real question nobody has answered yet. Unlike
 *                   `blocked`, the run is not lost: pausing here does NOT resolve the
 *                   receipt or stop awaiting it, because answering the question in the
 *                   run's own task thread lets this SAME run finish normally, and the
 *                   next event will settle it the ordinary way once it does.
 */
export type BarrierVerdict =
  | { kind: 'pending' }
  | { kind: 'finished'; runStatus: RunStatus }
  | { kind: 'blocked'; receiptStatus: Extract<LoopReceiptStatus, 'stalled' | 'vanished' | 'never-started'>; reason: string }
  | { kind: 'needs-input'; reason: string };

/**
 * Run statuses that end an item.
 *
 * `review` counts as finished on purpose: it is the terminal success state of a
 * gated run, and headless `cezar run` already treats it as exit 0. `failed` is
 * NOT in this set unconditionally — see `classify`, because a `failed` run may
 * hold an appointment to resume itself.
 */
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['done', 'review', 'cancelled']);

/**
 * Classify the awaited run.
 *
 * `now` is injected rather than read from the clock so the deadline branches are
 * testable without waiting hours.
 */
export function classify(input: {
  run: RunRecord | undefined;
  awaitedSince: string | undefined;
  now: Date;
}): BarrierVerdict {
  const { run, now } = input;

  // The record is gone. `pruneOldRuns` deletes without emitting, so this is
  // reachable in total silence and is exactly why the reconciling floor exists.
  if (!run) {
    return {
      kind: 'blocked',
      receiptStatus: 'vanished',
      reason: 'The run this item was waiting on is no longer in the run index. It was most likely pruned by run-history retention.',
    };
  }

  // A real, unanswered question is always a human's call — checked before every status
  // branch below, and it wins regardless of what they say: a `waiting` run holding one is
  // not "still working" (the fall-through `pending` at the bottom would wait on it
  // forever, silently, with no reason shown), and a run the idle timer closed BECAUSE it
  // went unanswered (`RunManager.setOpenAsk`, `armIdleTimer`) must not read as an ordinary
  // `finished`/failed either — both need the loop to say so and stop rather than either
  // silently waiting or moving on as if the item were actually settled.
  if (run.openAsk) {
    return { kind: 'needs-input', reason: `This item asked a question nobody has answered yet: "${run.openAsk}"` };
  }

  // A `failed` run with a pending self-resume appointment is NOT finished. Treating
  // it as terminal is how a width-1 loop ends up with two live children: the next
  // item launches while this run restarts itself on its own timer.
  if (run.status === 'failed' && run.autoResumeAt) {
    const resumesAt = Date.parse(run.autoResumeAt);
    if (Number.isFinite(resumesAt) && resumesAt > now.getTime()) return { kind: 'pending' };
  }

  if (TERMINAL_RUN_STATUSES.has(run.status)) return { kind: 'finished', runStatus: run.status };
  if (run.status === 'failed') return { kind: 'finished', runStatus: run.status };

  const waitingMs = elapsedSince(input.awaitedSince, now);

  // Never started. A queued run whose agent account is held is skipped by the
  // scheduler indefinitely, so "queued" alone is not evidence of progress.
  if (run.status === 'queued' && waitingMs !== undefined && waitingMs > LAUNCH_DEADLINE_MS) {
    return {
      kind: 'blocked',
      receiptStatus: 'never-started',
      reason: `The run for this item was still queued ${formatDuration(waitingMs)} after it was created, so it never actually started. A held agent account or a full parallelism budget is the usual cause.`,
    };
  }

  // Stalled. `monitoring` deliberately clears the idle timer, so without a
  // deadline of our own this branch is an unbounded wait — the spec's Q5 answer is
  // to pause the loop and surface it rather than advance (two live children) or
  // cancel (destroys possibly-good work).
  if (run.activity === 'monitoring' && waitingMs !== undefined && waitingMs > STALL_DEADLINE_MS) {
    return {
      kind: 'blocked',
      receiptStatus: 'stalled',
      reason: `The run for this item has been monitoring its own downstream work for ${formatDuration(waitingMs)} without finishing. The loop is paused rather than advancing, because the run is still alive and advancing would put two items in flight at once.`,
    };
  }

  return { kind: 'pending' };
}

function elapsedSince(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return undefined;
  return Math.max(0, now.getTime() - started);
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Tracks which run each loop awaits, so a store event costs a map lookup rather
 * than a scan of the run list.
 *
 * Deliberately holds no store reference and performs no IO: it is the bookkeeping
 * half of the barrier, and keeping it pure is what makes the classification above
 * testable without a server.
 */
export class AwaitRegistry {
  private readonly loopByRun = new Map<string, string>();
  private readonly runByLoop = new Map<string, string>();
  private readonly lastStatus = new Map<string, RunStatus>();

  /** Start awaiting `runId` for `loopId`, replacing any previous await for it. */
  await_(loopId: string, runId: string): void {
    const previous = this.runByLoop.get(loopId);
    if (previous && previous !== runId) {
      this.loopByRun.delete(previous);
      this.lastStatus.delete(previous);
    }
    this.runByLoop.set(loopId, runId);
    this.loopByRun.set(runId, loopId);
  }

  forgetLoop(loopId: string): void {
    const runId = this.runByLoop.get(loopId);
    if (runId) {
      this.loopByRun.delete(runId);
      this.lastStatus.delete(runId);
    }
    this.runByLoop.delete(loopId);
  }

  loopAwaiting(runId: string): string | undefined {
    return this.loopByRun.get(runId);
  }

  awaitedRun(loopId: string): string | undefined {
    return this.runByLoop.get(loopId);
  }

  awaitedRunIds(): string[] {
    return [...this.loopByRun.keys()];
  }

  /**
   * Record a status observation, reporting whether it actually changed.
   *
   * The store emits on every mutation — a token count, a step delta — so without
   * this diff the barrier would re-run its classification and re-write receipts
   * dozens of times per second for a single busy run.
   */
  observe(runId: string, status: RunStatus): boolean {
    const previous = this.lastStatus.get(runId);
    if (previous === status) return false;
    this.lastStatus.set(runId, status);
    return true;
  }
}
