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

/**
 * An item as the editor holds it: the prompt, plus an optional per-item skill/workflow
 * override. A plain prompt is still the common case, so `source` is optional and absent
 * means "use the loop's own task template".
 */
export interface DraftItem {
  prompt: string
  source?: { kind: 'skill' | 'workflow'; ref: string }
}

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

/**
 * Strip a leading slash-skill token from a composer brief.
 *
 * The composer's text may start with `/om-auto-fix-issue …` — that prefix selects the
 * SKILL, it is not part of the work description. Passing it to the planner asks a model
 * to split a slash command into work items, which is how "fix all open issues" came
 * back undraftable: the brief the planner saw was mostly a command name.
 *
 * Returns the skill (without the slash) separately so the caller can carry it onto the
 * loop's task template, where it belongs — every item should run under the skill the
 * user picked, rather than the skill being lost and the brief being polluted.
 */
export function splitBriefSkill(text: string): { skill?: string; brief: string } {
  const match = /^\s*\/([A-Za-z0-9][A-Za-z0-9._:-]*)\s*/.exec(text)
  if (!match) return { brief: text.trim() }
  return { skill: match[1], brief: text.slice(match[0].length).trim() }
}

// ---- draft items (prompt + optional per-item source) ----------------------------------------

export function draftItemsFromText(text: string): DraftItem[] {
  return itemsFromText(text).map((prompt) => ({ prompt }))
}

/**
 * One item per line, with a skill written back as the `/skill` prefix it came from.
 *
 * That prefix is what makes Export/Import a round trip: `extractItemSource` lifts it back
 * out on the way in, so a file you exported, hand-edited and re-imported keeps its skills
 * instead of quietly falling back to the loop's template.
 *
 * A per-item WORKFLOW has no `/` spelling, so it does not survive the text format — the
 * line is still exported, just without that override.
 */
export function textFromDraftItems(items: readonly DraftItem[]): string {
  return items
    .map((item) => {
      const prompt = item.prompt.trim()
      if (!prompt) return ''
      return item.source?.kind === 'skill' ? `/${item.source.ref} ${prompt}` : prompt
    })
    .filter((line) => line.length > 0)
    .join('\n')
}

export function moveDraftItem(items: readonly DraftItem[], from: number, to: number): DraftItem[] {
  if (from === to) return [...items]
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...items]
  next.splice(to, 0, moved)
  return next
}

export function removeDraftItem(items: readonly DraftItem[], index: number): DraftItem[] {
  if (index < 0 || index >= items.length) return [...items]
  return items.filter((_, at) => at !== index)
}

/** Patch one row. Used for both the prompt and the per-item source. */
export function patchDraftItem(
  items: readonly DraftItem[],
  index: number,
  patch: Partial<DraftItem>,
): DraftItem[] {
  if (index < 0 || index >= items.length) return [...items]
  return items.map((item, at) => {
    if (at !== index) return item
    const next: DraftItem = { ...item, ...patch }
    // An explicitly cleared source must actually disappear, or "use the loop's template"
    // would be unreachable once a row had ever named one.
    if (patch.source === undefined && 'source' in patch) delete next.source
    return next
  })
}

/** Non-blank rows, in submitted form — what actually gets sent. */
export function submittableItems(items: readonly DraftItem[]): DraftItem[] {
  return items
    .map((item) => ({ ...item, prompt: item.prompt.trim() }))
    .filter((item) => item.prompt.length > 0)
}

/**
 * Pull a leading `/skill` out of an item's prompt and into its `source`.
 *
 * Items arrive with the skill written INTO the text — the planner drafts "Run
 * /om-auto-fix-issue on issue #165…", and a person typing an item does the same, because
 * that is what the composer taught them. Leaving it there means the skill is a string the
 * agent has to notice rather than the skill the item actually runs under, and the row's
 * own picker sits on "Loop default" next to a prompt that plainly names one.
 *
 * Extraction is therefore the default behaviour, not a button: what you typed IS the
 * selection, exactly as in the composer.
 */
export function extractItemSource(item: DraftItem): DraftItem {
  const { skill, brief } = splitBriefSkill(item.prompt)
  // Only when the prompt actually leads with one, and never overwrite a source the user
  // set deliberately on the row.
  if (!skill || item.source) return item
  // A `/skill` with nothing after it is a selection, not a prompt — keep the text so the
  // row does not silently empty itself.
  if (!brief) return { ...item, source: { kind: 'skill', ref: skill } }
  return { prompt: brief, source: { kind: 'skill', ref: skill } }
}

/** Apply a default source to items that named none — used when the BRIEF named the skill
 *  ("fix all open issues using /om-auto-fix-issue"), which should apply to every item it
 *  produced rather than being dropped on the floor. */
export function withDefaultSource(
  items: readonly DraftItem[],
  source: DraftItem['source'],
): DraftItem[] {
  if (!source) return [...items]
  return items.map((item) => (item.source ? item : { ...item, source }))
}
