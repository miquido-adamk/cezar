/**
 * A loop item's launch-time progress snapshot — what the item's own handoff journal
 * (`handoff.md`, spec 007) shows under "Loop context".
 *
 * Loops advance one item at a time behind a completion barrier (spec
 * `.ai/specs/2026-08-19-task-loops.md`): by the time item N launches, every item before
 * it has already settled — there is no such thing as two loop items "in progress"
 * together. So this is a snapshot, not a live view: computed once, at THIS item's
 * launch, from the receipts that exist at that moment, and written onto the run so it
 * survives even if the loop's own state later changes (a paused/resumed loop, a
 * skipped item) — the note is what THIS session started knowing, not a dashboard.
 *
 * Read-only and pure: no store access, no clock — the caller (the controller, which
 * already has the loop and its receipts in hand at launch time) supplies both.
 */
import type { LoopDefinition, LoopItem, LoopReceipt, LoopReceiptStatus } from './types.ts';

/** First line of a prompt, trimmed and capped — the same "headline" idea the cockpit's
 *  item list uses (`routes/loops/loop-items.ts` `itemHeadline`), independently
 *  implemented here so this module stays free of a `packages/web` dependency. */
function headline(prompt: string, max = 80): string {
  const first = (prompt.split('\n')[0] ?? '').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

const OUTCOME_LABEL: Record<LoopReceiptStatus, string> = {
  reserved: 'in progress',
  completed: 'done',
  skipped: 'skipped',
  'launch-error': 'launch error',
  stalled: 'stalled',
  vanished: 'vanished',
  'never-started': 'never started',
  'project-detached': 'project detached',
  merged: 'merged',
  'merge-blocked': 'merge blocked',
};

function outcomeOf(receipt: LoopReceipt | undefined, isCurrent: boolean): string {
  if (isCurrent) return 'in progress (this task)';
  if (!receipt) return 'pending';
  return OUTCOME_LABEL[receipt.status] ?? receipt.status;
}

/**
 * Render the "## Loop context" block for the item launching at `itemIndex`.
 *
 * `receipts` is keyed by item id, exactly the shape `LoopStore.latestReceiptsForLoop`
 * already returns — the caller passes that map straight through.
 */
export function loopProgressNote(
  loop: LoopDefinition,
  receipts: ReadonlyMap<string, LoopReceipt>,
  itemIndex: number,
): string {
  const lines = loop.items.map(
    (item: LoopItem, index: number) =>
      `${index === itemIndex ? '→' : ' '} ${index + 1}. ${headline(item.prompt)} — ${outcomeOf(receipts.get(item.id), index === itemIndex)}`,
  );
  return (
    `Loop **${loop.name}** — item ${itemIndex + 1} of ${loop.items.length}\n\n` +
    lines.join('\n') +
    '\n'
  );
}
