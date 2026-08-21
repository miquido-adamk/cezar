/**
 * The skill/workflow pill for one item — the composer's skill chip, per row.
 *
 * Shows the item's own choice, or `Loop default` when it inherits. Typing `/name` in the
 * item's prompt still sets this (see `extractItemSource`); this is the explicit control
 * for when you did not, or want to change it without editing the text.
 */
import { SparklesIcon, WorkflowIcon } from 'lucide-react'

import { useSkills, useWorkflows } from '@/api/queries'
import type { DraftItem } from './loop-items'

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

export function LoopItemSkillPill({
  index,
  source,
  onChange,
  disabled = false,
}: {
  index: number
  source: DraftItem['source']
  onChange: (source: DraftItem['source']) => void
  disabled?: boolean
}) {
  const skills = useSkills().data ?? []
  const workflows = useWorkflows().data?.workflows ?? []

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5">
      {source?.kind === 'workflow' ? (
        <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      )}
      <select
        aria-label={`Skill or workflow for item ${index + 1}`}
        disabled={disabled}
        value={encode(source)}
        onChange={(event) => onChange(decode(event.target.value))}
        className="bg-transparent text-xs text-muted-foreground focus:outline-none"
      >
        <option value="">skill: default</option>
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
                {`workflow: ${workflow.name}`}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </span>
  )
}
