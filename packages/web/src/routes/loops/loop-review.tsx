/**
 * The composer's inline loop panel: what the `Loop` mode shows instead of sending
 * you to a separate page.
 *
 * Mirrors `PlanReview` — the composer's existing "here is what I propose, edit or
 * start it" surface — so loop mode is the same interaction the plan-first mode
 * already taught, rather than a second vocabulary.
 *
 * The items arrive already drafted from whatever was typed in the composer. They
 * stay editable here, because a drafted list is a proposal: the agent chose which
 * issues to include and a human is the only one who can say it chose wrong.
 */
import { useState } from 'react'

import { createLoop, loopAction } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { LoopLanding, PlanLoopItemsResponse } from '@open-mercato/cezar-api-client'
import {
  LOOP_ITEMS_HELP,
  LOOP_ITEMS_LABEL,
  loopDraftContextNote,
  loopItemCount,
  loopItemsOverCap,
  loopLandingLabel,
  loopLandingNote,
  loopStartConfirm,
} from './loop-copy'

const MAX_ITEMS = 100

export function LoopReview({
  drafted,
  onCancel,
  onStarted,
}: {
  drafted: PlanLoopItemsResponse
  onCancel: () => void
  onStarted: (loopId: string) => void
}) {
  const [text, setText] = useState(() => drafted.items.join('\n'))
  const [autonomous, setAutonomous] = useState(true)
  const [landing, setLanding] = useState<LoopLanding>('none')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const over = items.length - MAX_ITEMS

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const created = await createLoop({
        name: items[0]!.slice(0, 60),
        items,
        task: { autonomous },
        landing,
      })
      await loopAction(created.loop.id, 'start')
      onStarted(created.loop.id)
    } catch (cause) {
      setError(String(cause))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const confirm = loopStartConfirm(items.length)

  return (
    <div data-slot="loop-review" className="mx-auto mt-4 w-full max-w-3xl rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Loop</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">{loopDraftContextNote(drafted.context)}</p>

      <div className="mt-2">
        <Label htmlFor="composer-loop-items">{LOOP_ITEMS_LABEL}</Label>
        <Textarea
          id="composer-loop-items"
          rows={Math.min(12, Math.max(4, items.length + 1))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="composer-loop-help"
        />
        <p id="composer-loop-help" className="mt-1 text-xs text-muted-foreground">
          {LOOP_ITEMS_HELP}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {over > 0 ? loopItemsOverCap(over) : loopItemCount(items.length)}
        </p>
      </div>

      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
          Autonomous — items never stop to ask a question
        </label>

        <div>
          <Label htmlFor="composer-loop-landing">When an item finishes</Label>
          <select
            id="composer-loop-landing"
            data-slot="loop-landing"
            className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
            value={landing}
            onChange={(e) => setLanding(e.target.value as LoopLanding)}
          >
            {(['none', 'pr', 'merge'] as const).map((value) => (
              <option key={value} value={value}>
                {loopLandingLabel(value)}
              </option>
            ))}
          </select>
          {/* Says out loud what each choice does to your repository — `merge` is the
              one option that lands code without a human looking at it. */}
          <p className="mt-1 text-xs text-muted-foreground">{loopLandingNote(landing)}</p>
        </div>
      </div>

      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}

      {confirming ? (
        <div data-slot="loop-confirm" className="mt-3 rounded-md border border-border p-3">
          <div className="font-medium">{confirm.heading}</div>
          {confirm.body.map((line) => (
            <p key={line} className="mt-1 text-sm text-muted-foreground">
              {line}
            </p>
          ))}
          {/* The generic confirmation says "nothing is merged"; with landing `merge`
              that would be a lie, so the contradiction is corrected here. */}
          {landing === 'merge' ? (
            <p className="mt-1 text-sm text-destructive">
              This loop WILL merge each item once its PR is mergeable. That overrides the review gate.
            </p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              {confirm.cancel}
            </Button>
            <Button disabled={busy} onClick={() => void start()}>
              {confirm.confirm}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          className="mt-3"
          disabled={items.length === 0 || over > 0}
          onClick={() => setConfirming(true)}
        >
          Review and start
        </Button>
      )}
    </div>
  )
}
