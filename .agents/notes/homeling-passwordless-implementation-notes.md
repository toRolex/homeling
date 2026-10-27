# Homeling passwordless implementation notes

## Status

| Work unit | State | Artifacts and evidence | Next step |
| --- | --- | --- | --- |
| Config and daemon session policy | Implemented | Explicit mode, trusted private reads, secret-free establish, unchanged admission fences | Independent review by parent. |
| Browser session lifecycle and copy | Implemented | Validated metadata, bounded establish, cookie confirmation, catch-up, retry, hidden password controls, six-language copy | Authorized browser and phone verification after deployment. |
| Focused tests and full validation | Passed | `bun test` passed 563 tests across 92 files; typecheck and build passed. Logs are listed in `/tmp/homeling-passwordless-sol-takeover.md`. | Parent reviews synthetic coverage and deployment constraints. |
| Commit and implementation report | Candidate complete | `/tmp/homeling-passwordless-sol-takeover.md` records takeover, validation, commit and remaining limits. | Parent owns independent review and deployment. |

## Entry and scope

Direct implementation is appropriate because the user supplied and the parent accepted a detailed, executable security contract. This is one cross-cutting feature with an explicitly fixed shape, and the user prohibited subagents. Work only in this T3 worktree. The branch was advanced with a clean fast-forward from `afc8767deefceb5006ec0647828c4541f2580d2b` to deployed-source baseline `61b5356335f25adfdecf6d2fbf8a9f7bf437a9f7`.

## Throughput checkpoint

- Blocking first steps: read the contract and project/config/session/transport/client code. Completed before edits.
- Independent workstreams: daemon authorization and browser lifecycle are separate phases, but the types cross both, so implement and verify the daemon phase first.
- Shared mutable state: all work is confined to this worktree; server lease and client revision fences remain the existing shared-state boundaries.
- Smallest safe decomposition: one owner is required because the browser depends on the server mode and establish protocol; no subagents are permitted.

## Decisions

| Decision | Reason | Evidence |
| --- | --- | --- |
| Retain `local-unlock` as the default and add explicit `tailscale-identity` | Passwordless behavior must not weaken unrelated deployments. | `/tmp/homeling-passwordless-contract.md`, config and session source at baseline |
| Gate identity-mode private API reads on the existing exact Serve tuple, and keep mutations behind exact Origin plus lease admission | The session cookie is mutation continuity, not identity authentication. | `/tmp/homeling-passwordless-contract.md`, `apps/daemon/src/index.ts` |
| Establish through one same-origin `{}` POST, return the existing lease format, and make repeat establish with a valid lease idempotent | Do not turn a read poll into authorization or rotate cookies on retries. | `/tmp/homeling-passwordless-contract.md`, `apps/daemon/src/session-lock.ts` |
| Validate response type and shape before applying state; never display transport/parser text | A WebKit JSON parse error must not appear as a password failure or reveal raw response content. | `/tmp/homeling-passwordless-contract.md`, `apps/web/src/SessionBoundary.tsx` |

## Takeover

GPT6.1SOL took exclusive ownership of the existing dirty worktree under the user's explicit implementer exception. Effective runtime was `cliproxy/gpt-6.1-sol`, `high`. The patch was retained, not redesigned. Corrections included missing successful-response metadata, stale response fencing, bounded cookie-failure behavior, and synthetic fixtures matching the session protocol. The HomeTriage DOM fixture now has an HTTPS origin instead of `about:blank`.

## Deviations

No production changes or phone verification were performed. The actual phone HTML response source is unknown. Passing synthetic tests does not establish that the phone network issue is fixed. Independent review and deployment remain with the parent.
