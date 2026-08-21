/**
 * An item's prompt field, with the composer's `/skill` autocomplete.
 *
 * Reuses `detectTrigger` / `applyCompletion` — the composer's own caret math (#380) —
 * rather than a second implementation, so "does typing `/` open the menu" has exactly one
 * answer in this app. A mid-word slash stays inert there, which is what keeps a path like
 * `src/api/client.ts` from opening a skill menu.
 *
 * On commit the leading `/skill` is lifted out of the text and onto the item, so what you
 * typed becomes the item's actual skill instead of a string the agent has to notice.
 */
import { useRef, useState } from 'react'

import { useSkills } from '@/api/queries'
import { Textarea } from '@/components/ui/textarea'
import { applyCompletion, detectTrigger } from '@/components/composer/composer-text'

export function LoopItemInput({
  index,
  value,
  onChange,
  onCommit,
  disabled = false,
}: {
  index: number
  value: string
  onChange: (prompt: string) => void
  /** Called on blur / Escape — where extraction happens. */
  onCommit: () => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  // Fetched lazily, and the composer has usually warmed this cache already.
  const skills = useSkills().data ?? []

  const trigger = detectTrigger(value, caret)
  const matches =
    trigger?.trigger === '/'
      ? skills
          .filter((skill) => skill.name.toLowerCase().includes(trigger.query.toLowerCase()))
          .slice(0, 8)
      : []

  const complete = (name: string) => {
    if (!trigger) return
    const next = applyCompletion(value, trigger, caret, name)
    onChange(next.text)
    // Restore the caret: completing into the middle of a prompt must not fling it to the end.
    requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      node.focus()
      node.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    })
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        autoFocus
        rows={4}
        value={value}
        disabled={disabled}
        aria-label={`Item ${index + 1}`}
        onChange={(event) => {
          onChange(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
        }}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCommit()
            return
          }
          // Enter picks the first match while the menu is open, matching the composer.
          if (event.key === 'Enter' && matches.length > 0 && !event.shiftKey) {
            event.preventDefault()
            complete(matches[0]!.name)
          }
        }}
        onBlur={() => {
          // Deferred: a click on a suggestion blurs the textarea first, and committing
          // immediately would close the menu before the click landed.
          setTimeout(() => {
            if (ref.current && document.activeElement === ref.current) return
            onCommit()
          }, 120)
        }}
      />
      {matches.length > 0 ? (
        <ul
          data-slot="loop-item-skill-menu"
          className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-card p-1 shadow-md"
        >
          {matches.map((skill) => (
            <li key={skill.name}>
              <button
                type="button"
                // `onMouseDown`, not `onClick`: the textarea's blur fires first otherwise.
                onMouseDown={(event) => {
                  event.preventDefault()
                  complete(skill.name)
                }}
                className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
              >
                <span className="font-mono">/{skill.name}</span>
                {skill.description ? (
                  <span className="ml-2 text-muted-foreground">{skill.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
