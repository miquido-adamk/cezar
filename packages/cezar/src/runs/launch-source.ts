/**
 * Source-neutral run launching (spec `.ai/specs/2026-08-19-task-loops.md`, Phase 0).
 *
 * One place that turns "some non-human source wants a task run" into a started
 * run, so a new source does not re-derive the workflow-resolution rules, the
 * provenance-at-construction rule, or the durability rule. Extracted as its own
 * change because it is behavior-preserving: nothing that exists today routes
 * through it yet.
 *
 * GitHub Automations is deliberately NOT migrated onto this. Its launch path
 * renders untrusted GitHub event text into the prompt and takes a
 * `GithubCandidate` throughout, which makes it a separate and riskier refactor
 * than a mechanical extraction — see the spec's Phase 0 note.
 *
 * Two rules this module exists to enforce, both learned from the automation path:
 *
 * 1. **Provenance is set at construction, never patched on.** `launchAutomationRun`
 *    calls `updateRun(id, { automation })` after `startRun` returns. That is
 *    survivable for automations, which find their runs by scanning provenance
 *    after the fact, but not for a consumer that must attribute a run the moment
 *    it appears: between `startRun` and the patch, the record exists with no
 *    provenance at all, and the store has already emitted for it.
 * 2. **The launch is flushed synchronously.** `runs.json` saves are debounced, so
 *    a crash in that window loses a record for work that has already been paid
 *    for. Reserve → construct → flush, then let the manager pump.
 */
import { loadWorkflows } from '../workflows/load.ts';
import { stepsIssue, type WorkflowDef, type WorkflowStepDef } from '../workflows/types.ts';
import type { RunStore, RunRecord } from './store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';

/** Launch provenance, discriminated by which source filled it in. Exactly one key
 *  is set. Kept as a wrapper object rather than a union so a future source is an
 *  added optional key rather than a change to every consumer's narrowing. */
export type RunProvenance = {
  automation?: RunRecord['automation'];
  loop?: RunRecord['loop'];
};

/**
 * The launch-relevant subset of a source's task template — the fields every
 * source has in common, with the source-specific parts (how the prompt was
 * produced, what triggered it) already resolved by the caller.
 *
 * Deliberately NOT the whole of any source's stored template: `task`, `images`
 * and `todoId` are excluded because a programmatic source has no pasted images
 * and no inbox row, and `prompt` is the rendered final text rather than a
 * template still holding placeholders.
 */
export interface LaunchTemplate {
  /** Final prompt text. Placeholder rendering, if the source has any, happened already. */
  prompt: string;
  /** Named workflow to run. Ignored when `steps` is set. Defaults to `quick-task`. */
  workflow?: string;
  /** Inline ad-hoc chain, mutually exclusive with `workflow` — the "(planned)" shape. */
  steps?: WorkflowStepDef[];
  model?: string;
  runner?: StartRunInput['runner'];
  agentProfile?: string;
  systemPrompt?: string;
  worktree?: boolean;
  autonomous?: boolean;
  generateFollowups?: boolean;
  /** Parallel variants. `1`/undefined starts a single run. */
  variants?: number;
}

/**
 * Resolve the workflow a template names, applying the `steps` XOR `workflow`
 * rule the YAML loader enforces elsewhere.
 *
 * Throws rather than defaulting on an unknown workflow name: a source that names
 * a workflow the repo no longer has is a configuration error its receipt should
 * record, not something to silently downgrade to `quick-task`.
 */
export async function resolveLaunchWorkflow(root: string, template: LaunchTemplate): Promise<WorkflowDef> {
  if (template.steps) {
    const issue = stepsIssue(template.steps);
    if (issue) throw new Error(issue);
    return { name: '(planned)', source: 'built-in', steps: template.steps };
  }
  const wanted = template.workflow ?? 'quick-task';
  const loaded = await loadWorkflows(root);
  const workflow = loaded.workflows.find((item) => item.name === wanted);
  if (!workflow) throw new Error(`unknown workflow: ${wanted}`);
  return workflow;
}

/** Map a neutral template plus its provenance onto the manager's input shape. */
export function buildStartRunInput(template: LaunchTemplate, provenance: RunProvenance): StartRunInput {
  return {
    task: template.prompt,
    model: template.model,
    runner: template.runner,
    agentProfile: template.agentProfile,
    systemPrompt: template.systemPrompt,
    worktree: template.worktree,
    autonomous: template.autonomous,
    generateFollowups: template.generateFollowups,
    provenance,
  };
}

/**
 * Start the run(s) for one template and return the id the source should await.
 *
 * The returned id is the FIRST run, matching `startVariants`' own "first variant
 * is the recorded one" convention — a source awaiting a variant group awaits the
 * first of them.
 */
export async function launchFromSource(options: {
  root: string;
  manager: RunManager;
  store: RunStore;
  template: LaunchTemplate;
  provenance: RunProvenance;
}): Promise<{ runId: string; runIds: string[] }> {
  const { manager, store, template, provenance } = options;
  const workflow = await resolveLaunchWorkflow(options.root, template);
  const input = buildStartRunInput(template, provenance);
  const variants = template.variants ?? 1;
  const runs = variants > 1 ? manager.startVariants(workflow, input, variants) : [manager.startRun(workflow, input)];
  const first = runs[0];
  if (!first) throw new Error('run manager did not create a run');
  // Durability before the source records the launch as done. The manager's pump is
  // asynchronous, so flushing here costs nothing in latency and closes the window
  // where a crash would lose a record for a run that is about to consume tokens.
  store.flush();
  return { runId: first.id, runIds: runs.map((run) => run.id) };
}
