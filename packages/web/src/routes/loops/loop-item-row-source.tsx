/**
 * The per-item skill/workflow picker — the composer's chip, one row down.
 *
 * A loop keeps ONE task template and that stays the default, because most backlogs run
 * the same way end to end. This exists because some do not: one issue wants
 * `om-auto-fix-issue`, the next is a spec that wants a different workflow, and forcing
 * both through one template means splitting the loop in two.
 *
 * "Loop default" is a real, reachable option rather than a placeholder — once a row has
 * named a skill, clearing it has to be possible or the choice is a one-way door.
 */
import { SparklesIcon, WorkflowIcon } from 'lucide-react'

import { useSkills, useWorkflows } from '@/api/queries'
import type { DraftItem } from './loop-items'

export const LOOP_ITEM_SOURCE_DEFAULT = 'Loop default'

/** Encode/decode for the native `<select>`, which can only hold a string. */
function encode(source: DraftItem['source']): string {
  return source ? `${source.kind}:${source.ref}` : ''
}

function decode(value: string): DraftItem['source'] {
  if (!value) return undefined
  const at = value.indexOf(':')
  if (at < 0) return undefined
  const kind = value.slice(0, at)
  const ref = value.slice(at + 1)
  if (!ref || (kind !== 'skill' && kind !== 'workflow')) return undefined
  return { kind, ref }
}

export function LoopItemRowSource({
  index,
  source,
  onChange,
  disabled = false,
}: {
  index: number
  source: DraftItem['source']
  /** `undefined` means "use the loop's template" — see the module note. */
  onChange: (source: DraftItem['source']) => void
  disabled?: boolean
}) {
  // Lazily fetched by `useSkills`' own `enabled` contract; both are cached queries the
  // composer already populates, so opening a row costs no extra request in practice.
  const skills = useSkills().data ?? []
  const workflows = useWorkflows().data?.workflows ?? []

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {source?.kind === 'workflow' ? (
        <WorkflowIcon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <SparklesIcon aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="sr-only">{`Skill or workflow for item ${index + 1}`}</span>
      <select
        data-slot="loop-item-source"
        aria-label={`Skill or workflow for item ${index + 1}`}
        disabled={disabled}
        value={encode(source)}
        onChange={(event) => onChange(decode(event.target.value))}
        className="rounded border border-border bg-card px-1.5 py-0.5 text-xs"
      >
        <option value="">{LOOP_ITEM_SOURCE_DEFAULT}</option>
        {skills.length > 0 ? (
          <optgroup label="Skills">
            {skills.map((skill) => (
              <option key={`skill:${skill.name}`} value={`skill:${skill.name}`}>
                /{skill.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {workflows.length > 0 ? (
          <optgroup label="Workflows">
            {workflows.map((workflow) => (
              <option key={`workflow:${workflow.name}`} value={`workflow:${workflow.name}`}>
                {workflow.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  )
}
