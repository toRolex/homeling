# Daemon crash containment implementation notes

## Status

- Missing-socket client reproduction done. `/tmp/homeling-502-client-fixture.log` records two caught `herdr.unavailable` results and survival, exit 0 on Bun 1.3.12.
- Synthetic request/background reproduction done. `apps/daemon/src/missing-dependency-process.test.ts` covers one and eight concurrent clients, concurrent session establishment, persona/list, catch-up reads, temporary synthetic persona persistence, recovery, and activity/event observers. Child exit is 0. Persona/list still returns controlled 502, not the desired 503.
- Fatal-exit repair blocked. Neither reproduction has reproduced the deployed exit 1. No proven fatal boundary exists yet.
- Validation partial. `/tmp/homeling-crash-process-tests.log` records two passing process tests. `/tmp/homeling-crash-daemon-tests.log` records 305 daemon/contracts tests passing. Full tests, typecheck, and build are blocked by incomplete dependency installation. No deployable fatal-fix candidate exists.

## Scope and decisions

Direct execution as the explicitly assigned implementation worker. No subagents. Clean worktree fast-forwarded from afc8767 to fd02c9aa4df66ade244d4be8650d5a22fc060cbc before fixture execution. T3 thread configuration independently confirms `cliproxy/gpt-6.1-sol` with thinking `high`.

Data shape is a synthetic PersonaRuntime with temporary registry/activity paths, HerdrSocketClient pointed at a nonexistent temporary socket, and an in-memory bridge fetcher. No production registries, network endpoints, services, sockets, or private content are inspected.

Fix Root Causes prevents adding a whole-handler catch without reproducing an escaping failure. Model the Domain keeps fixtures in the existing PersonaRuntime shape rather than inventing a second runtime abstraction.

Throughput checkpoint. Client and concurrent request/background fixtures survive. Fatal mechanism is unproven. Stop at the bounded checkpoint rather than silently treating availability as containment.

## Deviations

The requested fatal fix cannot yet be selected from evidence. Do not present missing-dependency availability handling as a fatal-process repair.

## Playbook tracking

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
   Synthetic-only scope is mandated. Browser and production runs belong to the parent.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Cursor's `/loop` command. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
   No subagents per task authorization. Missing-socket client and concurrent request/background hypotheses do not reproduce exit 1.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default `grok-4.7-xhigh-fast`) with a specific scope.
   Fatal repair blocked on reproduction. No delegation authorized.
4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
   Production/browser acceptance remains unperformed. `bun install --frozen-lockfile` timed out at 60 seconds, and a copyfile retry timed out at 20 seconds. Full `bun test` timed out after a missing happy-dom error. Typecheck and build exit 1 because Bun/vite type dependencies are missing. Existing daemon/contracts runtime tests pass despite these missing development dependencies.
5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd-pstack** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
   No fatal failing test exists yet.
6. Run **Opening a PR**.
   Skip. Parent review only; no gh or deployment authorized.
