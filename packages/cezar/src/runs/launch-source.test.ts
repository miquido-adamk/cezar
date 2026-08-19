/**
 * Phase 0 of spec `.ai/specs/2026-08-19-task-loops.md` — the source-neutral launch
 * adapter. The two cases that matter are not "does it start a run" but the two
 * durability rules the adapter exists to enforce: provenance is on the record the
 * FIRST time anyone can observe it, and the record is flushed before the caller
 * is told the launch succeeded.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from './store.ts';
import { buildStartRunInput, launchFromSource, resolveLaunchWorkflow, type LaunchTemplate } from './launch-source.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';

let dir: string;
let store: RunStore;

const LOOP_PROVENANCE = {
  loopId: 'loop-1',
  revision: 1,
  receiptId: 'loop-1:1:item-a',
  itemId: 'item-a',
  itemIndex: 0,
  trigger: 'loop' as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-launch-source-'));
  store = RunStore.open(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A manager stub that only does what the adapter needs: create a record via the
 *  real store, so provenance and flushing are exercised against real persistence. */
function managerStub(): { manager: RunManager; started: RunRecord[] } {
  const started: RunRecord[] = [];
  const startRun = (workflow: WorkflowDef, input: StartRunInput): RunRecord => {
    const run = store.createRun({
      title: input.task.slice(0, 40),
      workflow: workflow.name,
      task: input.task,
      automation: input.provenance?.automation,
      loop: input.provenance?.loop,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.id, kind: 'agent' as const })),
    });
    started.push(run);
    return run;
  };
  const manager = {
    startRun,
    startVariants: (workflow: WorkflowDef, input: StartRunInput, count: number) =>
      Array.from({ length: count }, () => startRun(workflow, input)),
  } as unknown as RunManager;
  return { manager, started };
}

const template: LaunchTemplate = {
  prompt: 'fix the flaky test',
  steps: [{ id: 'task', prompt: '{{task}}' }],
  autonomous: true,
};

describe('resolveLaunchWorkflow', () => {
  it('builds the "(planned)" shape from inline steps', async () => {
    const workflow = await resolveLaunchWorkflow(dir, template);
    expect(workflow.name).toBe('(planned)');
    expect(workflow.source).toBe('built-in');
    expect(workflow.steps).toHaveLength(1);
  });

  it('throws on an unknown named workflow rather than falling back to quick-task', async () => {
    // A source naming a workflow the repo no longer has is a config error its
    // receipt must record — silently downgrading would run the wrong thing.
    await expect(resolveLaunchWorkflow(dir, { prompt: 'x', workflow: 'no-such-workflow' })).rejects.toThrow(
      /unknown workflow: no-such-workflow/,
    );
  });

  it('resolves the built-in quick-task when no workflow is named', async () => {
    const workflow = await resolveLaunchWorkflow(dir, { prompt: 'x' });
    expect(workflow.name).toBe('quick-task');
  });
});

describe('buildStartRunInput', () => {
  it('carries the prompt as `task` and passes provenance through', () => {
    const input = buildStartRunInput(template, { loop: LOOP_PROVENANCE });
    expect(input.task).toBe('fix the flaky test');
    expect(input.autonomous).toBe(true);
    expect(input.provenance?.loop).toEqual(LOOP_PROVENANCE);
  });

  it('does not invent a task, images or todoId key', () => {
    const input = buildStartRunInput({ prompt: 'p' }, {});
    expect('images' in input).toBe(false);
    expect('todoId' in input).toBe(false);
  });
});

describe('launchFromSource', () => {
  it('writes provenance at construction, so the first observable record already has it', async () => {
    const { manager, started } = managerStub();
    // Subscribe BEFORE launching and capture provenance as of the first event:
    // this is what a barrier attributing runs in real time actually sees.
    const provenanceAtFirstEvent: Array<RunRecord['loop']> = [];
    store.on('run', (run: RunRecord) => provenanceAtFirstEvent.push(run.loop));

    const { runId } = await launchFromSource({ root: dir, manager, store, template, provenance: { loop: LOOP_PROVENANCE } });

    expect(started).toHaveLength(1);
    expect(runId).toBe(started[0]!.id);
    expect(store.getRun(runId)?.loop).toEqual(LOOP_PROVENANCE);
    // The regression this module exists to prevent: had provenance been patched on
    // after startRun (the automation path's shape), the first event would carry
    // `undefined` and a barrier would fail to attribute its own run.
    expect(provenanceAtFirstEvent[0]).toEqual(LOOP_PROVENANCE);
    expect(provenanceAtFirstEvent.every((value) => value !== undefined)).toBe(true);
  });

  it('flushes runs.json synchronously, so a crash cannot lose a paid-for run', async () => {
    const { manager } = managerStub();
    const { runId } = await launchFromSource({ root: dir, manager, store, template, provenance: { loop: LOOP_PROVENANCE } });

    // No timer advance, no store.flush() of our own: the file must be on disk with
    // this run in it the instant launchFromSource resolves, because saves are debounced.
    const indexPath = join(dir, 'runs.json');
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, 'utf8')).toContain(runId);
  });

  it('returns the first run for a variant launch and provenances every variant', async () => {
    const { manager, started } = managerStub();
    const result = await launchFromSource({
      root: dir,
      manager,
      store,
      template: { ...template, variants: 3 },
      provenance: { loop: LOOP_PROVENANCE },
    });

    expect(started).toHaveLength(3);
    expect(result.runIds).toHaveLength(3);
    expect(result.runId).toBe(started[0]!.id);
    for (const run of started) expect(run.loop).toEqual(LOOP_PROVENANCE);
  });

  it('propagates a workflow-resolution failure instead of starting a run', async () => {
    const { manager, started } = managerStub();
    await expect(
      launchFromSource({
        root: dir,
        manager,
        store,
        template: { prompt: 'x', workflow: 'nope' },
        provenance: { loop: LOOP_PROVENANCE },
      }),
    ).rejects.toThrow(/unknown workflow/);
    expect(started).toHaveLength(0);
  });
});

describe('RunRecord.loop provenance', () => {
  it('is optional, so a runs.json written before loops existed still parses', () => {
    // The additive-safety rule for every new RunRecord field.
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    expect(run.loop).toBeUndefined();
    store.flush();
    const reopened = RunStore.open(dir);
    expect(reopened.getRun(run.id)).toBeDefined();
    expect(reopened.getRun(run.id)?.loop).toBeUndefined();
  });
});
