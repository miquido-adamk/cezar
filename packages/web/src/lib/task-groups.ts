import type { RunRecord } from '@open-mercato/cezar-api-client'

/**
 * How the task list is bucketed, sorted and collapsed — the pure half of the sidebar quick-list
 * (and, from Step 3.4, of the Tasks table, which shares this view state).
 *
 * Pure on purpose: this is the behavior worth testing, and it is testable as a table because
 * nothing here touches React, the router or the clock. The component below it only paints.
 *
 * Behavior is ported from the legacy list (`web/app.js` → `sortedRuns` / `bucketOf` /
 * `renderRunList`), which is the parity bar for R1: same buckets, same order, same variant
 * collapsing, same queue numbers.
 */

/** Active/Archived. One value shared by the quick-list and the table (spec, "Task list & table":
 *  the filter tabs "share state with the sidebar quick-list tabs"), as the legacy UI's single
 *  `state.listView` did. */
export type ListView = 'active' | 'archived'

export type BucketLabel = 'Needs you' | 'Working' | 'Recent' | 'Archived'

/** Rendering order. Also the exhaustive set — `groupRuns` emits a subset of these, in this order. */
export const BUCKET_ORDER: readonly BucketLabel[] = ['Needs you', 'Working', 'Recent', 'Archived']

/**
 * Sort weight per status: needs-you first, then the pipeline in the order it will actually
 * happen — running now, resuming next, waiting for a slot — and finally the outcomes. Ties break
 * on recency. The top of the list therefore answers "what is happening, and what happens next?"
 * without reading a single row's detail.
 *
 * Grown from the legacy `STATUS_ORDER` (waiting/review/running/queued, everything else 9): the
 * terminal states are now ranked among themselves, and `scheduled` — a run waiting out a usage
 * limit — sits between running and queued, because it is work with an appointment rather than an
 * outcome (spec 2026-08-03-auto-resume-after-usage-limit).
 */
const STATUS_ORDER: Partial<Record<RunRecord['status'], number>> = {
  waiting: 0,
  review: 1,
  running: 2,
  queued: 4,
  done: 5,
  failed: 6,
  cancelled: 7,
}

/** Not a status of its own: `scheduled` is a `failed` run holding a live resume deadline, which
 *  is the same rule the status pill and the sidebar bucket read (`lib/attention.ts`). */
const SCHEDULED_WEIGHT = 3

const statusWeight = (run: RunRecord): number =>
  run.status === 'failed' && run.autoResumeAt !== undefined
    ? SCHEDULED_WEIGHT
    : STATUS_ORDER[run.status] ?? 9

/** One row of the quick-list: a single run, a collapsed variant group (spec 010), or a
 *  collapsed loop group (task-loops). */
export type QuickListRow =
  | {
      kind: 'run'
      run: RunRecord
      /** 1-based position among queued runs, `null` unless the run is queued. */
      queuePosition: number | null
    }
  | {
      kind: 'group'
      groupId: string
      /** The shared task title, without the per-variant suffix. */
      title: string
      /** Every member, ordered by variant letter (A, B, C). Always ≥ 2 — see `groupRuns`. */
      members: RunRecord[]
    }
  | {
      kind: 'loop'
      loopId: string
      /** The loop's own name, not a task title — a loop's items are independent work and
       *  rarely share a headline the way variants of one task do. */
      title: string
      /** Every member currently in view, ordered by item index (run order), not recency.
       *  Always ≥ 2 — see `groupRuns`. */
      members: RunRecord[]
    }

export interface QuickListBucket {
  label: BucketLabel
  rows: QuickListRow[]
}

/**
 * The label a run sits under.
 *
 * Archived collapses the whole list into one bucket regardless of status: in that view the
 * outcome is history, and "Needs you" over a run nobody will touch again would be a lie.
 */
export function bucketOf(run: RunRecord, view: ListView): BucketLabel {
  if (view === 'archived') return 'Archived'
  if (run.status === 'waiting' || run.status === 'review') return 'Needs you'
  if (run.status === 'running' || run.status === 'queued') return 'Working'
  // A run waiting out a provider usage limit is `failed` on the record but has an appointment to
  // resume itself (spec 2026-08-03-auto-resume-after-usage-limit) — it belongs with the work in
  // flight, not filed under Recent as an outcome. It asks for nothing, so never "Needs you".
  if (run.status === 'failed' && run.autoResumeAt) return 'Working'
  return 'Recent'
}

/**
 * What every surface calls a run — the R1-marked plug-in point, now wired (R2 Step 2.4).
 *
 * `titleSummary ?? title`, per the server's contract (`api/types.ts`), except (#623) for malformed
 * auto/legacy summaries whose sentence punctuation was persisted without following whitespace.
 * Those fall back to the honest raw title at display time; persisted state is never rewritten.
 * User and marker titles remain byte-for-byte authoritative.
 *
 * `??`, not `||`: the server never stores an empty summary (trimmed, 1–300 chars), so only
 * absence falls back — a falsy-but-present value would be a server bug worth seeing.
 *
 * Takes the three fields it reads rather than a whole `RunRecord`, for the same reason
 * `AttentionInput` does: the ⌘K palette's cross-project index (`RunIndexEntry`) is a slim row,
 * not a record, and it must name a task exactly as every other surface does. Widening the
 * parameter is what makes that a shared function instead of a second title rule.
 */
export type RunTitleInput = Pick<RunRecord, 'title' | 'titleSummary' | 'titleOrigin'>

export function runTitle(run: RunTitleInput): string {
  const summary = run.titleSummary
  if (summary === undefined) return run.title
  const protectedTitle = run.titleOrigin === 'user' || run.titleOrigin === 'marker'
  return !protectedTitle && /[.!?][A-Z]/.test(summary) ? run.title : summary
}

/**
 * The `NNN: ` reference prefix `postValidateTitle` writes onto every auto-named run
 * (`packages/cezar/src/runs/auto-name.ts`), split off the display title — issue #788, option C.
 *
 * RENDER-ONLY. The stored `title`/`titleSummary` keep the prefix: it is what makes a run findable
 * by number in search, in the Tasks table and in the page title, and `runs.json` field semantics
 * are a protected surface. This only lets a surface that ALREADY paints the number elsewhere —
 * the sidebar row, whose leading chip is the reference — stop spending five characters of a
 * ~10-character title budget saying it twice.
 *
 * The shape is exactly what `postValidateTitle` produces (`^\d+: `) and nothing looser, so a title
 * that merely contains a colon (`"fix: the login bug"`) or a number in prose is left alone. The
 * caller decides whether the split is safe to use — see `refPrefixMatches`.
 */
export function splitRefPrefix(title: string): { ref: number | null; rest: string } {
  const match = /^(\d{1,9}): (.+)$/.exec(title)
  const digits = match?.[1]
  const rest = match?.[2]
  // Both groups are non-optional in the pattern, so this narrowing is only for the type system —
  // but it is the narrowing rather than a cast, so a future edit to the pattern is caught here
  // instead of producing an `undefined` that has been asserted to be a string.
  if (digits === undefined || rest === undefined) return { ref: null, rest: title }
  return { ref: Number(digits), rest }
}

/**
 * May the row drop the title's `NNN: ` prefix in favour of its reference chip?
 *
 * Only when the two numbers are the SAME number. A task opened on issue `#788` whose PR later
 * becomes `#790` shows `790` in its chip while its title still leads with `788: ` — two different
 * facts, and hiding one of them would be a lie rather than a saving. An unrelated leading number
 * (`"2026: the year in review"`) fails the same test, which is what keeps this from over-matching.
 */
export function refPrefixMatches(title: string, reference: number | undefined): boolean {
  return reference !== undefined && splitRefPrefix(title).ref === reference
}

/**
 * A variant's shared title: `"Add autocomplete (A)"` → `"Add autocomplete"`.
 *
 * The suffix is the server's own convention (`startVariants` appends ` (A)`…` (C)`), so this
 * strips exactly that shape — a title that merely ends in "(D)" or "(draft)" is left alone.
 */
export function groupTitle(run: Pick<RunRecord, 'title'>): string {
  return run.title.replace(/ \([A-C]\)$/, '')
}

/**
 * A loop group's tile title: the loop's own name, denormalized onto each of its runs at launch
 * (`RunRecord['loop'].loopName`, the same reason `automation.event` is a plain string rather than
 * a lookup). A run launched before that field existed falls back to a generic label rather than
 * leaving the tile blank.
 */
export function loopTitle(run: Pick<RunRecord, 'loop'>): string {
  return run.loop?.loopName ?? 'Loop'
}

/**
 * Queue positions: the `#2` a queued row shows instead of an age.
 *
 * Computed over the *active* queued runs by creation order, which is the order the engine will
 * actually start them in — never over the filtered/sorted view, or the number would change as
 * the sidebar re-sorted underneath it. Archived runs are excluded for the same reason: they are
 * not in the queue.
 */
export function queuePositions(runs: readonly RunRecord[]): Map<string, number> {
  const queued = runs
    .filter((run) => !run.archived && run.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return new Map(queued.map((run, index) => [run.id, index + 1]))
}

/**
 * Runs in the view, ordered: status weight first, then whatever "next" means inside that rank.
 *
 * For most ranks that is recency — newest first, the historical rule. For the two ranks that are
 * genuinely a QUEUE it is the order they will actually happen in, because a list sorted by
 * "what happens next" that then shuffles its own waiting rows is only half the promise:
 *
 *  - `scheduled` — soonest appointment on top. A task resuming at 11:14 sits above one resuming
 *    at 11:40, whichever was created first.
 *  - `queued` — oldest first, which is FIFO and therefore exactly the `#1 in queue` position the
 *    row already prints beside itself. Newest-first rendered those positions backwards.
 *
 * ISO-8601 strings compare lexicographically because every timestamp cezar writes is UTC
 * (`toISOString()` → trailing `Z`), the same reason `read-state.ts` compares them directly.
 */
export function sortRuns(runs: readonly RunRecord[], view: ListView): RunRecord[] {
  return runs
    .filter((run) => (view === 'archived' ? run.archived : !run.archived))
    .sort((a, b) => {
      const weight = statusWeight(a) - statusWeight(b)
      if (weight !== 0) return weight
      // Equal weights, and that weight is the scheduled one — so both sides carry an
      // `autoResumeAt` (nothing else earns the rank), and the appointment is the answer.
      if (statusWeight(a) === SCHEDULED_WEIGHT && a.autoResumeAt && b.autoResumeAt) {
        const order = a.autoResumeAt.localeCompare(b.autoResumeAt)
        if (order !== 0) return order
      }
      if (a.status === 'queued' && b.status === 'queued') {
        return a.createdAt.localeCompare(b.createdAt)
      }
      return b.createdAt.localeCompare(a.createdAt)
    })
}

/**
 * The whole list, ready to render: filtered to the view, sorted, variant-collapsed and bucketed.
 *
 * Variant collapsing (spec 010): runs sharing a `groupId` render as one tile, placed where the
 * group's best-ranked member would have sat — so a group with one variant waiting on you rises to
 * "Needs you" as a unit, rather than tearing in half across two buckets. A `groupId` with only one
 * member left in view (the picked winner, or the only one not archived) is not a group at all and
 * renders as a plain row.
 *
 * Loop collapsing (task-loops) follows the same rule over `run.loop.loopId` instead: six sibling
 * tasks one loop launched, one by one, would otherwise flood the list as six unrelated rows. A
 * loop is deliberately never given a `groupId` (that keyspace belongs to the variant loser-sweep,
 * `POST /groups/:groupId/pick`, which would cancel every non-winner — unreachable by construction
 * for loop children), so this checks the two independently rather than treating them as one axis.
 *
 * Empty buckets are omitted rather than rendered headerless-and-empty; a fully empty result is the
 * component's cue for the empty state.
 */
export function groupRuns(runs: readonly RunRecord[], view: ListView): QuickListBucket[] {
  const positions = queuePositions(runs)
  const sorted = sortRuns(runs, view)
  const byBucket = new Map<BucketLabel, QuickListRow[]>()
  const push = (label: BucketLabel, row: QuickListRow) => {
    const rows = byBucket.get(label)
    if (rows) rows.push(row)
    else byBucket.set(label, [row])
  }

  const seenGroups = new Set<string>()
  const seenLoops = new Set<string>()
  for (const run of sorted) {
    if (run.groupId) {
      if (seenGroups.has(run.groupId)) continue
      seenGroups.add(run.groupId)
      // From `sorted`, not from `runs`: a group's members must obey the same view filter as
      // everything else, or an archived variant would reappear inside an active group's tile.
      const members = sorted
        .filter((member) => member.groupId === run.groupId)
        .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
      if (members.length > 1) {
        push(bucketOf(run, view), { kind: 'group', groupId: run.groupId, title: groupTitle(run), members })
        continue
      }
    }
    const loopId = run.loop?.loopId
    if (loopId) {
      if (seenLoops.has(loopId)) continue
      seenLoops.add(loopId)
      const members = sorted
        .filter((member) => member.loop?.loopId === loopId)
        // Run order, not recency: item 1 above item 2 is how the loop itself will work through
        // them, and that is the order a reader wants to check progress in.
        .sort((a, b) => (a.loop?.itemIndex ?? 0) - (b.loop?.itemIndex ?? 0))
      if (members.length > 1) {
        push(bucketOf(run, view), { kind: 'loop', loopId, title: loopTitle(run), members })
        continue
      }
    }
    push(bucketOf(run, view), { kind: 'run', run, queuePosition: positions.get(run.id) ?? null })
  }

  return BUCKET_ORDER.filter((label) => byBucket.has(label)).map((label) => ({
    label,
    rows: byBucket.get(label) as QuickListRow[],
  }))
}

/**
 * Cap a bucketed list at `limit` rows ACROSS buckets, preserving bucket order (multi-project
 * spec, step 3.3: each sidebar project group shows its "10 most recent tasks" and a More… row).
 * A collapsed variant-group tile counts as one row — it occupies one row of sidebar. Buckets
 * emptied by the cap are dropped, like `groupRuns` drops empty ones.
 */
export function capBuckets(buckets: readonly QuickListBucket[], limit: number): QuickListBucket[] {
  const capped: QuickListBucket[] = []
  let remaining = limit
  for (const bucket of buckets) {
    if (remaining <= 0) break
    const rows = bucket.rows.slice(0, remaining)
    remaining -= rows.length
    capped.push({ label: bucket.label, rows })
  }
  return capped
}

/** The tab counts. `waiting` drives the Active tab's attention dot — the one thing that makes an
 *  un-selected tab worth looking at. */
export function listCounts(runs: readonly RunRecord[]): {
  active: number
  archived: number
  waiting: number
} {
  let active = 0
  let archived = 0
  let waiting = 0
  for (const run of runs) {
    if (run.archived) {
      archived += 1
      continue
    }
    active += 1
    if (run.status === 'waiting' || run.status === 'review') waiting += 1
  }
  return { active, archived, waiting }
}
