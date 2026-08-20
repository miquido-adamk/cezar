/**
 * The one loop item editor, used by BOTH `/loops/new` and the composer's Loop panel.
 *
 * Extracted because those two had diverged into a textarea and a list, which is exactly
 * how two surfaces for one concept start disagreeing about what an item is.
 *
 * The header mirrors the Workflows builder — a count, then `Auto` / `Import` / `Export`
 * — because a loop's item list and a workflow's step chain are the same kind of object
 * to a user: an ordered list they assemble, save and share. Same affordances, same
 * order, same words.
 *
 * `Auto` is the planner: it turns a plain-language brief into items. `Import`/`Export`
 * use one-item-per-line text rather than YAML, because that IS the loop's item format —
 * inventing a wrapper file would make a list of prompts harder to paste than it is now.
 */
import { useRef, useState } from 'react'
import { DownloadIcon, SparklesIcon, UploadIcon } from 'lucide-react'

import { planLoopItems } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LoopItemList } from './loop-item-list'
import {
  draftItemsFromText,
  extractItemSource,
  splitBriefSkill,
  submittableItems,
  textFromDraftItems,
  withDefaultSource,
  type DraftItem,
} from './loop-items'
import {
  LOOP_BRIEF_BUSY,
  LOOP_BRIEF_EMPTY,
  LOOP_BRIEF_HELP,
  LOOP_BRIEF_LABEL,
  loopDraftContextNote,
  loopDraftedCount,
} from './loop-copy'

export function LoopItemsEditor({
  items,
  onChange,
  disabled = false,
  /** Prefills the brief — the composer hands over whatever was typed there. */
  initialBrief = '',
  /** Shown once when items arrived already drafted, so the user knows what was filtered. */
  contextNote,
}: {
  items: readonly DraftItem[]
  onChange: (items: DraftItem[]) => void
  disabled?: boolean
  initialBrief?: string
  contextNote?: string
}) {
  const [brief, setBrief] = useState(initialBrief)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(contextNote ?? '')
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const auto = async () => {
    // A skill named in the BRIEF ("fix all open issues using /om-auto-fix-issue") applies
    // to every item it produces. Sending it to the planner instead asked a model to split
    // a command name into work, and dropping it lost the user's actual choice.
    const { skill: briefSkill, brief: description } = splitBriefSkill(brief)
    if (!description) {
      setError('Describe the work first, then Auto turns it into items.')
      return
    }
    setBusy(true)
    setError('')
    setNote('')
    try {
      // Hand over what the list already holds so a second Auto adds NEW work instead of
      // re-drafting the same issues — two drafts of one issue are worded differently, so
      // string de-duplication here could not catch it.
      const existing = submittableItems(items).map((item) => item.prompt)
      const plan = await planLoopItems({
        brief: description,
        ...(existing.length ? { existingItems: existing } : {}),
      })
      if (plan.fallback || plan.items.length === 0) {
        // With items already present, "nothing new" is a legitimate answer rather than a
        // failure — saying "couldn't draft" there would be wrong.
        setError(existing.length ? 'Nothing new to add for that description.' : LOOP_BRIEF_EMPTY)
        return
      }
      // Appends rather than replaces, so running Auto twice accumulates instead of
      // discarding whatever the user already assembled or hand-wrote.
      //
      // Each drafted prompt goes through extraction — the planner writes the skill INTO
      // the text ("Run /om-auto-fix-issue on issue #165…") — and anything still without a
      // source inherits the one the brief named.
      const drafted = withDefaultSource(
        plan.items.map((prompt) => extractItemSource({ prompt })),
        briefSkill ? { kind: 'skill', ref: briefSkill } : undefined,
      )
      onChange([...submittableItems(items), ...drafted])
      setNote(`${loopDraftedCount(plan.items.length)} ${loopDraftContextNote(plan.context)}`)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const exportItems = () => {
    // One item per line — the loop's own format, so an exported file is also a file the
    // user can hand-edit and paste straight back in.
    const blob = new Blob([`${textFromDraftItems(items)}\n`], {
      type: 'text/plain;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'loop-items.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const applyImport = (text: string) => {
    const parsed = draftItemsFromText(text)
    if (parsed.length === 0) {
      setError('That file had no items — one per line, blank lines ignored.')
      return
    }
    // Imported lines get the same treatment: an exported file round-trips its skills.
    onChange([...submittableItems(items), ...parsed.map(extractItemSource)])
    setNote(`Imported ${parsed.length === 1 ? '1 item' : `${parsed.length} items`}.`)
    setImportOpen(false)
    setImportText('')
    setError('')
  }

  return (
    <div data-slot="loop-items-editor">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={disabled || busy} onClick={() => void auto()}>
          <SparklesIcon /> {busy ? LOOP_BRIEF_BUSY : 'Auto'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setImportOpen((open) => !open)}
        >
          <UploadIcon /> Import
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || submittableItems(items).length === 0}
          onClick={exportItems}
        >
          <DownloadIcon /> Export
        </Button>
      </div>

      <div className="mt-2">
        <Label htmlFor="loop-editor-brief">{LOOP_BRIEF_LABEL}</Label>
        <Textarea
          id="loop-editor-brief"
          rows={2}
          value={brief}
          disabled={disabled}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="fix all open issues one by one"
          aria-describedby="loop-editor-brief-help"
        />
        <p id="loop-editor-brief-help" className="mt-1 text-xs text-muted-foreground">
          {LOOP_BRIEF_HELP}
        </p>
      </div>

      {importOpen ? (
        <div data-slot="loop-import" className="mt-2 rounded-md border border-border p-2">
          <Label htmlFor="loop-import-text">Paste items — one per line</Label>
          <Textarea
            id="loop-import-text"
            rows={4}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => applyImport(importText)}>
              Add these
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              Choose a file…
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.md,text/plain"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              void file.text().then(applyImport)
            }}
          />
        </div>
      ) : null}

      <div className="mt-3">
        <LoopItemList items={items} onChange={onChange} disabled={disabled} />
      </div>

      {note ? (
        <p data-slot="loop-editor-note" className="mt-2 text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
