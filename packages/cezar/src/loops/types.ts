/**
 * Task-loop schemas (spec `.ai/specs/2026-08-19-task-loops.md`).
 *
 * A loop runs an ordered list of independent items as a strict sequence of
 * ordinary cezar tasks, advancing only when the previous item's run reaches a
 * terminal state. These are the three project-local files behind that.
 *
 * Persistence discipline follows AGENTS.md § workspace registry, and it is
 * load-bearing rather than stylistic: every field optional-with-`.catch` where a
 * default is meaningful, `.passthrough()` at every object level so a newer cezar's
 * extra keys survive a round-trip through an older one, and per-entry salvage so
 * one corrupt loop never evicts the rest of the file.
 */
import { z } from 'zod';

/** Hard ceiling on items in one loop. A loop is a backlog drain, not a job queue;
 *  100 unattended paid sessions is already far past the point where a human should
 *  be re-reading what they asked for. Enforced in the composer and on the route. */
export const MAX_LOOP_ITEMS = 100;

/** How long an awaited run may sit `queued` before the barrier calls it
 *  `never-started`. Generous, because a held agent account legitimately blocks a
 *  queued run (`run.ts` skips queued runs whose account is held) and the user may
 *  simply be running something else. A module constant, never a per-loop field —
 *  AGENTS.md: "when a feature seems to need configuration, the design is wrong". */
export const LAUNCH_DEADLINE_MS = 30 * 60_000;

/** How long an awaited run may stay non-terminal in `monitoring` before the
 *  barrier pauses the loop and surfaces it. `monitoring` deliberately clears the
 *  idle timer, so without a deadline of our own this is an unbounded wait. */
export const STALL_DEADLINE_MS = 6 * 60 * 60_000;

/** Reconciling-sweep period. Low frequency and `unref`'d: it exists only to catch
 *  the three silent paths (a pruned run, a vanished record, a forever-`queued`
 *  run), not to drive normal advancement, which is event-driven. */
export const RECONCILE_INTERVAL_MS = 60_000;

/** Receipts file compaction thresholds. */
export const RECEIPTS_COMPACT_THRESHOLD = 20_000;
export const RECEIPTS_RETAIN_TERMINAL = 10_000;

/**
 * One item in a loop. Status deliberately does NOT live here — item outcome is
 * read from receipts, so there is exactly one writer for it and no way for the
 * definition and the receipt log to disagree.
 */
export const loopItemSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
  })
  .passthrough();

/**
 * The per-item task template. One template applies to every item in the loop —
 * the composer renders the ordinary New task choices once, and they apply to all
 * of them. There is no second form and no per-item override in this version.
 *
 * `variants` is accepted but the composer hides it while Loop mode is on: fanning
 * one item out in parallel is what `×1` already does, and mixing it with a
 * width-1 sequential barrier makes "which run is this item?" ambiguous.
 */
export const loopTaskTemplateSchema = z
  .object({
    workflow: z.string().optional(),
    steps: z.array(z.any()).optional(),
    model: z.string().optional(),
    runner: z.enum(['claude', 'claude-cli', 'codex', 'opencode']).optional(),
    agentProfile: z.string().optional(),
    systemPrompt: z.string().optional(),
    worktree: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    generateFollowups: z.boolean().optional(),
    variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .passthrough();

/**
 * Loop lifecycle. `status` is the single source of truth — there is deliberately
 * no separate `enabled` flag that could contradict it.
 *
 * - `idle`      — created, never started.
 * - `running`   — an item is in flight, or the next one is about to be launched.
 * - `paused`    — the user paused it, or the barrier paused it (`pausedReason`).
 * - `completed` — no `pending` items remain.
 */
export const loopStatusSchema = z.enum(['idle', 'running', 'paused', 'completed']);

export const loopDefinitionSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive().catch(1),
    name: z.string().min(1),
    description: z.string().optional(),
    status: loopStatusSchema.catch('idle'),
    /** Always set together with `status: 'paused'`, so the UI can say WHY without
     *  the user opening the receipt log. */
    pausedReason: z.string().optional(),
    items: z.array(loopItemSchema).max(MAX_LOOP_ITEMS).catch([]),
    task: loopTaskTemplateSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** The definitions file. Per-entry salvage happens in the store, not here. */
export const loopsFileSchema = z
  .object({
    version: z.literal(1).catch(1),
    loops: z.array(loopDefinitionSchema).catch([]),
  })
  .passthrough();

/**
 * Runtime cursor, cached separately from the definition so that editing a loop
 * (which bumps `revision`) never rewrites the definition and the cursor in one
 * place. Validated against the definition on boot: a stale or corrupt cursor is
 * repaired from the receipt log, never trusted.
 */
export const loopRuntimeStateSchema = z
  .object({
    loopId: z.string().min(1),
    revision: z.number().int().positive().catch(1),
    status: loopStatusSchema.catch('idle'),
    currentItemId: z.string().optional(),
    awaitedRunId: z.string().optional(),
    awaitedSince: z.string().optional(),
    lastReceiptId: z.string().optional(),
    completedCount: z.number().int().nonnegative().catch(0),
    skippedCount: z.number().int().nonnegative().catch(0),
  })
  .passthrough();

export const loopStateFileSchema = z
  .object({
    version: z.literal(1).catch(1),
    states: z.array(loopRuntimeStateSchema).catch([]),
  })
  .passthrough();

/**
 * Receipt status vocabulary. Every one of these is a state the barrier can
 * durably justify; there is no "unknown" or "error" catch-all, because a receipt
 * whose reason cannot be named is a receipt nobody can act on.
 *
 * - `reserved`         — the launch is claimed but not yet confirmed; the only
 *                        status that startup reconciliation may rewrite.
 * - `completed`        — the item's run reached a terminal state.
 * - `skipped`          — the user skipped it, or the loop advanced past it.
 * - `launch-error`     — the run was never created; explicit retry is offered.
 * - `stalled`          — non-terminal past `STALL_DEADLINE_MS` (`monitoring`).
 * - `vanished`         — the awaited record disappeared with no event at all.
 * - `never-started`    — still `queued` past `LAUNCH_DEADLINE_MS`.
 * - `project-detached` — the project was disposed while this item was in flight.
 */
export const loopReceiptStatusSchema = z.enum([
  'reserved',
  'completed',
  'skipped',
  'launch-error',
  'stalled',
  'vanished',
  'never-started',
  'project-detached',
]);

/**
 * One append-only receipt row.
 *
 * Deliberately carries NO prompt text and no system prompt: the receipt log is a
 * long-lived audit file, and the prompt already lives in the definition and on
 * the run record. Copying it here would triple the places a secret pasted into a
 * prompt has to be redacted.
 */
export const loopReceiptSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    receiptId: z.string().min(1),
    /** `${loopId}:${revision}:${itemId}` — the idempotency key that makes a
     *  restart-time relaunch impossible for an item already launched. */
    receiptKey: z.string().min(1),
    loopId: z.string().min(1),
    revision: z.number().int().positive(),
    itemId: z.string().min(1),
    itemIndex: z.number().int().nonnegative(),
    trigger: z.enum(['loop', 'manual']).catch('loop'),
    status: loopReceiptStatusSchema,
    reason: z.string().optional(),
    runId: z.string().optional(),
    observedAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type LoopItem = z.infer<typeof loopItemSchema>;
export type LoopTaskTemplate = z.infer<typeof loopTaskTemplateSchema>;
export type LoopStatus = z.infer<typeof loopStatusSchema>;
export type LoopDefinition = z.infer<typeof loopDefinitionSchema>;
export type LoopRuntimeState = z.infer<typeof loopRuntimeStateSchema>;
export type LoopReceiptStatus = z.infer<typeof loopReceiptStatusSchema>;
export type LoopReceipt = z.infer<typeof loopReceiptSchema>;

/** Receipt statuses that end an item's life. Everything else leaves it in flight. */
const TERMINAL_RECEIPT_STATUSES = new Set<LoopReceiptStatus>([
  'completed',
  'skipped',
  'launch-error',
  'stalled',
  'vanished',
  'never-started',
  'project-detached',
]);

export function isTerminalReceipt(status: LoopReceiptStatus): boolean {
  return TERMINAL_RECEIPT_STATUSES.has(status);
}

/** The idempotency key for one item launch under one revision of one loop. */
export function receiptKeyFor(loopId: string, revision: number, itemId: string): string {
  return `${loopId}:${revision}:${itemId}`;
}
