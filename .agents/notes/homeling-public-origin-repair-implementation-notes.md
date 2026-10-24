# Public origin repair implementation

## Status

- Canonical origin and route regressions. In progress. Products in config.ts, index.ts and their tests. Next run failing regressions.
- Protected 443 canary and shell fixtures. Not started. Next implement exact saved authority.
- Narrow installer persistence and deployment technical draft. Not started. Prose routing blocked by no-subdelegation instruction. Parent must route final prose review.
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

## Deviations

- Independent prose routing and review cannot run under no-subdelegation. Any documentation changes are technical drafts for parent review.
- Advisor gate initially rejected diagnosis reads; after existence check the full read succeeded. No inferred file contents.
