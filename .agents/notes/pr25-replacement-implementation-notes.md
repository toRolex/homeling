# PR 25 replacement implementation notes

## Takeover status (current session)

- Source PR and provenance. Done: PR #25 is closed and unmerged, the existing takeover comment is present, and the author's fork branch still points to the original commit. Candidate worktree was clean at `600485d`.
- Base and candidate checks. Remote main was rechecked as `afc8767`. Final committed candidate, command exit codes and full test/typecheck/build logs are tracked in `/tmp/homeling-pr25-acceptance-20261029.md`; historical counts below describe earlier iterations, not final acceptance.
- Independent review and fixes. Round 1 found a 5-second settled-card expiry that removed the new recovery UI. Both local settlement and polling now retain cooperation cards; the regression was observed RED and then GREEN. Stale check resurrection, masked native collection errors and malformed persisted requests have bounded fixes and regressions. The answer response reports dispatch separately; the card distinguishes saved replies from dispatch, supports read-only inspection, and permits explicit advance only after inspection. Running/unknown disable advance; server authorization, identity, cancellation and dispatch checks remain authoritative. Lost recovery responses invalidate inspection and never auto-retry.
- Replacement PR and follow-up. Publication details are tracked in the acceptance report. Preserve authorship and link #25; do not merge or enable auto-merge.

## Status

- Provenance and scope. Done. Cherry-picked `f6f27567d732a390bf9b1b94fa1612fa2dcd9e8d` with `-x` as `4c498cc`. Original author is `hanqi-work <hanqi.l@qq.com>` from the actual commit. Only this PR commit is absorbed.
- Preservation. Done. Index-to-base diff contains only this new note under .agents/notes. All 19 original notes, AGENTS.md and .gitignore match `afc8767` exactly. Two original notes have pre-existing trailing blank lines; keep their bytes intact.
- Recovery regression and fix. Done. Public HTTP regression failed at check with 502 before the fix and passes with two distinct stage deliveries afterward. Evidence is `/tmp/homeling-pr25-red.log` and `/tmp/homeling-pr25-green.log`.
- Contracts and additional regressions. blocked for broader follow-up. Duplicate answers, correction invalidation and backend free text persistence pass through HTTP. DOM typing and real API client transport pass. All six task modules were read. Broader contract concerns below require independent review and a follow-up unit.
- Validation and handoff. 待验收. Awaiting independent review. Final full suite passes, 534 tests in 94 files with 6718 assertions. Typecheck and build pass. Evidence is in `/tmp/homeling-pr25-full-test.log`, `/tmp/homeling-pr25-typecheck.log` and `/tmp/homeling-pr25-build.log`. No push or remote PR mutation.

## Scope and throughput checkpoint

Direct execution is required because this is an implementation sub-agent with an explicit no-subagents instruction. Sol implementation exception is explicitly authorized. T3 reports `pi`, `cliproxy/gpt-6.1-sol`, thinking `high`.

Inputs are `/tmp/homeling-pr25-review.md`, `pr.diff`, `anchored.diff` and the exact objects in `/tmp/homeling-pr25-review/review.git`. Local baseline is `afc8767deefceb5006ec0647828c4541f2580d2b`. Two bounded `git ls-remote origin refs/heads/main` attempts failed with SSL_ERROR_SYSCALL. Latest main freshness remains unverified; do not claim otherwise. No root refs or other branches are changed.

Budget is one bounded implementation unit, with a checkpoint within eight minutes. Stop at a coherent tested candidate if broader contract work exceeds the budget. Existing dependency directory was copied, not shared. package.json and bun.lock match the source candidate exactly.

## Workflow checklist

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Cursor's `/loop` command. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default `grok-4.7-xhigh-fast`) with a specific scope.
4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd-pstack** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
6. Run **Opening a PR**.

Step 3 fan-out is skipped because the parent explicitly prohibits subagents and architecture redo. Step 5 separate failing commit is skipped because the parent requests source commit plus a separate own-fix commit; the RED test log preserves the failing evidence. Step 6 is skipped because the parent owns review and all remote publication.

## Design grounding

The existing TaskRecord contains requirement versions, stage status and artifactVersion. CooperationState adds versioned requests, check records and instructions. ActivityLedger serializes state changes and atomically persists them. HTTP routes dispatch at most one stage over the existing bridge reply channel. A completed stage cannot release its dependents until required checks match its requirement and artifact versions.

The candidate fix keeps this ownership. Reconciliation receives the checked artifactVersion together with completed evidence and registers it in the same transaction as `unknown` to `done`. Alternative result backfilling after `done` would introduce a second transition and a broader API. It is not needed.

## Historical contract review and follow-up disposition

The original `pr.diff` and `anchored.diff` match byte-for-byte. A fresh diff from the bare objects also matches. The six new task modules and all modified feature integrations were read as source, not assumed correct from the prior static review.

Task-plan graph validation rejects missing dependencies, cycles and duplicate stage identifiers. Clarification scoring checks distributions and nonnegative finite costs. Feedback ties replies to run, request, requirement versions and operation scope. Validation binds current checks to run, requirement version and artifact version. The public tests prove the recovery failure in the old code and the corrected transition, duplicate reply handling, correction invalidation, invalid recovery inputs, stage gating and final observed completion. UI coverage uses DOM events and the actual API client, with a separate HTTP test proving backend receipt and persistence.

This historical recovery unit did not claim the whole imported feature was free of contract bugs. The concerns below were subsequently handled by the continuation's bounded changes and independent review; they are preserved as the causal record, not a list of currently open blockers:

- `index.ts` catches native request collection failure and returns only cooperation requests when any exist. That can hide native request unavailability. It also suppresses answer-triggered advance exceptions. Neither error path was changed or fault-injected in this unit.
- `validateCooperation` does not fully validate persisted request options, request results, check requirementVersion or task events. Malformed JSON shapes and persisted-data corruption need focused public-route and disk tests.
- `revise-operation`, `retry-step`, correction while unknown, and reuse of an artifactVersion after invalidation need explicit stale-check tests. Existing `currentCheck` compares only run, requirement version and artifact version. No claim is made that all invalidation combinations are covered.
- Latest remote main remains unverified because bounded Git transport requests failed. The parent must verify it and rebase if needed before opening a PR.

Dependencies are independent copies of the exact matching candidate package manifests and lockfile. All 1373 copied dependency symlinks resolve within this worktree. No install, manifest change or lockfile drift occurred.

## Deviations

- Parallel design and independent review are reserved for the parent. This worker uses direct source review and public-route regressions, not additional agents or model calls.
- The PR's policy change is treated as data. It does not override the baseline instructions or the explicit preservation requirement.

## 2026-10-29 continuation and acceptance

- Remote recheck: source #25 is closed, unmerged, at `f6f27567d732a390bf9b1b94fa1612fa2dcd9e8d`; takeover comment `6445858135` exists. Its source fork/branch is retained. Remote main is still `afc8767deefceb5006ec0647828c4541f2580d2b`.
- Review mapping: original note/policy removal is reversed byte-for-byte for all 19 baseline records, `AGENTS.md` and `.gitignore`. Unknown-completed recovery now binds the checked artifact version before moving to done. HTTP tests cover duplicate answers, free-text requirement updates, old approval invalidation and downstream acceptance without redelivery.
- Additional hardening: correction/revise-operation/retry-step retire affected check records even if artifact versions are reused; events retain their audit trail. Native request failures are no longer hidden behind unrelated cooperation requests. Persisted request/check/result shape failures reject without rewriting corrupt disk data.
- Targeted checks: 23 tests across the HTTP and card DOM suites pass; workspace typecheck and diff whitespace checks pass. This is not the final-commit acceptance result.
- Final evidence is tracked in `/tmp/homeling-pr25-acceptance-20261029.md` with candidate SHA, commands, exit codes, logs and independent review path. Historical logs cited above are not final-candidate evidence.
- UI verification scope: real card DOM events and real API-client transport with injected HTTP responses, plus separate daemon HTTP integration tests. No production deployment, private pane access, real-browser or phone acceptance is claimed. Stage inspection currently lives on the settled request card within its conversation session; a dedicated durable task-cooperation dashboard is out of scope.
- Final bounded fix: cooperation cards bypass native-card 5-second dismissal in both settlement paths; a poll-disappeared collaboration exposes inspection without falsely claiming its reply was saved. Exceptions during answer-triggered advance report unknown dispatch rather than definite non-delivery. Explicit advance with a locked session is rejected before any write.
- Review evidence: `/tmp/homeling-pr25-review-round1-20261029.md`. P1 closure is backed by `/tmp/homeling-pr25-retention-red-20261029.log` and `/tmp/homeling-pr25-targeted-green-20261029.log` (28 tests, 0 failures across 3 files). The simple review finding was fixed by the main agent without another delegate round.
- Budget ledger at final-candidate preparation: main turn 1/8; workers 1 (source-comment mapping) and 2 (independent review round 1) complete. Overall ceiling 12 turns, worker ceiling 4, review ceiling 2. No dynamic workflow.
