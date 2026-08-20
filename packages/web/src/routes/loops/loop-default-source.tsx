/**
 * The loop's DEFAULT skill or workflow — what an item runs when it names nothing itself.
 *
 * `/loops/new` previously set no task template at all, so every item fell back to
 * `quick-task`: a loop drafted entirely out of "Run /om-auto-fix-issue on issue #165"
 * prompts ran none of that skill, and the task header said `quick-task` while the prompt
 * said otherwise. The per-item override cannot fix that on its own — the default is what
 * most items should inherit, and typing the same skill onto twelve rows is not a design.
 *
 * A `<select>` is right HERE, unlike on a row: this is one deliberate choice for the whole
 * loop, made once while assembling it, not a question repeated next to every prompt.
 */
import { SparklesIcon, WorkflowIcon } from 'lucide-react'

import { useSkills, useWorkflows } from '@/api/queries'
import { Label } from '@/components/ui/label'
import type { DraftItem } from './loop-items'

export type LoopDefaultSource = DraftItem['source']

function encode(source: LoopDefaultSource): string {
  return source ? `${source.kind}:${source.ref}` : ''
}

function decode(value: string): LoopDefaultSource {
  if (!value) return undefined
  const at = value.indexOf(':')
  if (at < 0) return undefined
  const kind = value.slice(0, at)
  const ref = value.slice(at + 1)
  if (!ref || (kind !== 'skill' && kind !== 'workflow')) return undefined
  return { kind, ref }
}

export function LoopDefaultSourcePicker({
  source,
  onChange,
  disabled = false,
}: {
  source: LoopDefaultSource
  onChange: (source: LoopDefaultSource) => void
  disabled?: boolean
}) {
  const skills = useSkills().data ?? []
  const workflows = useWorkflows().data?.workflows ?? []

  return (
    <div>
      <Label htmlFor="loop-default-source">Every item runs</Label>
      <div className="mt-1 flex items-center gap-2">
        {source?.kind === 'workflow' ? (
          <WorkflowIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <select
          id="loop-default-source"
          data-slot="loop-default-source"
          disabled={disabled}
          value={encode(source)}
          onChange={(event) => onChange(decode(event.target.value))}
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          {/* Named for what it DOES, not "none": the previous wording left people
              expecting their prompts' own `/skill` to be honoured, and it was not. */}
          <option value="">quick-task (just the prompt)</option>
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
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        An item that names its own skill overrides this.
      </p>
    </div>
  )
}
