/**
 * One item's own settings row — the composer's pill row, per item.
 *
 * A loop-level "every item runs X" was the wrong unit of decision: a backlog is not
 * homogeneous, and setting one skill for twenty unrelated items is not a choice anyone
 * actually wants to make. So each row carries the same controls the New task composer
 * offers, and each is an OVERRIDE: "Loop default" is a real option, and an untouched pill
 * inherits from the loop's template rather than pinning a value.
 *
 * Reuses `RUNNERS` and `useRunnerModels` — the composer's own catalogues — so an item
 * cannot offer a runner/model combination the composer would refuse.
 */
import { useRunnerModels } from '@/api/queries'
import { RUNNERS } from '@/routes/new-task-form'
import type { DraftItem } from './loop-items'
import { LoopItemSkillPill } from './loop-item-skill-pill'

/** The label every "inherit from the loop" option uses, so the fallback reads the same
 *  way on every pill rather than being spelled three different ways. */
export const LOOP_INHERIT_LABEL = 'Loop default'

const pill =
  'rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring'

export function LoopItemPills({
  index,
  item,
  onChange,
  disabled = false,
}: {
  index: number
  item: DraftItem
  onChange: (patch: Partial<DraftItem>) => void
  disabled?: boolean
}) {
  const overrides = item.overrides ?? {}
  // Models depend on the runner. `claude-cli` is a legacy STORAGE id with no catalogue of
  // its own, so it reads as `claude` here; an item that inherits its runner offers the
  // default backend's models rather than an empty list.
  const runnerForModels =
    overrides.runner === 'claude-cli' || overrides.runner === undefined ? 'claude' : overrides.runner
  const models = useRunnerModels(runnerForModels).data?.models ?? []

  const patchOverrides = (patch: Partial<NonNullable<DraftItem['overrides']>>) => {
    const next = { ...overrides, ...patch }
    // Strip keys back to absent so "inherit" is reachable again, and drop the whole
    // object when nothing is overridden — otherwise an item would carry an empty
    // overrides bag forever after one visit.
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      if (next[key] === undefined) delete next[key]
    }
    onChange({ overrides: Object.keys(next).length > 0 ? next : undefined })
  }

  return (
    <div data-slot="loop-item-pills" className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <LoopItemSkillPill
        index={index}
        source={item.source}
        disabled={disabled}
        onChange={(source) => onChange({ source })}
      />

      <select
        aria-label={`Runner for item ${index + 1}`}
        disabled={disabled}
        className={pill}
        value={overrides.runner ?? ''}
        onChange={(event) =>
          patchOverrides({ runner: event.target.value ? (event.target.value as typeof overrides.runner) : undefined })
        }
      >
        <option value="">{LOOP_INHERIT_LABEL}</option>
        {RUNNERS.map((runner) => (
          <option key={runner.id} value={runner.id}>
            {runner.id}
          </option>
        ))}
      </select>

      <select
        aria-label={`Model for item ${index + 1}`}
        disabled={disabled}
        className={pill}
        value={overrides.model ?? ''}
        onChange={(event) => patchOverrides({ model: event.target.value || undefined })}
      >
        <option value="">{LOOP_INHERIT_LABEL}</option>
        {models.map((model: { id: string; label: string }) => (
          <option key={model.id || 'auto'} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>

      {/* Tri-state, not a checkbox: a checkbox cannot express "inherit", and an item that
          silently pinned `false` would quietly opt out of the loop's own choice. */}
      <select
        aria-label={`Worktree for item ${index + 1}`}
        disabled={disabled}
        className={pill}
        value={overrides.worktree === undefined ? '' : overrides.worktree ? 'on' : 'off'}
        onChange={(event) =>
          patchOverrides({
            worktree: event.target.value === '' ? undefined : event.target.value === 'on',
          })
        }
      >
        <option value="">{LOOP_INHERIT_LABEL}</option>
        <option value="on">Worktree</option>
        <option value="off">In the repo</option>
      </select>

      <select
        aria-label={`Autonomous for item ${index + 1}`}
        disabled={disabled}
        className={pill}
        value={overrides.autonomous === undefined ? '' : overrides.autonomous ? 'on' : 'off'}
        onChange={(event) =>
          patchOverrides({
            autonomous: event.target.value === '' ? undefined : event.target.value === 'on',
          })
        }
      >
        <option value="">{LOOP_INHERIT_LABEL}</option>
        <option value="on">Autonomous</option>
        <option value="off">Asks questions</option>
      </select>
    </div>
  )
}
