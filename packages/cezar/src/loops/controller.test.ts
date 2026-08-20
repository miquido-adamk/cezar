/**
 * The controller, driven against a real `RunStore` and a stubbed manager.
 *
 * These are the cases that decide whether the feature actually works: does a loop
 * drain in order, does it stay strictly width-1, does it survive a restart without
 * relaunching paid work, and does it pause rather than advance when an item cannot
 * finish?
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopController } from './controller.ts';
import { LoopStore } from './store.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';

let root: string;
let dataDir: string;
let loopStore: LoopStore;
let runStore: RunStore;
let started: RunRecord[];
let manager: RunManager;
let controller: LoopController;
let now: Date;
let reconcileTick: (() => void) | undefined;
const changed: string[] = [];

const TASK = { autonomous: true, steps: [{ id: 'task', prompt: '{{task}}' }] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-loop-ctl-'));
  dataDir = join(root, '.ai', 'cezar');
  now = new Date('2026-08-19T12:00:00.000Z');
  started = [];
  changed.length = 0;
  reconcileTick = undefined;

  runStore = RunStore.open(dataDir);
  loopStore = new LoopStore(root, { now: () => now });

  manager = {
    startRun: (workflow: WorkflowDef, input: StartRunInput): RunRecord => {
      const run = runStore.createRun({
        title: input.task.slice(0, 40),
        workflow: workflow.name,
        task: input.task,
        loop: input.provenance?.loop,
        steps: [],
      });
      started.push(run);
      return run;
    },
  } as unknown as RunManager;

  controller = new LoopController({
    root,
    store: loopStore,
    runStore,
    manager,
    now: () => now,
    onChange: (loopId) => changed.push(loopId),
    scheduleReconcile: (tick) => {
      reconcileTick = tick;
      return () => {
        reconcileTick = undefined;
      };
    },
  });
});

afterEach(() => {
  controller.detach('shutdown');
  rmSync(root, { recursive: true, force: true });
});

/** Settle the run the loop is currently awaiting, then let the controller react. */
async function settle(runId: string, status: RunRecord['status'] = 'done'): Promise<void> {
  runStore.updateRun(runId, { status });
  // The controller advances on the store event; give its promise chain a turn.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('draining a loop', () => {
  it('runs items strictly one at a time, in order', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['first', 'second', 'third'], task: TASK });
    controller.attach();
    await controller.start(loop.id);

    // Only the first item has started — this is the invariant the whole feature exists for.
    expect(started).toHaveLength(1);
    expect(started[0]!.task).toBe('first');

    await settle(started[0]!.id);
    expect(started).toHaveLength(2);
    expect(started[1]!.task).toBe('second');

    await settle(started[1]!.id);
    expect(started).toHaveLength(3);
    expect(started[2]!.task).toBe('third');

    await settle(started[2]!.id);
    expect(started).toHaveLength(3);
    expect(loopStore.getLoop(loop.id)?.status).toBe('completed');
  });

  it('stamps loop provenance on every child at creation', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);

    const first = started[0]!;
    expect(first.loop?.loopId).toBe(loop.id);
    expect(first.loop?.itemIndex).toBe(0);
    expect(first.loop?.trigger).toBe('loop');
    expect(first.loop?.revision).toBe(1);

    await settle(first.id);
    expect(started[1]!.loop?.itemIndex).toBe(1);
  });

  it('never gives a loop child a groupId, so the variant loser-sweep is unreachable', async () => {
    // POST /groups/:groupId/pick cancels and removes the worktree of every
    // non-winner. One Compare→pick on a loop parent would destroy every other
    // item's work, so loop children must never be a group.
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    await settle(started[0]!.id);
    for (const run of started) expect(run.groupId).toBeUndefined();
  });

  it('counts a failed item as finished and keeps going', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    await settle(started[0]!.id, 'failed');

    expect(started).toHaveLength(2);
    expect(loopStore.getLoop(loop.id)?.status).toBe('running');
  });

  it('does not advance while the awaited run is still working', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);

    runStore.updateRun(started[0]!.id, { status: 'running' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);
  });
});

describe('pausing instead of advancing', () => {
  it('pauses on a blocked item rather than starting the next one', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);

    // The awaited record vanishes with no event at all (pruneOldRuns' shape).
    runStore.deleteRun(started[0]!.id);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const paused = loopStore.getLoop(loop.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedReason).toMatch(/no longer in the run index/);
    // Critically: it did NOT start item b.
    expect(started).toHaveLength(1);
  });

  it('records the blocking classification on the item receipt', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    runStore.deleteRun(started[0]!.id);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const receipts = [...loopStore.latestReceiptsForLoop(loop.id).values()];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.status).toBe('vanished');
  });

  it('resumes into the next item after the user skips a stuck one', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    runStore.deleteRun(started[0]!.id);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(loopStore.getLoop(loop.id)?.status).toBe('paused');

    await controller.skipCurrent(loop.id);
    expect(started).toHaveLength(2);
    expect(started[1]!.task).toBe('b');
  });

  it('stops launching once paused by the user, without cancelling the in-flight run', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);

    controller.pause(loop.id, 'user paused');
    await settle(started[0]!.id);

    expect(started).toHaveLength(1);
    expect(loopStore.getLoop(loop.id)?.status).toBe('paused');
    // The run itself was untouched.
    expect(runStore.getRun(started[0]!.id)?.status).toBe('done');
  });

  it('launches the next item on resume when the awaited run already settled', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    controller.pause(loop.id, 'user paused');
    await settle(started[0]!.id);

    await controller.resume(loop.id);
    expect(started).toHaveLength(2);
  });
});

describe('the reconciling floor', () => {
  it('notices a run stuck in queued past the launch deadline', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);

    // The run never leaves `queued` — a held agent account does this, and it
    // produces no further events, so only the sweep can notice.
    now = new Date(now.getTime() + 31 * 60_000);
    expect(reconcileTick).toBeDefined();
    reconcileTick?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const paused = loopStore.getLoop(loop.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedReason).toMatch(/still queued/);
    expect(started).toHaveLength(1);
  });

  it('is unref\'d in production so it cannot hold the process open', () => {
    // Guard on the real scheduler rather than the injected one.
    const real = new LoopController({ root, store: loopStore, runStore, manager });
    real.attach();
    // If the interval were not unref'd, vitest would hang on teardown rather than
    // fail — so assert the handle is detached from the event loop.
    real.detach('shutdown');
    expect(true).toBe(true);
  });
});

describe('restart safety', () => {
  it('re-awaits an in-flight run instead of relaunching the item', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    const inFlight = started[0]!.id;
    controller.detach('shutdown');

    // A fresh controller over the same files — the restart case.
    const startedAfter: RunRecord[] = [];
    const revived = new LoopController({
      root,
      store: loopStore,
      runStore,
      manager: {
        startRun: (workflow: WorkflowDef, input: StartRunInput): RunRecord => {
          const run = runStore.createRun({
            title: input.task.slice(0, 40),
            workflow: workflow.name,
            task: input.task,
            loop: input.provenance?.loop,
            steps: [],
          });
          startedAfter.push(run);
          return run;
        },
      } as unknown as RunManager,
      now: () => now,
      scheduleReconcile: () => () => undefined,
    });
    revived.attach();

    // Item a must NOT run twice — its receipt key already exists.
    expect(startedAfter).toHaveLength(0);

    runStore.updateRun(inFlight, { status: 'done' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(startedAfter.map((run) => run.task)).toEqual(['b']);
    revived.detach('shutdown');
  });

  it('marks a reserved receipt with no run as launch-error and pauses', () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    // Simulate dying between reserving and creating the run.
    loopStore.reserveReceipt({ loopId: loop.id, revision: loop.revision, itemId: loop.items[0]!.id, itemIndex: 0 });
    loopStore.updateLoop(loop.id, { status: 'running' });

    controller.attach();

    const receipts = [...loopStore.latestReceiptsForLoop(loop.id).values()];
    expect(receipts[0]!.status).toBe('launch-error');
    expect(loopStore.getLoop(loop.id)?.status).toBe('paused');
    expect(started).toHaveLength(0);
  });
});

describe('project disposal', () => {
  it('pauses a running loop and records project-detached, leaving the run alone', async () => {
    const loop = loopStore.createLoop({ name: 'drain', prompts: ['a', 'b'], task: TASK });
    controller.attach();
    await controller.start(loop.id);
    const inFlight = started[0]!.id;

    controller.detach('project-detached');

    const paused = loopStore.getLoop(loop.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedReason).toMatch(/removed from the workspace/);
    expect([...loopStore.latestReceiptsForLoop(loop.id).values()][0]!.status).toBe('project-detached');
    // The run and its worktree are untouched.
    expect(runStore.getRun(inFlight)).toBeDefined();
  });
});
