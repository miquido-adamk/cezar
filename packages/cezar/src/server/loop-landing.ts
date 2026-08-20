/**
 * The production `LoopLandingOps` — the only place that connects a loop's landing
 * policy to a real forge.
 *
 * It lives in `server/` rather than `loops/` on purpose: `loops/` must not depend on
 * the HTTP layer or the forge drivers, so the controller takes these operations as an
 * injected interface and this module is the one implementation of it. The unit tests
 * inject a stub instead, which is why merge behaviour is testable with no `gh`, no
 * remote and no network.
 *
 * Everything here degrades rather than throws. A repo with no forge, no `gh`, or no
 * push permission must leave the loop working — the items still run, they simply end
 * as branches, which is what `landing: 'none'` does anyway.
 */
import { existsSync } from 'node:fs';
import type { LoopLandingOps } from '../loops/landing.ts';
import { LANDING_MERGE_METHOD } from '../loops/landing.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createDraftPr } from './pr.ts';
import { readHandoff } from '../handoff.ts';
import { forgetRefStatus, refNumberFromUrl } from './github.ts';
import { resolveForge } from './forge/index.ts';
import { getRepoInfo } from './git.ts';

export function createLoopLandingOps(input: {
  root: string;
  dataDir: string;
  store: RunStore;
  manager: RunManager;
  warn?: (message: string) => void;
}): LoopLandingOps {
  const { root, dataDir, store, manager } = input;
  const warn = input.warn ?? (() => {});

  return {
    async openPr(runId) {
      const run = store.getRun(runId);
      if (!run) return { ok: false, reason: 'the run record is gone' };
      // The same preconditions the manual "draft PR" button enforces. A loop item that
      // ran in the working tree, or produced no branch, has nothing to open.
      if (manager.isActive(runId)) return { ok: false, reason: 'the run is still active' };
      if (!run.worktreePath || !existsSync(run.worktreePath) || !run.branch) {
        return { ok: false, reason: 'no worktree or branch to publish' };
      }
      let outcome: Awaited<ReturnType<typeof createDraftPr>>;
      try {
        outcome = await createDraftPr({ repoRoot: root, run, handoffText: readHandoff(dataDir, runId) });
      } catch (cause) {
        // `createDraftPr` is documented never to throw; belt and braces, because a
        // throw here would abort an advance mid-flight.
        return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
      if (!outcome.ok) return { ok: false, reason: outcome.error };
      const number = refNumberFromUrl(outcome.url);
      if (number === null) return { ok: false, reason: `could not read a PR number from ${outcome.url}` };
      // Same cache correction the manual route makes: a number asked about before the
      // PR existed is cached as "no such number", and it exists now.
      forgetRefStatus(root, number);
      store.updateRun(runId, { pullRequestUrl: outcome.url });
      store.appendEvent(runId, {
        type: 'note',
        message: `loop opened draft PR: ${outcome.url}${outcome.dryRun ? ' (dry run — no real PR)' : ''}`,
      });
      return { ok: true, number, url: outcome.url };
    },

    async mergeState(prNumber) {
      try {
        const forge = resolveForge(await getRepoInfo(root));
        if (!forge?.prMergeState) return { canMerge: false, reason: 'merge state is unavailable for this repository' };
        // `refresh: true` deliberately: a cached answer is exactly how a loop would
        // decide a PR is unmergeable minutes after its checks went green.
        const answer = await forge.prMergeState(prNumber, { refresh: true });
        if (!answer.available) return { canMerge: false, reason: answer.reason ?? 'merge state is unavailable' };
        return {
          canMerge: answer.mergeState.canMerge,
          headSha: answer.mergeState.headSha,
          ...(answer.mergeState.canMerge ? {} : { reason: describeUnmergeable(answer.mergeState) }),
        };
      } catch (cause) {
        warn(`Loop merge-state check failed for #${prNumber}: ${cause instanceof Error ? cause.message : cause}`);
        return { canMerge: false, reason: 'the merge state could not be read' };
      }
    },

    async merge(prNumber, expectedHeadSha) {
      try {
        const forge = resolveForge(await getRepoInfo(root));
        if (!forge?.mergePR) return { ok: false, reason: 'merging is unavailable for this repository' };
        const result = await forge.mergePR(prNumber, { method: LANDING_MERGE_METHOD, expectedHeadSha });
        if (result.merged) {
          forgetRefStatus(root, prNumber);
          return { ok: true };
        }
        // `stale-head` is a retry with a fresh sha, NOT a refusal — reporting it as a
        // failure would strand a mergeable PR (the merge route's own 409 vocabulary).
        return { ok: false, reason: result.error ?? 'the merge was refused', stale: result.code === 'stale-head' };
      } catch (cause) {
        warn(`Loop merge failed for #${prNumber}: ${cause instanceof Error ? cause.message : cause}`);
        return { ok: false, reason: 'the merge request failed' };
      }
    },
  };
}

/** Turn a merge state into the one sentence a receipt should carry. */
function describeUnmergeable(state: { canOverride?: boolean; methods?: string[] }): string {
  if (state.methods && state.methods.length === 0) return 'no merge method is enabled for this repository';
  if (state.canOverride) return 'the required checks have not passed';
  return 'the pull request is not mergeable yet';
}
