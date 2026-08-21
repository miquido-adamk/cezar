/**
 * The barrier's classification, including every non-terminal trap the spec
 * identifies. These are the cases that decide whether a loop advances correctly,
 * stalls forever, or — worst — advances while the previous child is still alive.
 */
import { describe, expect, it } from 'vitest';
import { AwaitRegistry, classify } from './barrier.ts';
import { LAUNCH_DEADLINE_MS, STALL_DEADLINE_MS } from './types.ts';
import type { RunRecord, RunStatus } from '../runs/store.ts';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    title: 'item',
    workflow: 'quick-task',
    task: 'item',
    status: 'running',
    createdAt: '2026-08-19T11:00:00.000Z',
    steps: [],
    ...overrides,
  } as RunRecord;
}

function agoMs(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('classify — terminal states', () => {
  it.each<RunStatus>(['done', 'review', 'cancelled', 'failed'])('treats %s as finished', (status) => {
    const verdict = classify({ run: run({ status }), awaitedSince: agoMs(60_000), now: NOW });
    expect(verdict).toEqual({ kind: 'finished', runStatus: status });
  });

  it('counts `review` as finished rather than waiting for a human', () => {
    // `review` is the terminal SUCCESS state of a gated run — headless `cezar run`
    // already exits 0 on it. Waiting for a human here would stall every loop on a
    // repo that has the review gate enabled.
    expect(classify({ run: run({ status: 'review' }), awaitedSince: agoMs(60_000), now: NOW }).kind).toBe('finished');
  });
});

describe('classify — the `failed` + autoResumeAt trap', () => {
  it('is NOT finished while a self-resume appointment is still in the future', () => {
    // The trap: a `failed` run with a pending auto-resume restarts itself. Calling
    // it terminal advances the loop and puts two live children in a width-1 loop.
    const verdict = classify({
      run: run({ status: 'failed', autoResumeAt: new Date(NOW.getTime() + 30 * 60_000).toISOString() }),
      awaitedSince: agoMs(60_000),
      now: NOW,
    });
    expect(verdict).toEqual({ kind: 'pending' });
  });

  it('is finished once the appointment has passed', () => {
    const verdict = classify({
      run: run({ status: 'failed', autoResumeAt: agoMs(60_000) }),
      awaitedSince: agoMs(120_000),
      now: NOW,
    });
    expect(verdict).toEqual({ kind: 'finished', runStatus: 'failed' });
  });

  it('is finished when the appointment is unparseable, rather than waiting forever', () => {
    const verdict = classify({
      run: run({ status: 'failed', autoResumeAt: 'not-a-date' as unknown as string }),
      awaitedSince: agoMs(60_000),
      now: NOW,
    });
    expect(verdict.kind).toBe('finished');
  });
});

describe('classify — waiting is not a trap', () => {
  it('leaves an ordinary `waiting` run pending', () => {
    // `waiting` IS bounded: armIdleTimer ends the session and it settles within
    // IDLE_TIMEOUT_MS. The spec corrected an earlier belief that this was a trap.
    expect(classify({ run: run({ status: 'waiting' }), awaitedSince: agoMs(60_000), now: NOW })).toEqual({
      kind: 'pending',
    });
  });
});

describe('classify — an open, unanswered ask', () => {
  it('needs input while the run is still waiting on it', () => {
    const verdict = classify({
      run: run({ status: 'waiting', openAsk: 'boolean flag or a new kind?' }),
      awaitedSince: agoMs(60_000),
      now: NOW,
    });
    expect(verdict).toEqual({
      kind: 'needs-input',
      reason: 'This item asked a question nobody has answered yet: "boolean flag or a new kind?"',
    });
  });

  it('needs input even once the run has settled — an idle-timeout close must not read as finished', () => {
    // `RunManager` reports a session the idle timer closed on an unanswered ask as
    // `failed`, but leaves `openAsk` set — the loop must still notice, not fall
    // through to the ordinary `finished` branch below.
    const verdict = classify({
      run: run({ status: 'failed', openAsk: 'boolean flag or a new kind?' }),
      awaitedSince: agoMs(20 * 60_000),
      now: NOW,
    });
    expect(verdict.kind).toBe('needs-input');
  });

  it('wins over an otherwise-terminal `done` — an ask answered by silence is not success', () => {
    const verdict = classify({ run: run({ status: 'done', openAsk: 'still open?' }), awaitedSince: agoMs(60_000), now: NOW });
    expect(verdict.kind).toBe('needs-input');
  });
});

describe('classify — the vanished-record trap', () => {
  it('blocks with `vanished` when the record is gone', () => {
    // pruneOldRuns deletes with no touch() and no emit, so this is reachable in
    // total silence — the reason the reconciling floor exists at all.
    const verdict = classify({ run: undefined, awaitedSince: agoMs(60_000), now: NOW });
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected blocked');
    expect(verdict.receiptStatus).toBe('vanished');
    expect(verdict.reason).toMatch(/no longer in the run index/);
  });
});

describe('classify — the never-started trap', () => {
  it('leaves a recently queued run pending', () => {
    expect(classify({ run: run({ status: 'queued' }), awaitedSince: agoMs(60_000), now: NOW })).toEqual({
      kind: 'pending',
    });
  });

  it('blocks with `never-started` past the launch deadline', () => {
    const verdict = classify({
      run: run({ status: 'queued' }),
      awaitedSince: agoMs(LAUNCH_DEADLINE_MS + 60_000),
      now: NOW,
    });
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected blocked');
    expect(verdict.receiptStatus).toBe('never-started');
    expect(verdict.reason).toMatch(/still queued/);
  });

  it('stays pending with no awaitedSince, rather than guessing a deadline', () => {
    expect(classify({ run: run({ status: 'queued' }), awaitedSince: undefined, now: NOW })).toEqual({ kind: 'pending' });
  });
});

describe('classify — the monitoring stall trap', () => {
  it('leaves a recently monitoring run pending', () => {
    const verdict = classify({
      run: run({ status: 'running', activity: 'monitoring' }),
      awaitedSince: agoMs(60_000),
      now: NOW,
    });
    expect(verdict).toEqual({ kind: 'pending' });
  });

  it('blocks with `stalled` past the stall deadline, and explains why it pauses', () => {
    const verdict = classify({
      run: run({ status: 'running', activity: 'monitoring' }),
      awaitedSince: agoMs(STALL_DEADLINE_MS + 60_000),
      now: NOW,
    });
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected blocked');
    expect(verdict.receiptStatus).toBe('stalled');
    // The Q5 decision, asserted in the user-visible reason: pause, do not advance.
    expect(verdict.reason).toMatch(/two items in flight/);
  });

  it('does not stall a plain long-running run that is not monitoring', () => {
    // A run legitimately working for hours must not be declared stalled — only the
    // `monitoring` sub-state clears the idle timer.
    expect(
      classify({ run: run({ status: 'running' }), awaitedSince: agoMs(STALL_DEADLINE_MS + 60_000), now: NOW }),
    ).toEqual({ kind: 'pending' });
  });
});

describe('AwaitRegistry', () => {
  it('maps runs to loops in both directions', () => {
    const registry = new AwaitRegistry();
    registry.await_('loop-a', 'run-1');
    expect(registry.loopAwaiting('run-1')).toBe('loop-a');
    expect(registry.awaitedRun('loop-a')).toBe('run-1');
    expect(registry.awaitedRunIds()).toEqual(['run-1']);
  });

  it('drops the previous run when a loop advances', () => {
    const registry = new AwaitRegistry();
    registry.await_('loop-a', 'run-1');
    registry.await_('loop-a', 'run-2');
    expect(registry.loopAwaiting('run-1')).toBeUndefined();
    expect(registry.loopAwaiting('run-2')).toBe('loop-a');
    expect(registry.awaitedRunIds()).toEqual(['run-2']);
  });

  it('forgets a loop entirely', () => {
    const registry = new AwaitRegistry();
    registry.await_('loop-a', 'run-1');
    registry.forgetLoop('loop-a');
    expect(registry.awaitedRun('loop-a')).toBeUndefined();
    expect(registry.loopAwaiting('run-1')).toBeUndefined();
  });

  it('reports a status change once and suppresses repeats', () => {
    // The store emits on EVERY mutation, so without this diff the barrier would
    // reclassify and rewrite receipts dozens of times per second for one busy run.
    const registry = new AwaitRegistry();
    expect(registry.observe('run-1', 'running')).toBe(true);
    expect(registry.observe('run-1', 'running')).toBe(false);
    expect(registry.observe('run-1', 'running')).toBe(false);
    expect(registry.observe('run-1', 'done')).toBe(true);
  });

  it('re-reports the first status after a re-await, so a reused id is not swallowed', () => {
    const registry = new AwaitRegistry();
    registry.await_('loop-a', 'run-1');
    expect(registry.observe('run-1', 'running')).toBe(true);
    registry.await_('loop-a', 'run-2');
    registry.await_('loop-a', 'run-1');
    expect(registry.observe('run-1', 'running')).toBe(true);
  });
});
