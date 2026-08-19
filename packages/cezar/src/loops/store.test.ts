/**
 * Loop persistence. The cases that matter are the ones that protect against
 * losing or double-spending paid agent work: receipt idempotency, per-entry
 * salvage, and the revision rules that decide when an item set may change.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopStore, LOOPS_FILE, LOOP_RECEIPTS_FILE } from './store.ts';
import { receiptKeyFor } from './types.ts';

let root: string;
let store: LoopStore;
let warnings: string[];

const TASK = { autonomous: true };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-loops-'));
  warnings = [];
  store = new LoopStore(root, { warn: (message) => warnings.push(message) });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dataPath(file: string): string {
  return join(root, '.ai', 'cezar', file);
}

function writeRaw(file: string, contents: string): void {
  mkdirSync(join(root, '.ai', 'cezar'), { recursive: true });
  writeFileSync(dataPath(file), contents);
}

describe('definitions', () => {
  it('reads as empty and reports no definitions before anything is written', () => {
    // A project that has never used loops must be cheap and safe to probe.
    expect(store.hasDefinitions()).toBe(false);
    expect(store.listLoops()).toEqual([]);
    expect(store.listStates()).toEqual([]);
    expect(store.listReceipts()).toEqual([]);
  });

  it('creates a loop with generated item ids, so duplicate prompts stay distinct', () => {
    const loop = store.createLoop({ name: 'drain', prompts: ['same', 'same'], task: TASK });
    expect(loop.revision).toBe(1);
    expect(loop.status).toBe('idle');
    expect(loop.items).toHaveLength(2);
    expect(loop.items[0]!.id).not.toBe(loop.items[1]!.id);
    expect(store.hasDefinitions()).toBe(true);
    expect(store.getLoop(loop.id)?.name).toBe('drain');
  });

  it('writes the definitions file at 0600', () => {
    store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    // eslint-disable-next-line no-bitwise
    const mode = require('node:fs').statSync(dataPath(LOOPS_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('salvages per entry, so one unreadable loop does not evict the others', () => {
    const good = store.createLoop({ name: 'good', prompts: ['a'], task: TASK });
    const parsed = JSON.parse(readFileSync(dataPath(LOOPS_FILE), 'utf8'));
    parsed.loops.push({ id: 'broken', name: 42 });
    writeRaw(LOOPS_FILE, JSON.stringify(parsed));

    const loops = store.listLoops();
    expect(loops.map((loop) => loop.id)).toEqual([good.id]);
    expect(warnings.some((message) => message.includes('unreadable loop definition'))).toBe(true);
  });

  it('ignores an unparseable definitions file instead of throwing', () => {
    writeRaw(LOOPS_FILE, '{ not json');
    expect(store.listLoops()).toEqual([]);
    expect(warnings.some((message) => message.includes('unparseable'))).toBe(true);
  });
});

describe('revision rules', () => {
  it('bumps the revision when the item set changes', () => {
    const loop = store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    const result = store.updateLoop(loop.id, { items: [{ id: 'i1', prompt: 'b' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.revision).toBe(2);
  });

  it('does NOT bump the revision on a status-only transition', () => {
    // Receipt keys are derived from the revision, so bumping it on a pause would
    // orphan the in-flight item's receipt key and let it relaunch.
    const loop = store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    const result = store.updateLoop(loop.id, { status: 'paused', pausedReason: 'user paused' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.revision).toBe(1);
    expect(result.definition.pausedReason).toBe('user paused');
  });

  it('can clear pausedReason with an explicit undefined', () => {
    const loop = store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    store.updateLoop(loop.id, { status: 'paused', pausedReason: 'stalled' });
    const resumed = store.updateLoop(loop.id, { status: 'running', pausedReason: undefined });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.definition.pausedReason).toBeUndefined();
  });

  it('rejects a stale edit with revision-mismatch', () => {
    const loop = store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    store.updateLoop(loop.id, { items: [{ id: 'i1', prompt: 'b' }] });
    const stale = store.updateLoop(loop.id, { items: [{ id: 'i2', prompt: 'c' }] }, 1);
    expect(stale).toEqual({ ok: false, reason: 'revision-mismatch' });
  });

  it('accepts an edit carrying the current revision', () => {
    const loop = store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    const fresh = store.updateLoop(loop.id, { name: 'renamed' }, 1);
    expect(fresh.ok).toBe(true);
  });

  it('reports not-found for an unknown loop', () => {
    expect(store.updateLoop('nope', { name: 'x' })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('deletes a loop and its cursor together', () => {
    const loop = store.createLoop({ name: 'drain', prompts: ['a'], task: TASK });
    store.putState({ loopId: loop.id, revision: 1, status: 'running', completedCount: 0, skippedCount: 0 });
    expect(store.deleteLoop(loop.id)).toBe(true);
    expect(store.getLoop(loop.id)).toBeUndefined();
    expect(store.getState(loop.id)).toBeUndefined();
    expect(store.deleteLoop(loop.id)).toBe(false);
  });
});

describe('runtime state', () => {
  it('merge-writes one cursor without disturbing another loop', () => {
    store.putState({ loopId: 'a', revision: 1, status: 'running', completedCount: 1, skippedCount: 0 });
    store.putState({ loopId: 'b', revision: 1, status: 'paused', completedCount: 0, skippedCount: 2 });
    store.putState({ loopId: 'a', revision: 1, status: 'completed', completedCount: 5, skippedCount: 0 });

    expect(store.getState('a')?.status).toBe('completed');
    expect(store.getState('a')?.completedCount).toBe(5);
    expect(store.getState('b')?.status).toBe('paused');
    expect(store.getState('b')?.skippedCount).toBe(2);
  });

  it('rebuilds from empty when the cursor file is corrupt, rather than throwing', () => {
    writeRaw('loop-state.json', '{ nope');
    expect(store.listStates()).toEqual([]);
  });
});

describe('receipts', () => {
  it('reserves once per (loop, revision, item) and is idempotent afterwards', () => {
    // The rule that makes a restart-time relaunch impossible for an item that
    // already launched.
    const first = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    expect(first.created).toBe(true);
    expect(first.receipt.status).toBe('reserved');
    expect(first.receipt.receiptKey).toBe(receiptKeyFor('l1', 1, 'i1'));

    const second = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    expect(second.created).toBe(false);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
  });

  it('returns the resolved row on re-reserve, so a completed item never relaunches', () => {
    const { receipt } = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    store.resolveReceipt(receipt.receiptId, { status: 'completed', runId: 'run-1' });

    const again = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    expect(again.created).toBe(false);
    expect(again.receipt.status).toBe('completed');
  });

  it('reserves separately for a new revision of the same item id', () => {
    store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    const next = store.reserveReceipt({ loopId: 'l1', revision: 2, itemId: 'i1', itemIndex: 0 });
    expect(next.created).toBe(true);
  });

  it('appends latest-state rows and reads the newest as current', () => {
    const { receipt } = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    store.resolveReceipt(receipt.receiptId, { status: 'completed', runId: 'run-1', reason: 'done' });

    expect(store.listReceipts()).toHaveLength(2);
    const latest = store.latestReceipts().get(receipt.receiptId);
    expect(latest?.status).toBe('completed');
    expect(latest?.runId).toBe('run-1');
    expect(latest!.seq).toBeGreaterThan(receipt.seq);
  });

  it('never stores prompt text in a receipt', () => {
    // The receipt log is long-lived; copying prompts in would triple the places a
    // pasted secret has to be redacted.
    store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    expect(readFileSync(dataPath(LOOP_RECEIPTS_FILE), 'utf8')).not.toMatch(/prompt/);
  });

  it('keys latest receipts by item for one loop', () => {
    const a = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    const b = store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i2', itemIndex: 1 });
    store.reserveReceipt({ loopId: 'other', revision: 1, itemId: 'i1', itemIndex: 0 });
    store.resolveReceipt(a.receipt.receiptId, { status: 'completed' });

    const byItem = store.latestReceiptsForLoop('l1', 1);
    expect([...byItem.keys()].sort()).toEqual(['i1', 'i2']);
    expect(byItem.get('i1')?.status).toBe('completed');
    expect(byItem.get('i2')?.receiptId).toBe(b.receipt.receiptId);
  });

  it('skips a torn line but keeps the rest of the log', () => {
    store.reserveReceipt({ loopId: 'l1', revision: 1, itemId: 'i1', itemIndex: 0 });
    const existing = readFileSync(dataPath(LOOP_RECEIPTS_FILE), 'utf8');
    writeRaw(LOOP_RECEIPTS_FILE, `${existing}{"seq":1,"torn"\n`);
    expect(store.listReceipts()).toHaveLength(1);
  });

  it('returns undefined when resolving an unknown receipt', () => {
    expect(store.resolveReceipt('nope', { status: 'completed' })).toBeUndefined();
  });
});
