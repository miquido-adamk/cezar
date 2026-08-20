/**
 * The loop controller (spec `.ai/specs/2026-08-19-task-loops.md`).
 *
 * Owns one project's loops: it observes that project's run store, decides when an
 * item is finished, and launches the next one. This is the "who fires this?"
 * answer the spec demands for every state a loop can be in — and the reason the
 * counter lives here rather than in an agent's context window, which dies with
 * the process.
 *
 * Three wake sources, all of them server-side and none of them a human:
 *   1. a `run` event whose run id is one this controller awaits,
 *   2. a `deleted` event for an awaited run,
 *   3. the low-frequency reconciling sweep, which converts silence into a named
 *      classification (a pruned record, a forever-queued run).
 *
 * Advancement is deliberately serialized per loop by an in-process promise chain.
 * Two events for the same loop arriving in the same tick must not both select
 * "the next pending item" and launch it twice — the receipt key would catch the
 * duplicate, but only after both launches had already been paid for.
 */
import { AwaitRegistry, classify } from './barrier.ts';
import { LoopStore } from './store.ts';
import { RECONCILE_INTERVAL_MS, type LoopDefinition, type LoopItem, type LoopReceipt } from './types.ts';
import { attemptMerge, openForLanding, type LandingOutcome, type LoopLandingOps } from './landing.ts';
import { launchFromSource, type LaunchTemplate } from '../runs/launch-source.ts';
import type { RunManager } from '../workflows/run.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';

export interface LoopControllerOptions {
  root: string;
  store: LoopStore;
  runStore: RunStore;
  manager: RunManager;
  now?: () => Date;
  warn?: (message: string) => void;
  /** Emitted after any durable change, for the workspace SSE `loop-change` signal. */
  onChange?: (loopId: string) => void;
  /** Injectable for tests; production uses a real unref'd interval. */
  scheduleReconcile?: (tick: () => void) => () => void;
  /**
   * Forge operations for the per-loop landing policy. INJECTED so `loops/` never
   * imports `server/`, and so merge behaviour is testable without a remote, a `gh`
   * binary, or a network. Absent means landing degrades to `none` for every loop —
   * a cockpit with no forge simply leaves branches, which is the old behaviour.
   */
  landing?: LoopLandingOps;
}

export class LoopController {
  private readonly registry = new AwaitRegistry();
  private readonly advancing = new Map<string, Promise<void>>();
  private stopReconcile: (() => void) | undefined;
  private attached = false;

  private readonly onRun = (run: RunRecord): void => {
    const loopId = this.registry.loopAwaiting(run.id);
    if (!loopId) return;
    // The store emits on every mutation, so ignore anything that is not a real
    // status transition. Without this the controller would reclassify — and
    // rewrite receipts — on every token-count update of a busy run.
    if (!this.registry.observe(run.id, run.status)) return;
    void this.enqueueAdvance(loopId);
  };

  private readonly onDeleted = (runId: string): void => {
    const loopId = this.registry.loopAwaiting(runId);
    if (!loopId) return;
    void this.enqueueAdvance(loopId);
  };

  constructor(private readonly options: LoopControllerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private warn(message: string): void {
    this.options.warn?.(message);
  }

  /**
   * Begin observing. Idempotent, so a second call from a re-registered project is
   * harmless rather than a duplicate subscription.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.options.runStore.on('run', this.onRun);
    this.options.runStore.on('deleted', this.onDeleted);
    const schedule =
      this.options.scheduleReconcile ??
      ((tick: () => void) => {
        const timer = setInterval(tick, RECONCILE_INTERVAL_MS);
        // Never hold the process open for a sweep whose only job is to notice
        // silence — the CLI must still be able to exit.
        timer.unref?.();
        return () => clearInterval(timer);
      });
    this.stopReconcile = schedule(() => void this.reconcile());
    this.resumeFromDisk();
  }

  /**
   * Stop observing, leaving every running loop `paused` with a durable reason.
   *
   * Called on project disposal and on shutdown. A loop that was mid-item is NOT
   * cancelled: the run keeps going and its worktree survives, because the user's
   * work is worth more than a tidy state machine. Re-registering the project
   * resumes through the ordinary boot path.
   */
  detach(reason: 'project-detached' | 'shutdown'): void {
    if (!this.attached) return;
    this.attached = false;
    this.options.runStore.off('run', this.onRun);
    this.options.runStore.off('deleted', this.onDeleted);
    this.stopReconcile?.();
    this.stopReconcile = undefined;

    if (reason === 'project-detached') {
      for (const loop of this.options.store.listLoops()) {
        if (loop.status !== 'running') continue;
        const state = this.options.store.getState(loop.id);
        if (state?.lastReceiptId) {
          this.options.store.resolveReceipt(state.lastReceiptId, {
            status: 'project-detached',
            reason: 'The project was removed from the workspace while this item was in flight. The run and its worktree were left untouched.',
          });
        }
        this.pause(loop.id, 'The project was removed from the workspace. Re-adding it resumes this loop.');
      }
    }
    for (const loop of this.options.store.listLoops()) this.registry.forgetLoop(loop.id);
  }

  /**
   * Re-establish awaits after a restart, and reconcile any receipt that was
   * `reserved` when the process died.
   *
   * A reserved receipt with a matching run finalizes without relaunching; one with
   * no run at all becomes `launch-error` with explicit retry. This is the only
   * place a `reserved` row may be rewritten.
   */
  private resumeFromDisk(): void {
    const runsByReceipt = new Map(
      this.options.runStore
        .listRuns()
        .flatMap((run) => (run.loop ? [[run.loop.receiptId, run.id] as const] : [])),
    );

    for (const loop of this.options.store.listLoops()) {
      for (const receipt of this.options.store.latestReceiptsForLoop(loop.id).values()) {
        if (receipt.status !== 'reserved') continue;
        const runId = runsByReceipt.get(receipt.receiptId);
        if (runId) {
          // The launch did happen; keep awaiting that run rather than relaunching.
          this.options.store.resolveReceipt(receipt.receiptId, { status: 'reserved', runId });
          this.registry.await_(loop.id, runId);
        } else {
          this.options.store.resolveReceipt(receipt.receiptId, {
            status: 'launch-error',
            reason: 'Cezar restarted before this item\'s run was created. Nothing was started, and an explicit retry is available.',
          });
          this.pause(loop.id, 'An item could not be launched because cezar restarted mid-launch. Retry it from the loop\'s history.');
        }
      }

      const state = this.options.store.getState(loop.id);
      if (loop.status === 'running' && state?.awaitedRunId && !this.registry.awaitedRun(loop.id)) {
        this.registry.await_(loop.id, state.awaitedRunId);
      }
      // A loop recorded as running with nothing in flight is a loop that lost its
      // advance to a crash — advance it now rather than leaving it stuck.
      if (loop.status === 'running' && !this.registry.awaitedRun(loop.id)) {
        void this.enqueueAdvance(loop.id);
      }
    }
  }

  /** Start (or restart) a loop from its first unfinished item. */
  async start(loopId: string): Promise<void> {
    const loop = this.options.store.getLoop(loopId);
    if (!loop) return;
    this.options.store.updateLoop(loopId, { status: 'running', pausedReason: undefined });
    await this.enqueueAdvance(loopId);
  }

  pause(loopId: string, reason: string): void {
    this.options.store.updateLoop(loopId, { status: 'paused', pausedReason: reason });
    const state = this.options.store.getState(loopId);
    if (state) this.options.store.putState({ ...state, status: 'paused' });
    this.options.onChange?.(loopId);
  }

  async resume(loopId: string): Promise<void> {
    const loop = this.options.store.getLoop(loopId);
    if (!loop || loop.status === 'completed') return;
    this.options.store.updateLoop(loopId, { status: 'running', pausedReason: undefined });
    await this.enqueueAdvance(loopId);
  }

  /**
   * Skip the in-flight item and advance — the only supported way past a stalled
   * item. Deliberately does NOT cancel the run: that stays the user's own explicit
   * action, because the run may be doing something valuable.
   */
  async skipCurrent(loopId: string): Promise<void> {
    const state = this.options.store.getState(loopId);
    if (state?.lastReceiptId) {
      this.options.store.resolveReceipt(state.lastReceiptId, {
        status: 'skipped',
        reason: 'Skipped by the user. The run it had started, if any, was left running.',
      });
      this.options.store.putState({ ...state, skippedCount: state.skippedCount + 1, awaitedRunId: undefined });
    }
    this.registry.forgetLoop(loopId);
    this.options.store.updateLoop(loopId, { status: 'running', pausedReason: undefined });
    await this.enqueueAdvance(loopId);
  }

  /** Serialize advancement per loop, so two events in one tick cannot double-launch. */
  private enqueueAdvance(loopId: string): Promise<void> {
    const previous = this.advancing.get(loopId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.advance(loopId))
      .catch((error) => {
        this.warn(`Loop ${loopId} failed to advance: ${error instanceof Error ? error.message : String(error)}`);
      });
    this.advancing.set(loopId, next);
    return next;
  }

  /**
   * The whole decision: settle the current item if it is done, then launch the
   * next pending one.
   */
  private async advance(loopId: string): Promise<void> {
    const loop = this.options.store.getLoop(loopId);
    if (!loop || loop.status === 'completed') return;

    const state =
      this.options.store.getState(loopId) ??
      this.options.store.putState({
        loopId,
        revision: loop.revision,
        status: loop.status,
        completedCount: 0,
        skippedCount: 0,
      });

    // 0. Landing wait. A finished run is not a merged PR: checks have not started
    // when the agent stops, so `merge` becomes a SECOND non-terminal wait per item.
    // Like every other wait here it has a deadline — without one a red build would
    // stall the whole backlog with no automatic exit.
    let cursor = state;
    if (cursor.landing && this.options.landing) {
      const wait = cursor.landing;
      const attempt = await attemptMerge(wait.prNumber, this.options.landing, {
        since: wait.since,
        now: this.now(),
      });
      if (attempt.kind === 'waiting') {
        // Deliberately silent: the sweep asks again, and emitting a change event per
        // poll would repaint the cockpit every 60s for an item that did not move.
        return;
      }
      if (cursor.lastReceiptId) {
        this.options.store.resolveReceipt(cursor.lastReceiptId, {
          status: attempt.kind === 'merged' ? 'merged' : 'merge-blocked',
          runId: wait.runId,
          prNumber: wait.prNumber,
          reason:
            attempt.kind === 'merged'
              ? `Merged PR #${wait.prNumber}.`
              : // The PR is LEFT OPEN; saying so is the difference between a dead end
                // and an action the user can take.
                `${attempt.reason}. PR #${wait.prNumber} is still open for you.`,
        });
      }
      cursor = this.options.store.putState({
        ...cursor,
        landing: undefined,
        awaitedRunId: undefined,
        awaitedSince: undefined,
        // The RUN finished either way — only the merge did not. Counting a
        // merge-blocked item as skipped would misreport work that actually happened.
        completedCount: cursor.completedCount + 1,
      });
      this.registry.forgetLoop(loopId);
      this.options.onChange?.(loopId);
    }

    // 1. Settle whatever is in flight.
    const awaitedRunId = this.registry.awaitedRun(loopId) ?? cursor.awaitedRunId;
    if (awaitedRunId) {
      const verdict = classify({
        run: this.options.runStore.getRun(awaitedRunId),
        awaitedSince: cursor.awaitedSince,
        now: this.now(),
      });
      if (verdict.kind === 'pending') return;

      // A finished run under a landing policy opens its PR before the item is called
      // done, so `completed` never claims more than actually happened.
      let landed: LandingOutcome = { kind: 'skip' };
      if (verdict.kind === 'finished' && this.options.landing) {
        landed = await openForLanding(loop.landing, awaitedRunId, this.options.landing);
      }

      if (landed.kind === 'awaiting-merge') {
        // The receipt stays `reserved`: the item is not settled until its PR lands or
        // the deadline says it never will. Marking it `completed` here and merging
        // afterwards would let the loop pick the next item while this PR is unmerged,
        // which is exactly the sequencing `merge` exists to provide.
        this.options.store.putState({
          ...cursor,
          landing: {
            itemId: cursor.currentItemId ?? '',
            runId: awaitedRunId,
            prNumber: landed.prNumber,
            since: this.now().toISOString(),
          },
        });
        this.options.onChange?.(loopId);
        return;
      }

      if (cursor.lastReceiptId) {
        this.options.store.resolveReceipt(
          cursor.lastReceiptId,
          verdict.kind === 'finished'
            ? {
                status: 'completed',
                runId: awaitedRunId,
                ...(landed.kind === 'pr-open' ? { prNumber: landed.prNumber } : {}),
                reason:
                  landed.kind === 'pr-open'
                    ? `The run finished as \`${verdict.runStatus}\` and opened PR #${landed.prNumber}.`
                    : landed.kind === 'failed'
                      ? // Not a pause: a no-op item with no diff is ordinary, and one
                        // failed PR must not strand the rest of the backlog.
                        `The run finished as \`${verdict.runStatus}\`, but no pull request was opened: ${landed.reason}.`
                      : `The run finished as \`${verdict.runStatus}\`.`,
              }
            : { status: verdict.receiptStatus, runId: awaitedRunId, reason: verdict.reason },
        );
      }
      this.registry.forgetLoop(loopId);
      const settled = this.options.store.putState({
        ...cursor,
        awaitedRunId: undefined,
        awaitedSince: undefined,
        completedCount: verdict.kind === 'finished' ? cursor.completedCount + 1 : cursor.completedCount,
        skippedCount: verdict.kind === 'finished' ? cursor.skippedCount : cursor.skippedCount + 1,
      });

      // A blocked item pauses the loop rather than advancing past it (Q5).
      if (verdict.kind === 'blocked') {
        this.pause(loopId, verdict.reason);
        return;
      }

      // A CANCELLED item pauses too, and this is a correction: `cancelled` is terminal,
      // so the loop used to treat it as "this one is done, start the next" and launched
      // item N+1 seconds after a human hit Cancel. Cancelling is a person saying stop —
      // reading it as "skip this and keep spending" is the opposite of the intent, and it
      // is the one wrong guess here that costs money.
      //
      // Skipping stays available and stays distinct: `skip-current` advances deliberately
      // and never cancels the run. Cancel means stop; skip means move on.
      if (verdict.kind === 'finished' && verdict.runStatus === 'cancelled') {
        this.pause(
          loopId,
          `item ${(this.options.store.getLoop(loopId)?.items.findIndex((i) => i.id === cursor.currentItemId) ?? 0) + 1} was cancelled`,
        );
        return;
      }
      void settled;
    }

    // Paused after settling? Stop before launching anything new.
    const current = this.options.store.getLoop(loopId);
    if (!current || current.status !== 'running') {
      this.options.onChange?.(loopId);
      return;
    }

    // 2. Select the next item with no terminal receipt under this revision.
    const receipts = this.options.store.latestReceiptsForLoop(loopId, current.revision);
    const nextIndex = current.items.findIndex((item) => !isSettled(receipts.get(item.id)));
    if (nextIndex === -1) {
      this.options.store.updateLoop(loopId, { status: 'completed', pausedReason: undefined });
      const done = this.options.store.getState(loopId);
      if (done) this.options.store.putState({ ...done, status: 'completed', currentItemId: undefined });
      this.registry.forgetLoop(loopId);
      this.options.onChange?.(loopId);
      return;
    }

    await this.launchItem(current, current.items[nextIndex]!, nextIndex);
  }

  /** Reserve, launch, record. Reservation happens BEFORE the launch so a crash
   *  between the two is recoverable as `launch-error` rather than invisible. */
  private async launchItem(loop: LoopDefinition, item: LoopItem, index: number): Promise<void> {
    const { receipt, created } = this.options.store.reserveReceipt({
      loopId: loop.id,
      revision: loop.revision,
      itemId: item.id,
      itemIndex: index,
    });
    if (!created && receipt.status !== 'reserved') return; // Already resolved; nothing to do.

    // A per-item source OVERRIDES the loop's shared template, because a backlog is
    // rarely homogeneous: one issue wants `om-auto-fix-issue`, the next is a spec that
    // wants a different workflow. Absent → the loop's template, which stays the default
    // and the common case.
    //
    // A skill runs as the same one-step inline chain the composer and the inbox use
    // (spec 008), so an item-level skill needs no new launch mechanism.
    const override: Pick<LaunchTemplate, 'workflow' | 'steps'> | undefined = item.source
      ? item.source.kind === 'skill'
        ? { steps: [{ id: 'task', name: item.source.ref, skill: item.source.ref, prompt: '{{task}}' }] }
        : { workflow: item.source.ref }
      : undefined;

    const template: LaunchTemplate = {
      prompt: item.prompt,
      workflow: override ? override.workflow : loop.task.workflow,
      steps: (override ? override.steps : (loop.task.steps as LaunchTemplate['steps'])) as LaunchTemplate['steps'],
      model: loop.task.model,
      runner: loop.task.runner as LaunchTemplate['runner'],
      agentProfile: loop.task.agentProfile,
      systemPrompt: loop.task.systemPrompt,
      worktree: loop.task.worktree,
      autonomous: loop.task.autonomous,
      generateFollowups: loop.task.generateFollowups,
    };

    try {
      const { runId } = await launchFromSource({
        root: this.options.root,
        manager: this.options.manager,
        store: this.options.runStore,
        template,
        provenance: {
          loop: {
            loopId: loop.id,
            revision: loop.revision,
            receiptId: receipt.receiptId,
            itemId: item.id,
            itemIndex: index,
            trigger: 'loop',
          },
        },
      });
      const observedAt = this.now().toISOString();
      this.options.store.resolveReceipt(receipt.receiptId, { status: 'reserved', runId });
      this.registry.await_(loop.id, runId);
      const state = this.options.store.getState(loop.id);
      this.options.store.putState({
        loopId: loop.id,
        revision: loop.revision,
        status: 'running',
        currentItemId: item.id,
        awaitedRunId: runId,
        awaitedSince: observedAt,
        lastReceiptId: receipt.receiptId,
        completedCount: state?.completedCount ?? 0,
        skippedCount: state?.skippedCount ?? 0,
      });
      this.options.onChange?.(loop.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.resolveReceipt(receipt.receiptId, {
        status: 'launch-error',
        reason: `The run could not be created: ${message}`,
      });
      this.pause(loop.id, `An item could not be launched: ${message}`);
    }
  }

  /**
   * The reconciling floor. Re-classifies every awaited run, which is the only way
   * a pruned record or a forever-queued run is ever noticed — neither produces a
   * usable event.
   */
  async reconcile(): Promise<void> {
    for (const runId of this.registry.awaitedRunIds()) {
      const loopId = this.registry.loopAwaiting(runId);
      if (loopId) await this.enqueueAdvance(loopId);
    }
  }
}

/** A receipt that ends an item's participation in this revision of the loop. */
function isSettled(receipt: LoopReceipt | undefined): boolean {
  if (!receipt) return false;
  return receipt.status !== 'reserved';
}
