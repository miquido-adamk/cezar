/**
 * Landing an item's work: open a PR, and — only when the loop opted in — merge it.
 *
 * This is the deliberate, per-loop reversal of AGENTS.md's "ends at a review gate
 * (never auto-merges)", and epic #771 lists auto-merging item work as out of scope.
 * It exists because draining a backlog is only unattended if item N+1 starts from a
 * base containing N. Every default here preserves the old behaviour: `landing`
 * absent means `none` means a branch, exactly as before.
 *
 * The forge work is INJECTED (`LoopLandingOps`) rather than imported, for two
 * reasons: `loops/` must not depend on `server/`, and merge behaviour has to be
 * testable without a GitHub remote, a `gh` binary, or a network.
 *
 * ## Why landing is a second wait, not a step
 *
 * A run finishing is not a PR being mergeable. Checks have not started yet when the
 * agent stops, so "merge if you can right now" would fail on essentially every item
 * and the feature would be decorative. Landing therefore becomes a second
 * non-terminal wait per item — and every non-terminal wait in this design needs a
 * deadline, or it is a state whose only exit is a human noticing. `LANDING_DEADLINE_MS`
 * is that bound; hitting it records `merge-blocked`, leaves the PR open for a human,
 * and lets the loop move on rather than stalling the whole backlog on one red build.
 */
import type { LoopLanding } from './types.ts';

/** How long a single item's PR may stay unmergeable before the loop gives up on it. */
export const LANDING_DEADLINE_MS = 30 * 60_000;

/** Merge method. Squash matches what the cockpit's own merge button defaults to. */
export const LANDING_MERGE_METHOD = 'squash';

export interface LoopLandingOps {
  /** Open a PR for a finished run. `false` when there was nothing to open one for. */
  openPr(runId: string): Promise<{ ok: true; number: number; url?: string } | { ok: false; reason: string }>;
  /** Current mergeability. `headSha` is required to merge safely. */
  mergeState(prNumber: number): Promise<{ canMerge: boolean; headSha?: string; reason?: string }>;
  /**
   * Merge it. `stale` distinguishes "the head moved under us" — which is a
   * retry-with-a-fresh-sha, not a failure — from a real refusal.
   */
  merge(
    prNumber: number,
    expectedHeadSha: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; stale?: boolean }>;
}

export type LandingOutcome =
  /** Nothing to do — `landing: 'none'`, or there was no diff to open a PR for. */
  | { kind: 'skip'; reason?: string }
  /** A PR exists and the loop is not asked to merge it. Terminal for this item. */
  | { kind: 'pr-open'; prNumber: number }
  /** A PR exists and must now be watched until mergeable. NOT terminal. */
  | { kind: 'awaiting-merge'; prNumber: number }
  /** The PR was opened but could not be created/merged; the item is done, badly. */
  | { kind: 'failed'; reason: string };

/**
 * Step one: turn a finished run into whatever the loop's policy asks for.
 *
 * Returns `awaiting-merge` rather than merging inline, because merging inline would
 * mean blocking the advance on CI.
 */
export async function openForLanding(
  landing: LoopLanding | undefined,
  runId: string,
  ops: LoopLandingOps,
): Promise<LandingOutcome> {
  if (!landing || landing === 'none') return { kind: 'skip' };
  const opened = await ops.openPr(runId);
  if (!opened.ok) {
    // A run with no diff is the ordinary case for a no-op item, not an error worth
    // pausing a backlog over — the reason is recorded and the loop continues.
    return { kind: 'failed', reason: opened.reason };
  }
  return landing === 'merge'
    ? { kind: 'awaiting-merge', prNumber: opened.number }
    : { kind: 'pr-open', prNumber: opened.number };
}

export type MergeAttempt =
  | { kind: 'merged' }
  /** Not yet mergeable, and still within the deadline. Check again later. */
  | { kind: 'waiting'; reason: string }
  /** Out of time, or refused for a reason waiting will not fix. */
  | { kind: 'blocked'; reason: string };

/**
 * Step two, called from the reconciling sweep: try to land the PR we are waiting on.
 *
 * `since`/`now` are passed in rather than read from the clock so the deadline is
 * testable, matching how the barrier's other deadlines work.
 */
export async function attemptMerge(
  prNumber: number,
  ops: LoopLandingOps,
  timing: { since: string; now: Date; deadlineMs?: number },
): Promise<MergeAttempt> {
  const deadlineMs = timing.deadlineMs ?? LANDING_DEADLINE_MS;
  const elapsed = timing.now.getTime() - new Date(timing.since).getTime();
  const outOfTime = Number.isFinite(elapsed) && elapsed >= deadlineMs;

  const state = await ops.mergeState(prNumber);
  if (!state.canMerge || !state.headSha) {
    const reason = state.reason ?? 'the pull request is not mergeable yet';
    // The deadline is only consulted once we know it is STILL not mergeable, so a
    // slow forge answer never converts a mergeable PR into a blocked one.
    return outOfTime
      ? { kind: 'blocked', reason: `${reason} after ${Math.round(deadlineMs / 60_000)} minutes` }
      : { kind: 'waiting', reason };
  }

  const merged = await ops.merge(prNumber, state.headSha);
  if (merged.ok) return { kind: 'merged' };
  if (merged.stale) {
    // `stale-head` means someone pushed between our read and our write. That is a
    // retry with a fresh sha, never a failure — reporting it as blocked would strand
    // a perfectly mergeable PR. One re-read, then leave it for the next sweep.
    const fresh = await ops.mergeState(prNumber);
    if (fresh.canMerge && fresh.headSha) {
      const again = await ops.merge(prNumber, fresh.headSha);
      if (again.ok) return { kind: 'merged' };
      return outOfTime
        ? { kind: 'blocked', reason: again.reason }
        : { kind: 'waiting', reason: again.reason };
    }
    return outOfTime ? { kind: 'blocked', reason: 'the head kept moving' } : { kind: 'waiting', reason: 'the head moved' };
  }
  // A refusal that waiting cannot fix (method disabled, permissions) is blocked
  // immediately rather than after 30 idle minutes of asking the same question.
  return { kind: 'blocked', reason: merged.reason };
}
