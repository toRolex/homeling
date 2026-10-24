# Public origin repair implementation

## Status

- Canonical origin and route regressions. Done for local fixture acceptance. config.ts, index.ts, config.test.ts, session-routes.test.ts. Red log /tmp/homeling-origin-red.log has 10 pass and 3 fail. Final targeted log /tmp/homeling-repair-targeted.log has 25 pass and 0 fail across four files.
- Protected 443 canary and shell fixtures. Done for isolated script acceptance. canary.ts/test and scripts/canary.sh with scripts/deployment-docs.test.ts validate dual listeners, missing/switched keys, changed proxy, corrupt JSON and binary/status failures.
- Narrow installer persistence and deployment technical draft. Awaiting parent acceptance. Installer fixtures pass in the targeted run. README.md and docs/deployment.md are technical drafts. Prose routing blocked by no-subdelegation instruction. Parent must route final prose review.
- Full repository validation. Blocked by incomplete dependency installation. /tmp/homeling-repair-full.log reports 531 pass, 1 fail, 1 error from missing TypeScript module. Typecheck and build fail on missing dependency/type declarations. Logs /tmp/homeling-repair-typecheck.log and /tmp/homeling-repair-build.log. No lock changes.
- Runtime deployment and browser acceptance. Out of scope. Parent owns all real Serve, plist, browser and device work.

## Entry and budget

Authorized implementation worker, direct execution, no subdelegation. Worktree t3/repair-public-origin-ui starts clean at afc8767. Environment confirms cliproxy/gpt-6.1-sol with high reasoning. Limit 20 minutes and 20% context. Throughput checkpoint follows first failing regression run. Save a verified narrow unit if remaining scope does not fit.

## Playbook

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Skip browser reproduction here because parent explicitly owns browser and deployment. Use supplied runtime diagnosis and reproduce configuration/route defect locally.
2. Binary-search the cause. Completed upstream in /tmp/homeling-wrong-ui-diagnosis.md. Contract is /tmp/homeling-ui-crossjudge.md.
3. Plan the fix. Completed upstream crossjudge. One normalized publicOrigin string, no derived stored triple. No worker subdelegation permitted.
4. Verify on the same surface. Route and script fixtures only here. Browser acceptance remains unverified.
5. Stage the commits so the failing repro lands before the fix in git history. Add cheap regressions first.
6. Run Opening a PR. Skip because PR/push are forbidden in this unit.

## Decisions

- Preserve empty origin for local-only startup. Explicit origin requires matching configured Tailscale hostname.
- Keep session admission, epochs, cookies, read access and static/PWA files untouched.
- Canary protects saved exact DNS:443 key, not a global root count. Intended 8443 mapping remains a separate deployment acceptance check.

## Checkpoint and review

First origin regressions fail before implementation, committed as c22782a. Origin/route tests then pass. Final targeted tests pass with 372 assertions. Full tests execute all other loaded suites successfully but locale-scan cannot load TypeScript. Frozen dependency install timed out after 120 seconds; bounded second attempt also timed out after 30 seconds. No dependency versions or lockfile were changed. Stop retrying dependency installation in this unit.

Public origin is required on DaemonConfig. Ten existing test files receive only mechanical fixture fields, including fixtures that previously overrode tailscaleHost after configuration parsing. No runtime dual-source fallback was introduced. Internal authority comes from stripping the fixed HTTPS prefix of the canonical string, avoiding revalidation of already-validated state.

Read the production diff and removed the obsolete sole-listener comment. Kept the existing trust-boundary explanation and ShellCheck directive, with the directive immediately above source. Added no explanatory application-code comments. No independent no-comments reviewer ran because subdelegation is forbidden. Parent must perform independent code/security review before integration. Model the Domain selected one canonical string rather than synchronized derived state. Test Behavior, Not Implementation selected production handleRequest plus injected SessionController and actual shell entrypoints rather than helper-only authorization claims.

Intended 8443 mapping is a separate explicit deployment acceptance step in docs/deployment.md. Protected-root parser does not inspect unrelated listeners. Saved 443 key cannot be silently changed by runtime env, and old baselines without a key fail closed.

## Deviations

- Independent prose routing and review cannot run under no-subdelegation. Any documentation changes are technical drafts for parent review.
- Advisor gate initially rejected diagnosis reads; after existence check the full read succeeded. No inferred file contents.
