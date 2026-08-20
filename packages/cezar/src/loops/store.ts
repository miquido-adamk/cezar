/**
 * Project-local persistence for task loops (spec `.ai/specs/2026-08-19-task-loops.md`).
 *
 * Three optional files under `.ai/cezar/`, following the same discipline as the
 * automations store and the workspace registry: read-modify-write, atomic
 * tmp+rename at `0600`, per-entry salvage so one corrupt row never evicts the
 * file, and append-only receipts with bounded compaction.
 *
 * Every file is OPTIONAL. A project that has never used loops has none of them,
 * and this store must be constructible and readable in that state — the
 * coordinator asks "does this project have loops?" before instantiating anything
 * heavier, and the answer has to be cheap and non-destructive.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  isTerminalReceipt,
  loopDefinitionSchema,
  MAX_LOOP_ITEMS,
  loopReceiptSchema,
  loopStateFileSchema,
  receiptKeyFor,
  RECEIPTS_COMPACT_THRESHOLD,
  RECEIPTS_RETAIN_TERMINAL,
  type LoopDefinition,
  type LoopReceipt,
  type LoopItem,
  type LoopItemSource,
  type LoopReceiptStatus,
  type LoopRuntimeState,
} from './types.ts';

export const LOOPS_FILE = 'loops.json';
export const LOOP_STATE_FILE = 'loop-state.json';
export const LOOP_RECEIPTS_FILE = 'loop-receipts.ndjson';

/** Files this store owns, for `ensureDataGitignore`. Exported so the gitignore
 *  list and the store cannot drift apart. */
export const LOOP_DATA_FILES = [
  LOOPS_FILE,
  `${LOOPS_FILE}.tmp`,
  LOOP_STATE_FILE,
  `${LOOP_STATE_FILE}.tmp`,
  LOOP_RECEIPTS_FILE,
  `${LOOP_RECEIPTS_FILE}.tmp`,
];

/**
 * One submitted item, in either accepted form. A bare string is how most items are
 * written; the object form carries a per-item skill/workflow override.
 */
export type LoopItemInput = string | { prompt: string; source?: LoopItemSource };

/** Normalize submitted items, assigning ids here so the caller never invents them and
 *  two items may carry identical prompts. Blank prompts are dropped. */
function toItems(inputs: readonly LoopItemInput[]): LoopItem[] {
  const items: LoopItem[] = [];
  for (const input of inputs) {
    const prompt = (typeof input === 'string' ? input : input.prompt).trim();
    if (!prompt) continue;
    const source = typeof input === 'string' ? undefined : input.source;
    items.push({ id: randomUUID(), prompt, ...(source ? { source } : {}) });
  }
  return items;
}

export class LoopStore {
  private readonly dataDir: string;

  constructor(
    private readonly root: string,
    private readonly options: { now?: () => Date; warn?: (message: string) => void } = {},
  ) {
    this.dataDir = join(root, '.ai', 'cezar');
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private warn(message: string): void {
    this.options.warn?.(message);
  }

  private path(file: string): string {
    return join(this.dataDir, file);
  }

  /** Cheap existence probe used by the coordinator before instantiating anything. */
  hasDefinitions(): boolean {
    return existsSync(this.path(LOOPS_FILE));
  }

  // ---- definitions ------------------------------------------------------------

  /**
   * Read every loop definition, salvaging per entry.
   *
   * A row that fails validation is dropped with a warning rather than taking the
   * whole file down — the alternative is that one hand-edited loop makes every
   * other loop in the project invisible.
   */
  listLoops(): LoopDefinition[] {
    const raw = this.readJson(LOOPS_FILE);
    if (raw === undefined) return [];
    // Read the rows from the RAW value, never from a whole-file parse. `loops` is
    // declared `.catch([])`, so a single unsalvageable row would otherwise collapse
    // the entire array to empty — which is exactly the "one bad row evicts the
    // file" failure that per-entry salvage exists to prevent.
    const container = raw as { loops?: unknown };
    const rows: unknown[] = Array.isArray(container.loops) ? container.loops : [];
    const loops: LoopDefinition[] = [];
    for (const row of rows) {
      const definition = safeDefinition(row);
      if (definition) loops.push(definition);
      else this.warn(`Dropping an unreadable loop definition in ${LOOPS_FILE}`);
    }
    return loops;
  }

  getLoop(loopId: string): LoopDefinition | undefined {
    return this.listLoops().find((loop) => loop.id === loopId);
  }

  /** Create a loop. `items` are given prompts; ids are assigned here so the caller
   *  never has to invent them and two items can carry identical prompts. */
  createLoop(input: {
    name: string;
    description?: string;
    prompts: readonly LoopItemInput[];
    task: LoopDefinition['task'];
    landing?: LoopDefinition['landing'];
  }): LoopDefinition {
    const timestamp = this.now().toISOString();
    const definition: LoopDefinition = {
      id: randomUUID(),
      revision: 1,
      name: input.name,
      description: input.description,
      status: 'idle',
      items: toItems(input.prompts),
      task: input.task,
      // Omitted stays omitted rather than becoming an explicit 'none', so a loop
      // created before landing existed and one created without it read identically.
      ...(input.landing && input.landing !== 'none' ? { landing: input.landing } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeLoops([...this.listLoops(), definition]);
    return definition;
  }

  /**
   * Append new pending items to a loop **without bumping `revision`** — the
   * supported way to extend a loop that is already running.
   *
   * The stable revision is the whole point, and it is not an oversight. Receipt
   * keys are `${loopId}:${revision}:${itemId}`, so bumping the revision moves the
   * in-flight item's reservation into a namespace nothing looks in: startup
   * reconciliation would then see an unreserved item and **relaunch work that is
   * already running**, putting two live children in a width-1 loop. `updateLoop`
   * documents the mirror-image of this hazard for status-only patches.
   *
   * Keeping the revision is safe precisely because appending changes no existing
   * item's identity or position: each new item gets a fresh `itemId`, so its
   * receipt key is unique under the current revision anyway.
   *
   * A `completed` loop becomes `running` again, because appending work to a
   * finished loop can only mean "do this too" — leaving it `completed` with
   * pending items would be a state whose only exit is a human noticing. A
   * `paused` loop stays paused: the pause is a decision the user has not revisited.
   */
  appendItems(
    loopId: string,
    prompts: readonly LoopItemInput[],
    expectedRevision?: number,
  ): { ok: true; definition: LoopDefinition; added: number } | { ok: false; reason: 'not-found' | 'revision-mismatch' | 'too-many' } {
    const loops = this.listLoops();
    const index = loops.findIndex((loop) => loop.id === loopId);
    if (index === -1) return { ok: false, reason: 'not-found' };
    const current = loops[index]!;
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      return { ok: false, reason: 'revision-mismatch' };
    }
    const additions = toItems(prompts);
    if (additions.length === 0) return { ok: true, definition: current, added: 0 };
    if (current.items.length + additions.length > MAX_LOOP_ITEMS) return { ok: false, reason: 'too-many' };
    const next: LoopDefinition = {
      ...current,
      items: [...current.items, ...additions],
      status: current.status === 'completed' ? 'running' : current.status,
      // Deliberately NOT `revision: current.revision + 1` — see the note above.
      updatedAt: this.now().toISOString(),
    };
    loops[index] = next;
    this.writeLoops(loops);
    return { ok: true, definition: next, added: additions.length };
  }

  /**
   * Replace a loop, bumping `revision`.
   *
   * `expectedRevision` is the optimistic-concurrency guard the `PUT` route
   * surfaces as a 409: two cockpits editing one loop must not silently clobber
   * each other, and a stale editor is exactly how an already-launched item would
   * get rewritten.
   */
  updateLoop(
    loopId: string,
    /** `items`, when present, is a full REPLACEMENT in submitted form — the store assigns
     *  ids, so no caller has to mint them (one route was minting `item-<i>-<Date.now()>`,
     *  which is neither unique under load nor the store's business). */
    patch: Partial<Pick<LoopDefinition, 'name' | 'description' | 'task' | 'status' | 'pausedReason'>> & {
      items?: readonly LoopItemInput[];
    },
    expectedRevision?: number,
  ): { ok: true; definition: LoopDefinition } | { ok: false; reason: 'not-found' | 'revision-mismatch' } {
    const loops = this.listLoops();
    const index = loops.findIndex((loop) => loop.id === loopId);
    if (index === -1) return { ok: false, reason: 'not-found' };
    const current = loops[index]!;
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      return { ok: false, reason: 'revision-mismatch' };
    }
    // A status-only transition (pause/resume/complete) must NOT bump the revision:
    // revision identifies the item set, and receipt keys are derived from it, so
    // bumping it on a pause would orphan the in-flight item's receipt key.
    const itemsOrTaskChanged = patch.items !== undefined || patch.task !== undefined;
    const { items: submittedItems, ...rest } = patch;
    const next: LoopDefinition = {
      ...current,
      ...rest,
      items: submittedItems === undefined ? current.items : toItems(submittedItems),
      // Clearing `pausedReason` has to be expressible, so an explicit `undefined`
      // in the patch wins over the current value.
      pausedReason: 'pausedReason' in patch ? patch.pausedReason : current.pausedReason,
      revision: itemsOrTaskChanged ? current.revision + 1 : current.revision,
      updatedAt: this.now().toISOString(),
    };
    loops[index] = next;
    this.writeLoops(loops);
    return { ok: true, definition: next };
  }

  deleteLoop(loopId: string): boolean {
    const loops = this.listLoops();
    const remaining = loops.filter((loop) => loop.id !== loopId);
    if (remaining.length === loops.length) return false;
    this.writeLoops(remaining);
    const states = this.listStates().filter((state) => state.loopId !== loopId);
    this.writeStates(states);
    return true;
  }

  private writeLoops(loops: LoopDefinition[]): void {
    this.writeJson(LOOPS_FILE, { version: 1 as const, loops });
  }

  // ---- runtime state ----------------------------------------------------------

  listStates(): LoopRuntimeState[] {
    const raw = this.readJson(LOOP_STATE_FILE);
    if (raw === undefined) return [];
    const parsed = loopStateFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.warn(`Ignoring an unreadable ${LOOP_STATE_FILE}; loop cursors will be rebuilt from receipts`);
      return [];
    }
    return parsed.data.states;
  }

  getState(loopId: string): LoopRuntimeState | undefined {
    return this.listStates().find((state) => state.loopId === loopId);
  }

  /** Merge-write one loop's cursor, leaving every other loop's cursor untouched. */
  putState(state: LoopRuntimeState): LoopRuntimeState {
    const states = this.listStates();
    const index = states.findIndex((entry) => entry.loopId === state.loopId);
    if (index === -1) states.push(state);
    else states[index] = state;
    this.writeStates(states);
    return state;
  }

  private writeStates(states: LoopRuntimeState[]): void {
    this.writeJson(LOOP_STATE_FILE, { version: 1 as const, states });
  }

  // ---- receipts ---------------------------------------------------------------

  /** Every receipt row, oldest first, salvaging per line. */
  listReceipts(): LoopReceipt[] {
    const path = this.path(LOOP_RECEIPTS_FILE);
    if (!existsSync(path)) return [];
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const receipts: LoopReceipt[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = loopReceiptSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) receipts.push(parsed.data);
      } catch {
        // One torn line (a crash mid-append) must not hide the rest of the log.
      }
    }
    return receipts;
  }

  /**
   * The latest row per receipt id — the log is append-only, so an item's current
   * state is its newest row, not its first.
   */
  latestReceipts(): Map<string, LoopReceipt> {
    const latest = new Map<string, LoopReceipt>();
    for (const receipt of this.listReceipts()) {
      const existing = latest.get(receipt.receiptId);
      if (!existing || receipt.seq >= existing.seq) latest.set(receipt.receiptId, receipt);
    }
    return latest;
  }

  /** Latest row for one loop's items, keyed by item id. */
  latestReceiptsForLoop(loopId: string, revision?: number): Map<string, LoopReceipt> {
    const byItem = new Map<string, LoopReceipt>();
    for (const receipt of this.latestReceipts().values()) {
      if (receipt.loopId !== loopId) continue;
      if (revision !== undefined && receipt.revision !== revision) continue;
      const existing = byItem.get(receipt.itemId);
      if (!existing || receipt.seq >= existing.seq) byItem.set(receipt.itemId, receipt);
    }
    return byItem;
  }

  /**
   * Reserve a receipt for an item about to launch.
   *
   * Returns the existing row when this `(loop, revision, item)` was already
   * reserved or resolved — the idempotency that makes a restart-time relaunch
   * impossible. A caller that gets back a non-`reserved` row must not launch.
   */
  reserveReceipt(input: {
    loopId: string;
    revision: number;
    itemId: string;
    itemIndex: number;
    trigger?: 'loop' | 'manual';
  }): { receipt: LoopReceipt; created: boolean } {
    const receiptKey = receiptKeyFor(input.loopId, input.revision, input.itemId);
    const existing = [...this.latestReceipts().values()].find((row) => row.receiptKey === receiptKey);
    if (existing) return { receipt: existing, created: false };
    const timestamp = this.now().toISOString();
    const receipt: LoopReceipt = {
      seq: this.nextSeq(),
      receiptId: randomUUID(),
      receiptKey,
      loopId: input.loopId,
      revision: input.revision,
      itemId: input.itemId,
      itemIndex: input.itemIndex,
      trigger: input.trigger ?? 'loop',
      status: 'reserved',
      observedAt: timestamp,
      updatedAt: timestamp,
    };
    this.appendReceipt(receipt);
    return { receipt, created: true };
  }

  /** Append a new latest-state row for an existing receipt. */
  resolveReceipt(
    receiptId: string,
    patch: { status: LoopReceiptStatus; reason?: string; runId?: string; prNumber?: number },
  ): LoopReceipt | undefined {
    const current = this.latestReceipts().get(receiptId);
    if (!current) return undefined;
    const next: LoopReceipt = {
      ...current,
      seq: this.nextSeq(),
      status: patch.status,
      reason: patch.reason ?? current.reason,
      runId: patch.runId ?? current.runId,
      prNumber: patch.prNumber ?? current.prNumber,
      updatedAt: this.now().toISOString(),
    };
    this.appendReceipt(next);
    return next;
  }

  appendReceipt(receipt: LoopReceipt): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = this.path(LOOP_RECEIPTS_FILE);
    try {
      writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: 'a', mode: 0o600 });
    } catch (error) {
      this.warn(`Unable to append a loop receipt: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.compactIfNeeded();
  }

  private nextSeq(): number {
    const receipts = this.listReceipts();
    return receipts.length ? Math.max(...receipts.map((row) => row.seq)) + 1 : 0;
  }

  /**
   * Bound the receipt log, retaining every unresolved row plus the most recent
   * terminal ones.
   *
   * Unresolved rows are retained unconditionally and deliberately: a `reserved`
   * row is the only evidence that a launch may have happened, and dropping it
   * would let startup reconciliation relaunch an item that already ran.
   */
  private compactIfNeeded(): void {
    const receipts = this.listReceipts();
    if (receipts.length <= RECEIPTS_COMPACT_THRESHOLD) return;
    const latest = [...this.latestReceipts().values()];
    const unresolved = latest.filter((row) => !isTerminalReceipt(row.status));
    const terminal = latest
      .filter((row) => isTerminalReceipt(row.status))
      .sort((a, b) => a.seq - b.seq)
      .slice(-RECEIPTS_RETAIN_TERMINAL);
    const kept = [...unresolved, ...terminal].sort((a, b) => a.seq - b.seq);
    const path = this.path(LOOP_RECEIPTS_FILE);
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''), {
        mode: 0o600,
      });
      renameSync(temporary, path);
    } catch (error) {
      this.warn(`Unable to compact the loop receipt log: ${error instanceof Error ? error.message : String(error)}`);
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Best effort; a stray tmp file is gitignored and harmless.
      }
    }
  }

  // ---- file helpers -----------------------------------------------------------

  private readJson(file: string): unknown {
    const path = this.path(file);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.warn(`Ignoring unparseable ${file}`);
      return undefined;
    }
  }

  private writeJson(file: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = this.path(file);
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      this.warn(`Unable to write ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Validate one definition row, returning undefined when it is unsalvageable.
 *  Validates against the ELEMENT schema directly — going through the file schema
 *  would hit the `.catch([])` on `loops` and report a bad row as an empty list. */
function safeDefinition(row: unknown): LoopDefinition | undefined {
  const parsed = loopDefinitionSchema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}
