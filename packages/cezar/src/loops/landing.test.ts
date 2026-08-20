import { describe, expect, it, vi } from 'vitest';
import { attemptMerge, openForLanding, type LoopLandingOps } from './landing.ts';

/**
 * Landing is the one part of loops that writes to the repository, so the cases that
 * matter are the ones where it must NOT: a policy that never asked for a merge, a
 * deadline that has not passed, and a moved head that looks like a failure but is a
 * retry.
 */

const SINCE = '2026-08-20T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(SINCE) + minutes * 60_000);

function ops(over: Partial<LoopLandingOps> = {}): LoopLandingOps {
  return {
    openPr: vi.fn(async () => ({ ok: true as const, number: 7 })),
    mergeState: vi.fn(async () => ({ canMerge: true, headSha: 'a'.repeat(40) })),
    merge: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

describe('openForLanding', () => {
  it('does nothing at all when the loop asked for a branch', async () => {
    const o = ops();
    expect(await openForLanding('none', 'run-1', o)).toEqual({ kind: 'skip' });
    // The invariant-preserving default must not even talk to the forge.
    expect(o.openPr).not.toHaveBeenCalled();
  });

  it('treats an absent policy exactly as `none`, so old loops behave as before', async () => {
    const o = ops();
    expect(await openForLanding(undefined, 'run-1', o)).toEqual({ kind: 'skip' });
    expect(o.openPr).not.toHaveBeenCalled();
  });

  it('opens a PR and stops there for `pr`', async () => {
    const o = ops();
    expect(await openForLanding('pr', 'run-1', o)).toEqual({ kind: 'pr-open', prNumber: 7 });
    // `pr` must never merge — that is the whole distinction from `merge`.
    expect(o.merge).not.toHaveBeenCalled();
  });

  it('opens a PR and asks to be watched for `merge`', async () => {
    const o = ops();
    expect(await openForLanding('merge', 'run-1', o)).toEqual({ kind: 'awaiting-merge', prNumber: 7 });
    // Merging inline would block the advance on CI; it happens in the sweep instead.
    expect(o.merge).not.toHaveBeenCalled();
  });

  it('reports a PR that could not be opened without pausing anything', async () => {
    const o = ops({ openPr: vi.fn(async () => ({ ok: false as const, reason: 'no changes to submit' })) });
    expect(await openForLanding('merge', 'run-1', o)).toEqual({ kind: 'failed', reason: 'no changes to submit' });
  });
});

describe('attemptMerge', () => {
  it('merges with the sha it just read', async () => {
    const o = ops();
    expect(await attemptMerge(7, o, { since: SINCE, now: at(1) })).toEqual({ kind: 'merged' });
    expect(o.merge).toHaveBeenCalledWith(7, 'a'.repeat(40));
  });

  it('waits — not blocks — while checks are still running inside the deadline', async () => {
    const o = ops({ mergeState: vi.fn(async () => ({ canMerge: false, reason: 'checks are still running' })) });
    expect(await attemptMerge(7, o, { since: SINCE, now: at(5) })).toEqual({
      kind: 'waiting',
      reason: 'checks are still running',
    });
    expect(o.merge).not.toHaveBeenCalled();
  });

  it('blocks once the deadline passes, naming how long it waited', async () => {
    const o = ops({ mergeState: vi.fn(async () => ({ canMerge: false, reason: 'checks are failing' })) });
    const result = await attemptMerge(7, o, { since: SINCE, now: at(31) });
    if (result.kind !== 'blocked') throw new Error(`expected blocked, got ${result.kind}`);
    // A deadline nobody can see is a deadline nobody can act on.
    expect(result.reason).toContain('checks are failing');
    expect(result.reason).toContain('30 minutes');
  });

  it('never merges without a head sha, even when the forge says it could', async () => {
    // Merging blind is how you land the wrong commit.
    const o = ops({ mergeState: vi.fn(async () => ({ canMerge: true })) });
    const result = await attemptMerge(7, o, { since: SINCE, now: at(1) });
    expect(result.kind).toBe('waiting');
    expect(o.merge).not.toHaveBeenCalled();
  });

  it('retries a moved head with a fresh sha instead of calling it a failure', async () => {
    let call = 0;
    const o = ops({
      mergeState: vi.fn(async () => ({ canMerge: true, headSha: call === 0 ? 'a'.repeat(40) : 'b'.repeat(40) })),
      merge: vi.fn(async (_pr: number, sha: string) => {
        call++;
        return sha === 'b'.repeat(40) ? { ok: true as const } : { ok: false as const, reason: 'stale-head', stale: true };
      }),
    });
    expect(await attemptMerge(7, o, { since: SINCE, now: at(1) })).toEqual({ kind: 'merged' });
    expect(o.merge).toHaveBeenCalledTimes(2);
  });

  it('blocks a refusal that waiting cannot fix, without burning the deadline', async () => {
    const o = ops({ merge: vi.fn(async () => ({ ok: false as const, reason: 'squash merging is disabled' })) });
    // Asking the same disabled-method question for 30 minutes helps nobody.
    expect(await attemptMerge(7, o, { since: SINCE, now: at(1) })).toEqual({
      kind: 'blocked',
      reason: 'squash merging is disabled',
    });
  });

  it('honours an injected deadline, so the loop can be tested without waiting 30 minutes', async () => {
    const o = ops({ mergeState: vi.fn(async () => ({ canMerge: false, reason: 'pending' })) });
    const result = await attemptMerge(7, o, { since: SINCE, now: at(2), deadlineMs: 60_000 });
    expect(result.kind).toBe('blocked');
  });
});
