/**
 * HTTP contract for task loops (spec `2026-08-19-task-loops`).
 *
 * One zod definition per shape, every TypeScript type inferred from it. The
 * contract must describe EXACTLY what the routes send — no wider, no narrower —
 * because `contract-parity*.test.ts` asserts both directions and a one-way check
 * passes on real drift.
 *
 * Note on optional keys: writing `key: maybeUndefined` types a key as
 * always-present that `JSON.stringify` drops from the wire, so anything the server
 * spreads conditionally is declared `.optional()` here.
 */
import { z } from 'zod';
import { runnerSchema } from './health.ts';

/** Ceiling on items in one loop, mirrored from the server's own constant. */
export const MAX_LOOP_ITEMS = 100;

export const loopStatusSchema = z.enum(['idle', 'running', 'paused', 'completed']);

/**
 * What a finished item leaves behind. ONE enum rather than two booleans, so
 * "merge without opening a PR" is unrepresentable.
 *
 * `none` is the default and the only value that honours the never-auto-merges
 * invariant; `merge` is an explicit per-loop opt-in reversal of it.
 */
export const loopLandingSchema = z.enum(['none', 'pr', 'merge']);

/** Per-item skill/workflow override; absent means the loop's own task template. */
export const loopItemSourceSchema = z.object({
  kind: z.enum(['skill', 'workflow']),
  ref: z.string().min(1),
});

export const loopItemSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  source: loopItemSourceSchema.optional(),
});

/**
 * An item as SUBMITTED. A bare string stays legal — it is how most items are written and
 * how every existing client sends them — and the object form adds the override.
 */
export const loopItemInputSchema = z.union([
  z.string().min(1).max(20_000),
  z.object({
    prompt: z.string().min(1).max(20_000),
    source: loopItemSourceSchema.optional(),
  }),
]);

/**
 * The per-item task template.
 *
 * Derived from the same choices the New task composer already offers, so item
 * semantics have one source and the composer does not grow a second form.
 * `variants` is accepted for shape-compatibility but the composer hides it in Loop
 * mode: fanning one item out in parallel is what `×1` does, and it makes "which
 * run is this item?" ambiguous under a width-1 barrier.
 */
export const loopTaskTemplateSchema = z.object({
  workflow: z.string().optional(),
  steps: z.array(z.unknown()).optional(),
  model: z.string().optional(),
  // The CANONICAL runner set, not a copy of it. A hand-rolled enum here had already
  // drifted — it was missing `pi`, so the composer could offer a runner the loop
  // contract would reject.
  runner: runnerSchema.optional(),
  agentProfile: z.string().optional(),
  systemPrompt: z.string().optional(),
  worktree: z.boolean().optional(),
  autonomous: z.boolean().optional(),
  generateFollowups: z.boolean().optional(),
  variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export const loopReceiptStatusSchema = z.enum([
  'reserved',
  'completed',
  'skipped',
  'launch-error',
  'stalled',
  'vanished',
  'never-started',
  'project-detached',
  /** The item's PR was opened and landed (landing `merge`). */
  'merged',
  /** The PR exists but could not be landed before the deadline; left open for a human. */
  'merge-blocked',
]);

export const loopReceiptSchema = z.object({
  seq: z.number().int(),
  receiptId: z.string(),
  receiptKey: z.string(),
  loopId: z.string(),
  revision: z.number().int(),
  itemId: z.string(),
  itemIndex: z.number().int(),
  trigger: z.enum(['loop', 'manual']),
  status: loopReceiptStatusSchema,
  reason: z.string().optional(),
  runId: z.string().optional(),
  /** The PR this item produced, when landing opened one. */
  prNumber: z.number().int().positive().optional(),
  observedAt: z.string(),
  updatedAt: z.string(),
});

/** Progress counters, read from the runtime cursor rather than recomputed. */
export const loopProgressSchema = z.object({
  completedCount: z.number().int(),
  skippedCount: z.number().int(),
  totalCount: z.number().int(),
  currentItemId: z.string().optional(),
  awaitedRunId: z.string().optional(),
  awaitedSince: z.string().optional(),
});

export const loopSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  status: loopStatusSchema,
  pausedReason: z.string().optional(),
  items: z.array(loopItemSchema),
  task: loopTaskTemplateSchema,
  /** Additive — absent means `none`, the pre-existing behaviour. */
  landing: loopLandingSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: loopProgressSchema,
});

/** `GET /loops` */
export const loopListResponseSchema = z.object({
  loops: z.array(loopSchema),
});

/** `GET /loops/:id` — the detail view adds the per-item receipt timeline. */
export const loopDetailResponseSchema = z.object({
  loop: loopSchema,
  receipts: z.array(loopReceiptSchema),
});

/**
 * `POST /loops` — items arrive as prompt strings, one per line in the composer.
 * The server assigns ids, so two identical prompts stay distinct items.
 */
export const createLoopBodySchema = z.object({
  name: z.string().min(1).max(200),
  /** Omitted means `none` — a branch per item, the invariant-preserving default. */
  landing: loopLandingSchema.optional(),
  description: z.string().max(2000).optional(),
  items: z.array(loopItemInputSchema).min(1).max(MAX_LOOP_ITEMS),
  task: loopTaskTemplateSchema,
  /** Start draining immediately instead of leaving the loop `idle`. */
  start: z.boolean().optional(),
});

/**
 * `PUT /loops/:id` — `expectedRevision` is the optimistic-concurrency guard,
 * answered with 409 on mismatch. Two cockpits editing one loop must not clobber
 * each other, and a stale editor is how an already-launched item would be rewritten.
 */
export const updateLoopBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  items: z.array(loopItemInputSchema).min(1).max(MAX_LOOP_ITEMS).optional(),
  task: loopTaskTemplateSchema.optional(),
  expectedRevision: z.number().int().positive(),
});

/**
 * `POST /loops/:id/items` — append pending items to an existing loop, including one
 * that is already running. Deliberately NOT a `PUT` of the whole item array: an
 * append must not bump the definition's revision, because receipt keys are derived
 * from it and a bumped revision would let the in-flight item relaunch.
 */
export const appendLoopItemsBodySchema = z.object({
  items: z.array(loopItemInputSchema).min(1).max(MAX_LOOP_ITEMS),
  /** Optimistic-concurrency guard; a stale value answers 409. */
  expectedRevision: z.number().int().positive().optional(),
});

export const appendLoopItemsResponseSchema = z.object({
  loop: loopSchema,
  /** How many items were actually added after blanks were dropped. */
  added: z.number().int().nonnegative(),
});

export const loopMutationResponseSchema = z.object({
  loop: loopSchema,
});

/** `GET /loop-receipts` — cursor-paged, capped at 100 rows per page. */
/**
 * `POST /loops/plan` — turn a free-text brief ("fix all open issues one by one")
 * into a drafted item list. Drafting NEVER starts anything: the response feeds the
 * composer's items field, and the ordinary Review-and-start confirmation still
 * gates the spend.
 */
export const planLoopItemsBodySchema = z.object({
  brief: z.string().min(1).max(20_000),
  /** Include open issues/PRs as planner context when the forge is available. */
  useForgeContext: z.boolean().optional(),
  /** Items the list already holds, so a second draft adds different work rather than
   *  re-proposing the same issues in different words. */
  existingItems: z.array(z.string().min(1).max(20_000)).max(MAX_LOOP_ITEMS).optional(),
});

export const planLoopItemsResponseSchema = z.object({
  items: z.array(z.string()),
  rationale: z.string(),
  /** True when nothing could be drafted — the client must not start a loop. */
  fallback: z.boolean(),
  /** How much forge context the planner actually saw, so the UI can be honest
   *  about a repo where `gh` was unavailable rather than implying it filtered. */
  context: z.object({
    issues: z.number().int().nonnegative(),
    pullRequests: z.number().int().nonnegative(),
    forgeAvailable: z.boolean(),
  }),
});

/** `GET /loop-receipts` — cursor-paged, capped at 100 rows per page. */
export const loopReceiptsQuerySchema = z.object({
  loopId: z.string().optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const loopReceiptsResponseSchema = z.object({
  receipts: z.array(loopReceiptSchema),
  /** Absent when there is no further page. */
  nextCursor: z.number().int().optional(),
});

export type LoopStatus = z.infer<typeof loopStatusSchema>;
export type LoopLanding = z.infer<typeof loopLandingSchema>;
export type LoopItem = z.infer<typeof loopItemSchema>;
export type LoopItemSource = z.infer<typeof loopItemSourceSchema>;
export type LoopItemInput = z.infer<typeof loopItemInputSchema>;
export type LoopTaskTemplate = z.infer<typeof loopTaskTemplateSchema>;
export type LoopReceiptStatus = z.infer<typeof loopReceiptStatusSchema>;
export type LoopReceipt = z.infer<typeof loopReceiptSchema>;
export type LoopProgress = z.infer<typeof loopProgressSchema>;
export type Loop = z.infer<typeof loopSchema>;
export type LoopListResponse = z.infer<typeof loopListResponseSchema>;
export type LoopDetailResponse = z.infer<typeof loopDetailResponseSchema>;
export type CreateLoopBody = z.infer<typeof createLoopBodySchema>;
export type UpdateLoopBody = z.infer<typeof updateLoopBodySchema>;
export type LoopMutationResponse = z.infer<typeof loopMutationResponseSchema>;
export type LoopReceiptsQuery = z.infer<typeof loopReceiptsQuerySchema>;
export type LoopReceiptsResponse = z.infer<typeof loopReceiptsResponseSchema>;
export type AppendLoopItemsBody = z.infer<typeof appendLoopItemsBodySchema>;
export type AppendLoopItemsResponse = z.infer<typeof appendLoopItemsResponseSchema>;
export type PlanLoopItemsBody = z.infer<typeof planLoopItemsBodySchema>;
export type PlanLoopItemsResponse = z.infer<typeof planLoopItemsResponseSchema>;
