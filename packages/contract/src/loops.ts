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

/** Ceiling on items in one loop, mirrored from the server's own constant. */
export const MAX_LOOP_ITEMS = 100;

export const loopStatusSchema = z.enum(['idle', 'running', 'paused', 'completed']);

export const loopItemSchema = z.object({
  id: z.string(),
  prompt: z.string(),
});

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
  runner: z.enum(['claude', 'claude-cli', 'codex', 'opencode']).optional(),
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
  description: z.string().max(2000).optional(),
  items: z.array(z.string().min(1).max(20_000)).min(1).max(MAX_LOOP_ITEMS),
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
  items: z.array(z.string().min(1).max(20_000)).min(1).max(MAX_LOOP_ITEMS).optional(),
  task: loopTaskTemplateSchema.optional(),
  expectedRevision: z.number().int().positive(),
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
export type LoopItem = z.infer<typeof loopItemSchema>;
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
export type PlanLoopItemsBody = z.infer<typeof planLoopItemsBodySchema>;
export type PlanLoopItemsResponse = z.infer<typeof planLoopItemsResponseSchema>;
