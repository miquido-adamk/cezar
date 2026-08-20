/**
 * What an item runs under, shown the way the composer shows it: a chip, not a dropdown.
 *
 * The first version of this was a `<select>` listing every skill, which was the wrong
 * shape twice over. The skill is normally already IN the text — the planner drafts
 * "/om-auto-fix-issue on issue #165", and people type the same out of composer habit — so
 * the job is to lift it out and display it, not to ask again in a second control. And when
 * someone does want to change it, `/` in the item is the interaction they already know.
 *
 * So: a chip when the item has a source, nothing when it does not (the loop's template is
 * the default and needs no ornament), and `×` to clear.
 */
import { SparklesIcon, WorkflowIcon, XIcon } from 'lucide-react'

import type { DraftItem } from './loop-items'

export function LoopItemSourceChip({
  index,
  source,
  onClear,
  disabled = false,
}: {
  index: number
  source: DraftItem['source']
  onClear: () => void
  disabled?: boolean
}) {
  // No chip for "the loop's template". An always-present control implying a per-item
  // decision is what made the previous version read as unanswered on every row.
  if (!source) return null
  const Icon = source.kind === 'workflow' ? WorkflowIcon : SparklesIcon
  return (
    <span
      data-slot="loop-item-source-chip"
      data-source-kind={source.kind}
      data-source-ref={source.ref}
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="font-mono">{source.kind === 'skill' ? `/${source.ref}` : source.ref}</span>
      <button
        type="button"
        aria-label={`Clear the skill for item ${index + 1}`}
        disabled={disabled}
        onClick={onClear}
        className="rounded hover:text-foreground"
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </span>
  )
}
