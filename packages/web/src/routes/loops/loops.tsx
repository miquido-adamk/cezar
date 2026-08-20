/**
 * Task-loops views (spec `.ai/specs/2026-08-19-task-loops.md`, § UI/UX): the list,
 * the detail with its per-item timeline and paused banner, and the create form.
 *
 * Gating mirrors automations (#801) exactly, including the ordering subtlety that
 * spec's own view learned: NOTHING renders before health has answered, because a
 * cold deep link into `/loops/new` would otherwise paint a full creation form on a
 * gated server and a submit inside that window POSTs straight into a 409.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { AlertTriangleIcon, PlusIcon, RepeatIcon } from 'lucide-react'
import type { Loop, LoopDetailResponse, LoopListResponse } from '@open-mercato/cezar-api-client'

import { appendLoopItems, createLoop, deleteLoop, getLoop, getLoops, loopAction, planLoopItems } from '@/api/client'
import { useHealth } from '@/api/queries'
import { onWorkspaceEvent } from '@/api/global-events'
import { CenteredState } from '@/components/centered-state'
import { LoopItemsEditor } from './loop-items-editor'
import { LoopDefaultSourcePicker, type LoopDefaultSource } from './loop-default-source'
import { draftItemsFromText, submittableItems, type DraftItem } from './loop-items'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Link, useActiveProjectId, useNavigate } from '@/lib/project-router'
import {
  LOOPS_EMPTY_ACTION,
  LOOPS_EMPTY_BODY,
  LOOPS_EMPTY_HEADING,
  LOOPS_LOAD_FAILED,
  LOOPS_RETRY,
  LOOP_DELETE_CONFIRM,
  LOOP_ITEMS_HELP,
  LOOP_ITEMS_LABEL,
  LOOP_ITEM_STATUS_LABEL,
  LOOP_STATUS_LABEL,
  loopItemCount,
  loopItemLine,
  loopItemViewOf,
  loopItemsOverCap,
  loopPausedBanner,
  loopProgressLine,
  loopStartConfirm,
  LOOP_BRIEF_ACTION,
  LOOP_BRIEF_BUSY,
  LOOP_BRIEF_EMPTY,
  LOOP_BRIEF_HELP,
  LOOP_BRIEF_LABEL,
  loopDraftContextNote,
  loopDraftedCount,
  LOOP_ADD_ACTION,
  LOOP_ADD_BUSY,
  LOOP_ADD_HEADING,
  LOOP_ADD_HELP,
  LOOP_ADD_REVIVED,
  LOOP_ADD_STALE,
  loopAddedCount,
  loopLandingSummary,
} from './loop-copy'

const MAX_ITEMS = 100

/** Coarse relative time; the timeline only ever needs "how long ago", not precision. */
function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now'
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

function StatusPill({ loop }: { loop: Loop }) {
  return (
    <span
      data-loop-status={loop.status}
      className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
    >
      {LOOP_STATUS_LABEL[loop.status]}
    </span>
  )
}

export function LoopsRoute({ mode = 'list' }: { mode?: 'list' | 'new' | 'detail' }) {
  const { loopId } = useParams()
  const projectId = useActiveProjectId()
  const health = useHealth()
  const healthKnown = health.data !== undefined
  // `!== true` deliberately: only a health payload that HAS answered switches this on.
  const loopsOff = healthKnown && health.data.capabilities?.loops !== true

  if (!healthKnown) {
    return (
      <Shell>
        <CenteredState icon={<RepeatIcon />} title="Loading loops…" />
      </Shell>
    )
  }
  if (loopsOff) {
    return (
      <Shell>
        <CenteredState
          icon={<RepeatIcon />}
          title="Task loops are off"
          // Names the exact flag, so the answer is actionable without reading the docs.
          subtitle="Set CEZ_LOOPS=1 and restart cezar to run a list of tasks one at a time."
        />
      </Shell>
    )
  }
  if (mode === 'new') return <LoopCreate />
  if (mode === 'detail' && loopId) return <LoopDetail id={loopId} projectId={projectId} />
  return <LoopList projectId={projectId} />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-route="loops" className="flex min-h-full flex-col p-3 md:p-5">
      {children}
    </div>
  )
}

function LoopList({ projectId }: { projectId: string | null }) {
  const [data, setData] = useState<LoopListResponse>()
  const [error, setError] = useState('')
  const refresh = () => {
    setError('')
    return getLoops()
      .then(setData)
      .catch((cause) => setError(String(cause)))
  }
  useEffect(() => {
    void refresh()
  }, [])
  // Additive `loop-change` on the existing workspace SSE stream, following the
  // `automation-change` precedent — only this view subscribes, at its own lifetime.
  useEffect(
    () =>
      onWorkspaceEvent((name, payload) => {
        if (name !== 'loop-change') return
        const changed = payload as { project?: unknown }
        if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) void refresh()
      }),
    [projectId],
  )

  if (error) {
    return (
      <Shell>
        <CenteredState icon={<AlertTriangleIcon />} tone="danger" title={LOOPS_LOAD_FAILED} subtitle={error} />
        <div className="mt-3 flex justify-center">
          <Button onClick={() => void refresh()}>{LOOPS_RETRY}</Button>
        </div>
      </Shell>
    )
  }
  if (!data) {
    return (
      <Shell>
        {/* Skeleton rows rather than a spinner, so the list's shape is stable as it loads. */}
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-14 animate-pulse rounded-md bg-muted/40" />
          ))}
        </div>
      </Shell>
    )
  }
  if (data.loops.length === 0) {
    return (
      <Shell>
        <CenteredState icon={<RepeatIcon />} title={LOOPS_EMPTY_HEADING} subtitle={LOOPS_EMPTY_BODY} />
        <div className="mt-3 flex justify-center">
          <Link to="/loops/new">
            <Button>
              <PlusIcon /> {LOOPS_EMPTY_ACTION}
            </Button>
          </Link>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Loops</h1>
        <Link to="/loops/new">
          <Button size="sm">
            <PlusIcon /> {LOOPS_EMPTY_ACTION}
          </Button>
        </Link>
      </div>
      <ul className="space-y-2">
        {data.loops.map((loop) => (
          <li key={loop.id}>
            <Link
              to={`/loops/${encodeURIComponent(loop.id)}`}
              className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{loop.name}</span>
                <span className="block text-xs text-muted-foreground">{loopProgressLine(loop.progress)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {loop.progress.awaitedSince ? (
                  <span className="text-xs text-muted-foreground">{relativeTime(loop.progress.awaitedSince)}</span>
                ) : null}
                <StatusPill loop={loop} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Shell>
  )
}

function LoopDetail({ id, projectId }: { id: string; projectId: string | null }) {
  const navigate = useNavigate()
  const [data, setData] = useState<LoopDetailResponse>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const refresh = () =>
    getLoop(id)
      .then(setData)
      .catch((cause) => setError(String(cause)))
  useEffect(() => {
    void refresh()
  }, [id])
  useEffect(
    () =>
      onWorkspaceEvent((name, payload) => {
        if (name !== 'loop-change') return
        const changed = payload as { project?: unknown }
        if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) void refresh()
      }),
    [projectId, id],
  )

  const act = async (action: 'start' | 'pause' | 'resume' | 'skip-current') => {
    setBusy(true)
    try {
      await loopAction(id, action)
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <Shell>
        <CenteredState icon={<AlertTriangleIcon />} tone="danger" title={LOOPS_LOAD_FAILED} subtitle={error} />
      </Shell>
    )
  }
  if (!data) return <Shell><CenteredState icon={<RepeatIcon />} title="Loading loop…" /></Shell>

  const { loop, receipts } = data
  // Latest receipt per item — receipts are append-only latest-state rows, so the
  // highest `seq` for an item is its current state.
  const latest = new Map<string, (typeof receipts)[number]>()
  for (const row of receipts) {
    const seen = latest.get(row.itemId)
    if (!seen || row.seq > seen.seq) latest.set(row.itemId, row)
  }
  const currentIndex = loop.items.findIndex((item) => item.id === loop.progress.currentItemId)

  return (
    <Shell>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{loop.name}</h1>
          <span className="text-xs text-muted-foreground">
            {loopProgressLine(loop.progress)} · {loopLandingSummary(loop.landing)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusPill loop={loop} />
          {loop.status === 'idle' ? (
            <Button size="sm" disabled={busy} onClick={() => void act('start')}>
              Start
            </Button>
          ) : null}
          {loop.status === 'running' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('pause')}>
              Pause
            </Button>
          ) : null}
          {loop.status === 'paused' ? (
            <Button size="sm" disabled={busy} onClick={() => void act('resume')}>
              Resume
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            // Destructive, so it confirms first — through the design system's dialog, never a
            // native confirm() (which blocks the event loop and ignores the theme).
            onClick={() => setConfirmingDelete(true)}
          >
            Delete loop
          </Button>
        </span>
      </div>

      {loop.status === 'paused' && currentIndex >= 0 ? <PausedBanner
        itemNumber={currentIndex + 1}
        reason={loop.pausedReason}
        awaitedRunId={loop.progress.awaitedRunId}
        busy={busy}
        onResume={() => void act('resume')}
        onSkip={() => void act('skip-current')}
      /> : null}

      <ol className="space-y-2">
        {loop.items.map((item, index) => {
          const receipt = latest.get(item.id)
          const view = loopItemViewOf(receipt, item.id === loop.progress.currentItemId)
          return (
            <li
              key={item.id}
              data-loop-item-status={view.kind}
              className="rounded-md border border-border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="text-xs text-muted-foreground">{index + 1}</span>
                  {/* First line only: the prompt can be long, and the run itself shows it in full. */}
                  <span className="ml-2 font-medium">{item.prompt.split('\n')[0]}</span>
                </span>
                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {LOOP_ITEM_STATUS_LABEL[view.kind]}
                </span>
              </div>
              {/* Always rendered, never a tooltip — this line is the debuggability contract. */}
              <div className="mt-1 text-xs text-muted-foreground">{loopItemLine(view, relativeTime)}</div>
              {receipt?.runId ? (
                <Link className="mt-1 inline-block text-xs underline" to={`/tasks/${receipt.runId}`}>
                  Open task
                </Link>
              ) : null}
            </li>
          )
        })}
      </ol>

      <AlertDialog open={confirmingDelete} onOpenChange={(open) => !open && setConfirmingDelete(false)}>
        <AlertDialogContent data-slot="loop-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this loop?</AlertDialogTitle>
            {/* States what is NOT destroyed: the plan goes, the work it already produced stays. */}
            <AlertDialogDescription>{LOOP_DELETE_CONFIRM}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-action="loop-delete-confirm"
              disabled={busy}
              onClick={() => {
                void deleteLoop(id)
                  .then(() => navigate('/loops'))
                  .catch((cause) => setError(String(cause)))
              }}
            >
              Delete loop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  )
}

function PausedBanner({
  itemNumber,
  reason,
  awaitedRunId,
  busy,
  onResume,
  onSkip,
}: {
  itemNumber: number
  reason?: string
  awaitedRunId?: string
  busy: boolean
  onResume: () => void
  onSkip: () => void
}) {
  const copy = loopPausedBanner({ itemNumber, reason })
  return (
    // Deliberately not styled as an error: a pause is the recovery path, and the two
    // buttons are the only two moves that exist.
    <div data-loop-paused className="mb-3 rounded-md border border-border bg-muted/40 p-3">
      <div className="font-medium">{copy.heading}</div>
      <div className="mt-1 text-sm text-muted-foreground">{copy.body}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onResume}>
          {copy.resume}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onSkip}>
          {copy.skip}
        </Button>
        {awaitedRunId ? (
          // Cancelling the stalled run stays the user's own explicit action on that run.
          <Link className="text-sm underline" to={`/tasks/${awaitedRunId}`}>
            {copy.open}
          </Link>
        ) : null}
      </div>
    </div>
  )
}

function LoopCreate() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [name, setName] = useState('')
  // Seeded from a deep link (`?items=`), read once as the initial value rather than
  // synced: after mount the list is the user's, and re-applying the query string
  // would fight their edits.
  const [items, setItems] = useState<DraftItem[]>(() => draftItemsFromText(params.get('items') ?? ''))
  const [autonomous, setAutonomous] = useState(true)
  // The loop's default skill/workflow. Without this every item ran quick-task, however
  // clearly its own prompt named a skill.
  const [defaultSource, setDefaultSource] = useState<LoopDefaultSource>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Blank rows are legal while editing but never submitted.
  const ready = submittableItems(items)

  const confirm = async () => {
    setBusy(true)
    try {
      const created = await createLoop({
        name: name.trim() || ready[0]!.prompt.slice(0, 60),
        items: ready,
        task: {
          autonomous,
          // A skill runs as the one-step inline chain the composer and inbox use (spec 008).
          ...(defaultSource?.kind === 'skill'
            ? { steps: [{ id: 'task', name: defaultSource.ref, skill: defaultSource.ref, prompt: '{{task}}' }] }
            : defaultSource?.kind === 'workflow'
              ? { workflow: defaultSource.ref }
              : {}),
        },
      })
      await loopAction(created.loop.id, 'start')
      navigate(`/loops/${encodeURIComponent(created.loop.id)}`)
    } catch (cause) {
      setError(String(cause))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const confirmCopy = loopStartConfirm(ready.length)

  return (
    <Shell>
      <h1 className="mb-3 text-lg font-semibold">New loop</h1>
      <div className="max-w-2xl space-y-3">
        <div>
          <Label htmlFor="loop-name">Name</Label>
          <Input id="loop-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Drain the backlog" />
        </div>

        <LoopDefaultSourcePicker source={defaultSource} onChange={setDefaultSource} disabled={busy} />

        <LoopItemsEditor items={items} onChange={setItems} disabled={busy} />

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
          Autonomous — items never stop to ask a question
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="button" disabled={ready.length === 0} onClick={() => setConfirming(true)}>
          Review and start
        </Button>
      </div>

      {confirming ? (
        <div data-loop-confirm className="mt-4 max-w-2xl rounded-md border border-border p-3">
          <div className="font-medium">{confirmCopy.heading}</div>
          {confirmCopy.body.map((line) => (
            <p key={line} className="mt-1 text-sm text-muted-foreground">
              {line}
            </p>
          ))}
          <div className="mt-2 flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              {confirmCopy.cancel}
            </Button>
            <Button disabled={busy} onClick={() => void confirm()}>
              {confirmCopy.confirm}
            </Button>
          </div>
        </div>
      ) : null}
    </Shell>
  )
}
