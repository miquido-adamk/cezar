/**
 * The item list a loop composer edits: an ordered array of prompts, plus the three
 * operations the list UI needs.
 *
 * A loop's items are ORDERED and the order is load-bearing — item N+1 may be meant to
 * start from a base containing N — so reordering is a real editing operation, not a
 * cosmetic one. That is why this is a module with tests rather than inline handlers.
 *
 * Mirrors `moveStep`'s defensive shape (`lib/workflow-builder.ts`): every operation
 * returns a NEW array and an out-of-range index is a no-op rather than a throw, because
 * a drag that lands outside the list must not corrupt the list.
 */

/** Split pasted/typed text into items. Blank lines are dropped so a trailing newline
 *  never becomes an empty task. */
export function itemsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function textFromItems(items: readonly string[]): string {
  return items.join('\n')
}

/** Move `from` to `to`, clamping nothing and corrupting nothing. */
export function moveItem(items: readonly string[], from: number, to: number): string[] {
  if (from === to) return [...items]
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...items]
  next.splice(to, 0, moved)
  return next
}

export function removeItem(items: readonly string[], index: number): string[] {
  if (index < 0 || index >= items.length) return [...items]
  return items.filter((_, at) => at !== index)
}

/** Replace one item's text. An edit that empties an item is NOT a removal — the row
 *  stays so the user can retype it, and the empty value is filtered at submit. */
export function editItem(items: readonly string[], index: number, prompt: string): string[] {
  if (index < 0 || index >= items.length) return [...items]
  return items.map((item, at) => (at === index ? prompt : item))
}

/** The first line, for a collapsed row label. Items are often long multi-sentence prompts. */
export function itemHeadline(prompt: string, max = 140): string {
  const firstLine = prompt.split('\n')[0]?.trim() ?? ''
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine
}
