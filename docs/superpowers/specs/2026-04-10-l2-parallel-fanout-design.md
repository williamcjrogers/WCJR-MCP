# L2 — Parallel Phase Fanout (Design Spec)

**Date:** 2026-04-10
**Status:** Approved (William, 2026-04-10, fast-mode brainstorm — same-day continuation of L0 + L1)
**Context:** Third layer of the "operator console" roadmap. L0 shipped the iterative planner with critic + lesson-writer. L1 shipped the per-run workspace + artifact graph. L2 makes the planner respect the execution plan's declared parallelism — stop running independent phases one at a time.

## Strategic framing

Today, even when the execution plan declares `parallelGroup` and `dependsOn` (fields that have existed and been validated since before L0), the iterative planner ignores them and runs phases sequentially. This is the single biggest "this is a chatbot with tools" gap left in the system. A three-phase research fanout followed by a synthesis phase takes 4× longer than it should. The DAG batcher (`buildExecutionBatches`) has existed in the codebase for months but is never invoked in iterative mode.

L2 closes that gap. It's not about adding capability — it's about unlocking capability that was already declared and validated but silently unused. The infrastructure is all there:

- `buildExecutionBatches` already DAG-orders phases, detects cycles, and groups by `parallelGroup`
- `runCritic` is pure and safe for concurrent invocation
- `runToolLoop` and `mcpHub.callTool` are concurrency-safe (JSON-RPC multiplexes naturally)
- `phaseEntry` already tracks everything needed per phase; just needs new `batchIndex` / `batchSize` fields
- The iterative branch already has a retry/amend/escalate state machine from L0 — just needs to operate on batches instead of phase indices

L2 is a **rewrite of the main loop** of `runIterativePlan`, not new code paths. The "sequential iterative mode" becomes a degenerate case of "parallel iterative mode" where every batch has exactly one phase.

---

## 1. Goal

After this ships, the orchestrator must:

1. Respect `parallelGroup` and `dependsOn` fields on execution plan phases by invoking `buildExecutionBatches` and running batches in order.
2. Execute every phase within a batch in parallel via `Promise.all`, preserving L0's per-phase retry/amend/escalate state machine.
3. Run per-phase critics in parallel after each batch settles.
4. Reconcile mixed verdicts deterministically (errors → retries → amendments → all-accepted).
5. Cancel in-flight siblings when any phase in a batch errors or escalates, via `AbortController`.
6. Populate `batchIndex` and `batchSize` on every `phaseEntry` and expose `ledger.batches` as a structured view.
7. Reject plans with circular dependencies at the very start with a clean `failed` outcome.
8. Preserve backward compatibility for flat plans (no `parallelGroup`/`dependsOn`) and the artifact-graph, lesson-writer, critic, and task-store integrations from L0/L1.

## 2. Architecture

One module rewrite, no new modules:

**Modified:**
- **`packages/orchestrator/src/planner.js`** — the main `while (phaseIndex < phases.length)` loop is replaced with an outer batch loop. `buildExecutionBatches` is called at the start and after every amendment. Per-phase execution logic is factored into a new `runPhase()` helper inside the module. Per-batch cancellation via `AbortController`.

Everything else — the critic module, the lesson-writer, the artifact extractor, the orchestrator wiring, the task-store, the desktop UI — stays untouched. L2 is a focused surgical change inside one file.

## 3. State machine (new outer loop)

```
START
  │
  ├─► phases = [...plan.phases]
  ├─► try { batches = buildExecutionBatches(phases) }
  │   catch (cycle/invalid) → ledger.outcome = "failed"
  │                           ledger.error = "Invalid plan: <reason>"
  │                           merge artifacts, return { outcome: "failed", ... }
  │
  ▼
OUTER LOOP: for (let batchIndex = 0; batchIndex < batches.length; batchIndex++)
  │
  ├─► Budget check (maxTotalPhases, maxWallClockMs)
  │   If exhausted → ledger.outcome = "budget_exhausted", merge, return
  │
  ├─► const batch = batches[batchIndex]
  │   const controller = new AbortController()
  │
  ├─► INNER: Promise.all(batch.map((phase) => runPhase(phase, { batchIndex, batchSize: batch.length, signal: controller.signal })))
  │   Each runPhase:
  │     - Executes the phase via invokeModel (respecting signal)
  │     - Runs extractor, attaches phaseEntry.artifacts
  │     - Runs runCritic with artifacts
  │     - Handles retry_phase by looping (still respecting signal)
  │     - Returns { phaseEntry, verdict, error? }
  │     - NEVER throws — all errors become { error } in the return shape
  │
  ├─► const results = await Promise.all(...)
  │
  ├─► RECONCILE (see §4)
  │     Any error?        → controller.abort(), terminate run as "failed"
  │     Any escalate?     → controller.abort(), terminate run as "escalated"
  │     Any retry_phase?  → retry those phases only, same rules
  │     Any amend_plan?   → apply amendments, re-batch remaining work, restart outer loop
  │     All accepted?     → continue outer loop to batches[batchIndex + 1]
  │
  ▼
TERMINAL: merge run-level artifacts, set ledger.outcome if not set, return
```

### Key invariants

- **`runPhase` is the non-throwing unit.** Every error inside it is caught and converted to a `{ phaseEntry, error }` result. `Promise.all` never rejects. The outer loop's error handling is purely result-inspection.
- **Batches execute sequentially, phases within a batch execute in parallel.** By definition of the DAG, batch N+1 depends on at least one phase in batch N, so there's no parallelization across batches.
- **Cancellation propagates via `AbortSignal`.** The signal goes into `invokeModel`, which propagates it to the provider SDK (already supported in L0). Cancelled phases land with `status: "cancelled"`.
- **Amendments re-batch only the REMAINING phases.** Completed batches stay committed. The next-to-run section of the DAG is recomputed.
- **Flat plans are a degenerate case.** A plan with no `parallelGroup`/`dependsOn` produces batches of size 1 each and reproduces L0 behavior exactly.

## 4. Reconciliation rules (decided)

After `Promise.all(batch)` settles, walk the results and apply rules in strict precedence order:

1. **Any result has `error`** → The run cannot continue. Abort the batch's controller (siblings may still be finishing), set `ledger.outcome = "failed"`, set `ledger.error = result.error`, merge artifacts from all completed phases, return.

2. **Any result has `verdict.decision === "escalate"`** → Same as #1 but `ledger.outcome = "escalated"`, `pendingApproval: true`, `ledger.escalationReason = verdict.escalationReason`.

3. **Any result has `verdict.decision === "retry_phase"`** → Retry those phases only, in parallel, with a fresh `AbortController` per retry batch. Each phase still enforces `maxCriticRoundsPerPhase` (tracked in `phaseEntry.attempts`). If any retried phase hits `attempts === maxCriticRoundsPerPhase` and the critic still says `retry_phase`, force escalate (same rule as L0). Other phases in the current batch that already accepted are FROZEN — they don't re-run. After the retry batch settles, re-reconcile from step 1.

4. **Any result has `verdict.decision === "amend_plan"`** → Collect amendments from ALL such phases in batch order. Apply them sequentially to the `phases` array via the existing `applyAmendments` helper (from L0). Then re-run `buildExecutionBatches(phases)` to produce a new forward schedule. Completed batches stay committed. Jump to the new `batches[batchIndex + 1]` and continue the outer loop. The `ledger.phases` entries from the current batch are already committed — amendments affect only the forward schedule.

5. **All results are `verdict.decision === "accept"`** → Advance to `batches[batchIndex + 1]`.

**Edge case — retry triggered AND amendments in same batch.** Retry has priority. Retry the phases that need retrying. If retry succeeds with accept, then check if any phase (including the retried ones' post-retry verdicts or the originally-accepted ones' verdicts) has amendments. Apply them. Continue.

**Edge case — retry triggers amendment on retry.** A phase retried and its second-attempt critic returned `amend_plan`. This is handled by the retry loop returning `{ verdict: amend_plan }`, which falls through to step 4 on the re-reconciliation.

**Edge case — all phases in a batch escalate.** Terminate as `escalated` with the escalation reason from the first one encountered in batch order.

**Edge case — empty batch.** `buildExecutionBatches` only produces non-empty batches. If `phases` is empty at start, we return immediately with `outcome: "success"` (empty plan is a no-op, not an error).

## 5. Cancellation details

Each batch creates a `new AbortController()`. The `signal` is passed into `runPhase`, which passes it into `invokeModel`, which propagates it to the provider SDK. L0's provider layer already handles `AbortSignal` correctly via `classifyProviderError` → `ProviderTimeoutError` or `AbortError`.

When reconciliation decides the run is terminating (error or escalate), it calls `controller.abort()` before the terminal return. This signals any sibling phases still in flight. Those phases' `invokeModel` calls reject, get caught inside `runPhase`, and land with `status: "cancelled"` and `error: "cancelled by sibling failure in batch <N>"`.

**Critical:** The critic is NOT run on cancelled phases. `runPhase` checks `signal.aborted` before entering the critic call and short-circuits with `status: "cancelled"` directly.

**Cancelled phase artifact extraction:** The artifact extractor DOES run on cancelled phases (they may have produced partial files before being cancelled) but the critic does not. This is consistent with L0 semantics — artifacts are ground truth, verdicts are judgments.

## 6. runLedger additions

Backward compatible — existing fields unchanged, new fields added.

**`phaseEntry` gains:**
```js
{
  // ... existing L0/L1 fields ...
  batchIndex: 0,      // NEW: 0-based index of the batch this phase was in
  batchSize: 3,       // NEW: total phases in that batch
  status: "accepted" | "retried" | "escalated" | "error" | "cancelled",  // "cancelled" is NEW
  // ... existing ...
}
```

**`ledger` gains:**
```js
{
  // ... existing L0/L1 fields ...
  batches: [
    { index: 0, phaseIds: ["p1"],          startedAt: 1743..., endedAt: 1743... },
    { index: 1, phaseIds: ["p2", "p3"],     startedAt: 1743..., endedAt: 1743... },
    { index: 2, phaseIds: ["p4"],          startedAt: 1743..., endedAt: 1743... }
  ]
}
```

`ledger.phases[]` stays flat. Consumers that `flatMap` over it (artifact merger, lesson-writer's tools-used gatherer, desktop renderer) keep working unchanged. The new `ledger.batches` is a structured view that L5's operator dashboard can use to render batch-grouped task timelines.

## 7. Critic concurrency

No changes to `critic.js` required. `runCritic` is already pure per the L1 final review verification: no module-level mutable state, degraded-accept fallback is per-call, `VERDICT_SCHEMA_DECISIONS` is a frozen Set. Safe to call with `Promise.all` across a whole batch.

## 8. Tool-loop concurrency

No changes to `tool-loop` or `mcp-hub` required per the L1 and L2 exploration reports. `runToolLoop` is stateless across calls. `mcpHub.callTool` delegates to the MCP SDK, which multiplexes JSON-RPC on a single transport. Parallel `callTool` invocations on the same server are safe.

## 9. Plan start: cycle detection and empty plan

Before entering the outer loop, the planner calls `buildExecutionBatches(phases)` inside a try/catch. The existing `buildExecutionBatches` throws on:
- Circular dependency (no runnable phases in an iteration with phases still remaining)
- Unknown `dependsOn` reference (a phase depends on an ID that doesn't exist)

On throw, the planner terminates the run as `failed` with `ledger.error = "Invalid plan: <reason>"`. The run ledger still has its standard shape, `artifacts` is empty, `ledger.outcome = "failed"`, `pendingApproval: false`.

Empty plan (`phases.length === 0`) returns immediately with `outcome: "success"`, `content: ""`, `ledger.phases = []`.

## 10. Out of scope (deferred)

| Deferred | Why | Layer |
|---|---|---|
| Parallel specialists within a single phase | Second meaning of "specialist" — direct-mode sequential specialist chain stays as-is. | L2.x |
| Adaptive parallelism cap (e.g. max 3 concurrent regardless of plan) | L2 trusts the plan's declared fanout. Governance is L4. | L4 |
| Cross-batch critic reconciliation (batch-level synthesizer) | Per-phase critics are sufficient for L2. Can add later if retry storms become a problem. | L2.x or L6 |
| Streaming batch progress to the renderer | L2 emits per-phase status chunks same as L0. Per-batch UI is an L5 dashboard concern. | L5 |
| Per-phase token budgets | Budget is still run-level. Per-phase accounting needs provider-side token reporting changes. | Future |

## 11. Critical files

**Modified:**
- `packages/orchestrator/src/planner.js` — rewrite the main loop. Introduce `runPhase` helper, outer batch loop, reconciliation logic, `AbortController` integration, `batchIndex`/`batchSize` on phaseEntries, `ledger.batches` structure.
- `packages/orchestrator/src/planner.test.js` — add 9 new tests covering the full L2 matrix.

**Not touched:**
- `packages/orchestrator/src/critic.js`
- `packages/orchestrator/src/lesson-writer.js`
- `packages/orchestrator/src/artifact-extractor.js`
- `packages/orchestrator/src/index.js` (`executeTask` / `collectToolContext`)
- `packages/orchestrator/src/workflow.js` (`buildExecutionBatches`)
- `packages/task-store/src/index.js`
- Desktop files (the existing Run Ledger panel JSON tree will render the new fields automatically)

## 12. Reused utilities

- `buildExecutionBatches` at `packages/orchestrator/src/workflow.js` — imported, called at start and after amendments
- `runCritic` at `packages/orchestrator/src/critic.js` — called in parallel via `Promise.all`
- `extractArtifactsFromPhase` + `mergeArtifactHistory` at `packages/orchestrator/src/artifact-extractor.js` — unchanged
- `applyAmendments` (existing helper inside `planner.js`) — unchanged, called on amendment reconciliation
- L0's phase-level state machine (retry / accept / escalate / amend) — preserved inside `runPhase`

## 13. Verification

### Unit tests (9 new planner tests)

1. **Flat plan regression** — plan with no `parallelGroup`/`dependsOn` produces batches of size 1, executes sequentially, matches L0 behavior exactly.
2. **Parallel phases execute concurrently** — mock invokeModel records start timestamps; sibling phases start within 10ms of each other.
3. **Batch reconciliation: all accept** — 2 parallel phases, both accept, run advances to next batch.
4. **Retry in one phase doesn't block sibling accept** — p2 retries once, p3 accepts on first try; both end successful, ledger shows p2 attempts=2, p3 attempts=1.
5. **Error in one phase cancels siblings** — p2 throws mid-execution; p3 still running gets aborted; outcome is `failed`, p3 status is `cancelled`.
6. **Escalate in one phase cancels siblings and terminates** — p2 critic returns escalate; p3 is cancelled; outcome is `escalated`, `pendingApproval: true`.
7. **Amendment in a batch triggers re-batch** — p1 and p2 in parallel; p1's critic returns `amend_plan` with `insert_phase` for p1b depending on p1; next iteration runs p1b before the original p3.
8. **batchIndex + batchSize populated correctly** — for a known DAG `[p1 → (p2,p3) → p4]`, assert phase entries have the right indices.
9. **Cycle detection terminates immediately** — plan with `p1 depends on p2, p2 depends on p1` → run terminates with `outcome: "failed"`, `error: "Invalid plan: ..."`.

All 9 must pass. All 9 existing L0 planner tests must still pass unchanged. Full workspace suite from 106 → ~115 tests.

### End-to-end on the live app

10. Create an iterative task with a plan declaring 3 parallel research phases + 1 synthesis phase depending on all 3. Watch the Run Ledger panel populate. Confirm:
    - All 3 research phases have `batchIndex: 0` and the same `batchSize: 3`
    - The synthesis phase has `batchIndex: 1`, `batchSize: 1`
    - `ledger.batches.length === 2`
    - Wall-clock time is noticeably less than 4× the single-phase time
11. Break one of the parallel phases (intentionally bad prompt). Confirm the others are cancelled with `status: "cancelled"` and the run terminates as `failed`.
12. `node --test $(find packages -name '*.test.js' -type f)` — full suite green.

Only after all 12 checks pass is L2 considered shipped.
