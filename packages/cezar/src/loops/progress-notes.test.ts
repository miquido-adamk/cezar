import { describe, expect, it } from 'vitest';
import { loopProgressNote } from './progress-notes.ts';
import type { LoopDefinition, LoopItem, LoopReceipt } from './types.ts';

function loop(items: LoopItem[]): LoopDefinition {
  return {
    id: 'loop-1',
    revision: 1,
    name: 'Drain the backlog',
    status: 'running',
    items,
    task: {},
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  } as LoopDefinition;
}

function receipt(over: Partial<LoopReceipt>): LoopReceipt {
  return {
    seq: 0,
    receiptId: 'r',
    receiptKey: 'k',
    loopId: 'loop-1',
    revision: 1,
    itemId: 'i',
    itemIndex: 0,
    trigger: 'loop',
    status: 'completed',
    observedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

describe('loopProgressNote', () => {
  const items: LoopItem[] = [
    { id: 'a', prompt: 'fix #101' },
    { id: 'b', prompt: 'fix #102' },
    { id: 'c', prompt: 'fix #103' },
    { id: 'd', prompt: 'fix #104' },
  ];

  it('names the loop and this item’s position', () => {
    const note = loopProgressNote(loop(items), new Map(), 2);
    expect(note).toContain('Loop **Drain the backlog** — item 3 of 4');
  });

  it('marks earlier items by their receipt outcome, this item as in progress, and later ones pending', () => {
    const receipts = new Map([
      ['a', receipt({ itemId: 'a', status: 'completed' })],
      ['b', receipt({ itemId: 'b', status: 'skipped' })],
    ]);
    const note = loopProgressNote(loop(items), receipts, 2);
    expect(note).toContain('1. fix #101 — done');
    expect(note).toContain('2. fix #102 — skipped');
    expect(note).toContain('→ 3. fix #103 — in progress (this task)');
    expect(note).toContain('4. fix #104 — pending');
  });

  it('reports every terminal outcome by its own label, not a generic "done"', () => {
    const items2: LoopItem[] = [
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ];
    const cases: Array<[LoopReceipt['status'], string]> = [
      ['launch-error', 'launch error'],
      ['stalled', 'stalled'],
      ['vanished', 'vanished'],
      ['never-started', 'never started'],
      ['project-detached', 'project detached'],
      ['merged', 'merged'],
      ['merge-blocked', 'merge blocked'],
    ];
    for (const [status, label] of cases) {
      const receipts = new Map([['a', receipt({ itemId: 'a', status })]]);
      expect(loopProgressNote(loop(items2), receipts, 1)).toContain(`1. x — ${label}`);
    }
  });

  it('truncates a long or multi-line prompt to a headline', () => {
    const long: LoopItem = { id: 'a', prompt: `${'x'.repeat(100)}\nsecond line never appears` };
    const note = loopProgressNote(loop([long]), new Map(), 0);
    expect(note).not.toContain('second line');
    expect(note).toContain('…');
  });
});
