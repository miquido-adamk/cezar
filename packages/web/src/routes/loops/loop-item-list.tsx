/**
 * The loop item list: numbered, reorderable, removable, editable rows.
 *
 * Deliberately the same interaction as `PlanReview`'s step cards — grip to drag, `×` to
 * remove, numbered in order — because a loop's items and a plan's steps are the same
 * kind of thing to a user: an ordered list they are about to approve. Reusing that
 * idiom (and its native HTML5 drag, no library) means loop mode teaches nothing new.
 *
 * Order matters materially here, not cosmetically: under landing `merge`, item N+1
 * starts from a base containing N. That is why dragging is offered at all rather than
 * leaving people to cut and paste lines in a textarea.
 */
import { useState, type DragEvent } from 'react'
import { GripVerticalIcon, PlusIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  extractItemSource,
  itemHeadline,
  moveDraftItem,
  patchDraftItem,
  removeDraftItem,
  type DraftItem,
} from './loop-items'
import { LoopItemInput } from './loop-item-input'
import { LoopItemPills } from './loop-item-pills'
import { LOOP_ITEMS_HELP, loopItemCount, loopItemsOverCap } from './loop-copy'

const MAX_ITEMS = 100

export function LoopItemList({
  items,
  onChange,
  disabled = false,
}: {
  items: readonly DraftItem[]
  onChange: (items: DraftItem[]) => void
  disabled?: boolean
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  /** Which row is expanded for editing. Items are long, so rows collapse to a headline. */
  const [editing, setEditing] = useState<number | null>(null)

  const endDrag = () => {
    setDragIndex(null)
    setOverIndex(null)
  }
  const drop = (event: DragEvent, to: number) => {
    event.preventDefault()
    if (dragIndex !== null && dragIndex !== to) onChange(moveDraftItem(items, dragIndex, to))
    endDrag()
  }

  const over = items.length - MAX_ITEMS

  return (
    <div data-slot="loop-item-list">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Items</span>
        <span className="text-xs text-muted-foreground">
          {over > 0 ? loopItemsOverCap(over) : loopItemCount(items.length)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{LOOP_ITEMS_HELP}</p>

      <ol className="mt-2 space-y-1.5">
        {items.map((item, index) => {
          const isEditing = editing === index
          const prompt = item.prompt
          return (
            <li
              key={index}
              data-slot="loop-item-row"
              draggable={!disabled && !isEditing}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => {
                event.preventDefault()
                setOverIndex(index)
              }}
              onDragLeave={() => setOverIndex((current) => (current === index ? null : current))}
              onDrop={(event) => drop(event, index)}
              onDragEnd={endDrag}
              className={cn(
                'flex items-start gap-2 rounded-md border border-border p-2',
                dragIndex === index && 'opacity-50',
                overIndex === index && dragIndex !== null && dragIndex !== index && 'border-ring',
              )}
            >
              {/* Not a button: the row itself is the drag source, so this is an affordance. */}
              <GripVerticalIcon
                aria-hidden="true"
                className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground', !disabled && 'cursor-grab')}
              />
              <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-foreground">{index + 1}</span>

              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <LoopItemInput
                    index={index}
                    value={prompt}
                    disabled={disabled}
                    onChange={(next) => onChange(patchDraftItem(items, index, { prompt: next }))}
                    onCommit={() => {
                      // Lift a typed `/skill` onto the item — what you typed IS the
                      // selection, the same bargain the composer makes.
                      onChange(items.map((row, at) => (at === index ? extractItemSource(row) : row)))
                      setEditing(null)
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="w-full text-left text-sm hover:underline"
                    onClick={() => setEditing(index)}
                    // The whole point of a drafted list is that it is editable; make the
                    // affordance explicit rather than hoping people try clicking.
                    title="Click to edit this item"
                  >
                    {itemHeadline(prompt) || (
                      <span className="text-muted-foreground">(empty — click to write it)</span>
                    )}
                  </button>
                )}
                {/* The composer's pill row, per item: skill/workflow, runner, model,
                    worktree, autonomous. Each pill is an OVERRIDE — an untouched one reads
                    "Loop default" and inherits, so nothing is pinned by merely looking. */}
                <LoopItemPills
                  index={index}
                  item={item}
                  disabled={disabled}
                  onChange={(patch) => onChange(patchDraftItem(items, index, patch))}
                />
              </div>

              <button
                type="button"
                aria-label={`Remove item ${index + 1}`}
                disabled={disabled}
                onClick={() => {
                  onChange(removeDraftItem(items, index))
                  setEditing(null)
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            </li>
          )
        })}
      </ol>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={disabled || items.length >= MAX_ITEMS}
        onClick={() => {
          onChange([...items, { prompt: '' }])
          setEditing(items.length)
        }}
      >
        <PlusIcon /> Add item
      </Button>
    </div>
  )
}
