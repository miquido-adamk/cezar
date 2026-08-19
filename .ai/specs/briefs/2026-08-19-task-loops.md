# Task loops — drain a list of independent work items as a sequence of separate cezar sessions

- Date: 2026-08-19
- Category: feature
- Priority signal: medium — the capability exists agent-side (`om-cezar-issue-loop`) and has never been run once; the product gap is durability and visibility, not absence
- Risk signal: high — adds a third scheduler-shaped module, contends with unmerged PR #846 for the same seams, and touches run lifecycle states whose non-terminal exits are easy to get wrong
- Routing: Next: om-auto-write-spec "Task loops — sequential multi-session batch runs driven by a persisted server-side loop object — brief: .ai/specs/briefs/2026-08-19-task-loops.md"

## Problem

Draining a queue of N independent work items costs N rounds of babysitting: start a task, watch it, review it, land it, start the next. The user wants to kick it off once and come back to N finished items, with each item in its own cezar session and worktree so failures and diffs stay isolated.

Evidence, and its limits — stated honestly because the spec's "Resolved assumptions" table should not overstate it:

- Upstream `open-mercato/cezar` has **80 open issues** and 28 open PRs, so a backlog to drain genuinely exists.
- Counter-evidence the spec must not ignore: issue #881 ("[Triage] Open-issue map") records that **24 of those 80 already carry an open PR**, and states outright that "batching work that already has an open PR just creates conflicts" and that "Sequence matters" for dependent pairs. The eligible queue is far smaller than 80.
- `om-cezar-issue-loop` already implements this ask agent-side and **has never been executed** — 82 run reports under `.ai/runs`, newest 2026-08-11, none a backlog drain. The five motivations for productizing it (persistence, visibility, cost, genericity) are therefore untested against a single real execution.
- The user was told all of the above, was offered "build nothing yet", and reaffirmed twice that they want this as a cezar feature. That is the decision this brief carries.

## Agreed direction

Build a **loop** as a first-class, persisted, project-scoped object whose counter is held by a **server-side coordinator**, not by an agent session.

Rejected, with reasons:

- **An agent session in the orchestrator seat** (the user's original "one main thread"). Rejected on `AGENTS.md` § "Enumerate the transitions out of every state you add": a parked orchestrator run has only three wake sources (user message, turn-end autonomous nudge, monitoring wake timer) — the #661 `monitoring`-with-no-exit trap — and its plan dies with the process. The advance signal a loop needs is child-run completion, which is observable on the runs store's emitter. `RunManager`'s constructor takes only `{ semaphore? }`, so there is no completion-callback seam; the store emitter is the seam.
- **Build nothing / just run the existing skill.** Lost because the user explicitly requires a product feature. It remains the cheapest falsifier and is recorded as such below.
- **Cloning the GitHub Automations module a third time.** Rejected on the strength of epic #771, which governs this area.

**The controlling constraint — read #771 before designing anything.** Epic #771 ("Implement postponed and recurring scheduled tasks") states: *"recurring tasks consume that foundation rather than introducing a second scheduler, store, route family, or launch path"* and *"retain one coordinator, one occurrence model, one ordinary run launch adapter."* PR #846 is landing that foundation right now (Phase 1, open, awaiting review). A loop is a **third consumer of that same foundation**, not a third copy of it. The spec must sequence after #846 and reuse its coordinator, its cross-process lease, its durable-occurrence model, its synchronous-flush-before-pump discipline, and its neutral launch adapter. Measured price of *not* reusing: GitHub Automations is 39 files, +2872/−22, 1231 LOC of src, 11 routes, a 291-LOC contract module with 20 schemas, a nav entry, and a `RunRecord` provenance field. A third such module also means a third provenance field and a third badge in `run-header.tsx`.

**v1 is one deployable slice.** The conversation initially bundled three capabilities; the spec ships only the first, with the other two named and sequenced so nothing is lost:

- **Slice 1 (v1, this spec):** the loop object + persisted definition/state + an **explicit list of items** as the only source + the terminal barrier + parent/child UI. Useful alone, dogfoodable on this fork immediately, no forge dependency.
- **Slice 2 (next spec):** open issues as a loop source, including the eligibility problem below.
- **Slice 3 (separate spec, contentious):** landing each item before the next starts. Deferred deliberately — #771 lists *"Automatically merging implementation work"* under **Out of scope**, so auto-merge is against current house doctrine and needs its own argument, not a knob smuggled into v1.

This re-cut overrides two answers the user gave earlier in the conversation ("issues + list" for v1 sources; a per-loop landing switch). It is a scope call, flagged explicitly so the user can reverse it: the answers were given against facts that turned out to be wrong (see Resolved unknowns), and a bundle routed as one brief produces an unsplittable spec.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|-------------------------------|
| Who holds the loop counter — an agent session or the server? | **Server-side coordinator over a persisted loop object.** Restart-safe, zero orchestration tokens, and the only design with a real wake source. Confirmed by the user. |
| Sequential or parallel? | **Strictly sequential, width 1 by default**, still bounded by `maxParallel`. Assumption taken, not challenged. |
| How is each item configured? | **Reuse the existing neutral task template**, not a second New-task form. `automationTaskSchema` (`automations/types.ts:28-44`) is already domain-neutral; only the runtime functions are GitHub-coupled (they take a `GithubCandidate`). Extract a neutral `(task, workflow, context) → StartRunInput` adapter — which is also what #771 step 2 asks for. |
| What is a loop *not* for? | **Independent items only. A dependent sequence is a workflow** (`workflows/run.ts` already does that better, with `onFail.retry`). The "explicit list" source is ambiguous between the two and the spec must say so out loud, or users will reach for the wrong mechanism. |
| Failure policy | **Skip the item, record it, continue**, with opt-in stop-on-first-failure — matching `om-cezar-issue-loop` and cezar's degrade-don't-fail doctrine. **But see the `failed` trap below: naive stop-on-first-failure fires spuriously on every server restart.** |
| Does an item park at a review gate between iterations? | **No — and the premise that it would was false.** `reviewGateEnabled` (`runs/review-gate.ts:16-22`, spec `2026-07-18-optional-review-gate`, #489) is **off** unless `config.reviewGate` is set or `CEZ_REVIEW_GATE === '1'` exactly; and `settleSuccess` (`workflows/run.ts:3294-3318`) parks at `review` only when `worktreeHasDiff && reviewGateEnabled(config) && run.autonomous !== true`. Autonomous children settle straight to `done`. So on a zero-config install a 10-item loop today yields 10 `done` runs, 10 retained worktrees, **zero PRs, nothing landed** — which is not "come back to N landed changes". The spec must diff this default path explicitly (`AGENTS.md` § "A replacement that ships OFF is not a replacement") and decide what "finished" means for an item when nothing lands. |
| Which run states actually break a terminal barrier? | **Not `waiting`** — the earlier grounding was wrong. `armIdleTimer` calls `session.end()` (`run.ts:3378-3390`), the session result resolves and `settleSuccess` runs, so `waiting` is bounded at `IDLE_TIMEOUT_MS` = 15 min. The three real traps, all of which the spec must enumerate: (1) **`monitoring`** — a sub-state of `running` that deliberately *clears* the idle timer and is bounded only by `MAX_AUTO_CONTINUES = 40` wakes (`run.ts:196`), so hours of non-terminal; (2) **`failed` + `autoResumeAt`** — a run with an appointment to resume itself (`runs/store.ts:200`; `store.ts:861` says a failed run with pending `autoResumeAt` "is not a done item AT ALL"), so a loop treating `failed` as terminal advances *while the previous child restarts*, putting two children live in a width-1 loop; (3) **restart transits a `running` child through `failed`** before its continuation lands (`run.ts:1094-1112`). |
| Blocked-child policy | Per-loop switch defaulting to autonomous-and-advance was the user's answer, **but it was chosen against the wrong state machine** (see above). Re-derive it from the three real traps. Note also open issue #689 ("classify inactivity closures before finalizing runs") is a prerequisite for trustworthy blocked-child detection. |
| Can the parent/child row reuse `groupId`? | **No — reusing it destroys work.** The existing parent-with-children UI keys on `groupId` (`web/src/lib/task-groups.ts:227-259`), and `POST /groups/:groupId/pick` (`server/server.ts:4287-4337`) cancels, `removeWorktree`s and archives every non-winner: one Compare→pick click on a loop group would delete every other child's worktree. `VARIANT_LETTERS` also caps at 3 (`run.ts:446`). A new relation field is required, and `/groups/:id/pick` must be unreachable for loop groups. |
| Is the terminal barrier already available? | Partly. `packages/cezar/src/index.ts:436-438` already awaits `['done','review','failed','cancelled']` over `store.on('run')`. But the store emits `run` on **every** mutation (`runs/store.ts:1174`) — there is no terminal event, so the barrier is a firehose you diff synchronously inside `updateRun`. Saves are debounced 300 ms (`store.ts:1196-1203`), so the advance decision must flush synchronously. **PR #846 already solved exactly this** ("a synchronous flush before any run can be pumped so a crash can never lose or duplicate paid agent work") — cite it, do not rediscover it. |
| What does sequencing actually cost today? | Less than assumed. Per-project `maxParallel` is already a setting (`workspace/semaphore.ts:276-286`) and the queue is FIFO (`run.ts:900-910`), so N tasks at `maxParallel: 1` gets sequential *starts* for free. It does **not** serialize, because a child parked at `waiting` releases its slot (`run.ts:810-814`, the #347 exemption). What is genuinely missing is exactly three things: **fan-out from a source** (the Issues list has no multi-select; `hand-to-agent.tsx` is one issue at a time), **the terminal barrier**, and **landing**. The spec should be built around those three, not around "a Loop object" in the abstract. |
| Where is the gating decision? | Must be made in the spec. GitHub Automations shipped and then had to be hidden behind `CEZ_AUTOMATIONS=1`, off by default (#801), because per-automation `enabled` "turned out not to be gating enough". Decide the loop's gating deliberately, with `AGENTS.md` § "a replacement that ships OFF is not a replacement" in view. |
| Which repo's issues, for slice 2? | **Must be explicit.** This checkout's `origin` is the fork `miquido-adamk/cezar`, where issues are **disabled** (`gh issue list` errors); the 80 open issues live upstream in `open-mercato/cezar`. cezar's forge layer resolves the project's own remote, so a naive "open issues" source is untestable exactly where it will be dogfooded. Either the source takes an explicit repo, or slice 2's marquee source does not work on the fork. |

## Non-goals

- **Auto-merging item work** — explicitly out of scope per #771; deferred to slice 3 with its own argument.
- **Open issues as a source** — slice 2, not v1.
- **Dependent step sequences** — that is what workflows are for.
- **Parallel loops / width > 1** in v1.
- A **second scheduler, store, route family, or launch path** — forbidden by #771.
- Running while cezar is stopped; raw cron; OS scheduler integration.
- Reusing `groupId` or the variant compare/pick surface for loop parentage.
- Agent-side judgement in the coordinator: queue eligibility that needs a body read (umbrella issues, decision issues, issues already carrying a PR) is **not** something a server-side filter can do. If slice 2 needs it, delegate queue-building to one agent child rather than pretending metadata is enough.

## Affected areas (if known)

- `packages/cezar/src/workflows/run.ts` — `settleSuccess` (3294-3318), `armIdleTimer` (3378-3390), `MAX_AUTO_CONTINUES` (196), restart reconciliation (1094-1112), FIFO queue (900-910), slot exemptions (810-814)
- `packages/cezar/src/runs/store.ts` — emitter (1174), debounced save (1196-1203), `autoResumeAt` (200, 861), new optional provenance field
- `packages/cezar/src/runs/review-gate.ts` — the default-off gate that invalidates "park at review"
- `packages/cezar/src/automations/` — `types.ts:28-44` (neutral task schema), `task-template.ts:21,44` (the GitHub coupling to factor out), and `coordinator.ts`/`scheduler.ts`/`store.ts` as the shape to reuse rather than clone
- `packages/contract/src/` — new zod-first shapes; `runs.ts:234-237` (`groupId`/`variant`, the field NOT to reuse)
- `packages/cezar/src/server/server.ts` — one chained project-scoped route family under `/api/v1`; `/groups/:groupId/pick` (4287-4337) must exclude loop groups
- `packages/web/src/lib/task-groups.ts` (227-259), `components/task-quick-list.tsx` (221-271), `run-header.tsx` — parent/child rendering
- `packages/cezar/src/server/forge/github.ts:2489-2531` — merge preconditions for slice 3: 40-hex `expectedHeadSha`, and `stale-head` is a retry-with-fresh-sha, not a failure
- **Cross-PR dependency:** PR #846 / epic #771 — sequencing, coordinator reuse, lease and flush patterns, `RunRecord` provenance surface, and the same sidebar nav slot
- Prerequisite issue: #689 (classify inactivity closures before finalizing runs)
