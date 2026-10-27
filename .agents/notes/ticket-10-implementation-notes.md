# Ticket #10 implementation notes

## Scope and initial facts

- Implement the persona registry/create/recovery/message loop in the existing standalone daemon; keep Collie zero-touch and do not write under `~/.local/share/collie/`.
- Herdr wire contract was verified from `~/.local/share/collie/HERDR_API.md` and its client/adapter: NDJSON with string request IDs, one RPC per connection except `events.subscribe`; `workspace.create {cwd,focus:false,label?}`, `pane.send_text {pane_id,text}`, `pane.send_keys {pane_id,keys}`, and `session.snapshot {}`. The `workspace.create` response contains workspace/tab/root pane IDs.
- Herdr API does not provide a single "launch agent" method in the checked client; launch means creating/choosing an allowlisted launcher command and submitting it to a Herdr shell pane. Preserve launchers allowlisting by sourcing commands from the existing Collie launcher API, not accepting arbitrary client commands.
- Existing daemon already owns Origin/JSON checks for writes and the narrow Collie bridge proxy; persona routes must follow those same access checks.

## Decisions / deviations

- Initial edits were mistakenly made in the integration checkout. On coordinator correction, stashed all changes and moved them into `/Users/rolex/Documents/Codes/githubProject/MyProject/homeling.ticket-10-persona-loop`, a Worktrunk branch based on `integrate-v1`; main checkout is clean. The stash contained ticket #7 TaskDetail/RawPane work too, so those six files and related raw-pane/task-detail changes were handed off to `/tmp/t7-handoff/` and excluded from this branch.
- Registry records use atomic temp-file + rename persistence. Create flow must not publish a persona until workspace and main-pane launch succeed; on failure close/rollback resources when possible and return an explicit failure rather than leaving an incomplete registry record.
- Recovery uses persisted workspace/pane IDs plus `session.snapshot` as truth. Missing main panes are repaired using the launcher selection allowed for the persona; unreachable Herdr is surfaced rather than silently modifying registry state.

## Work log

- Read the issue, PRD §6, glossary and ADR-0001; confirmed existing source on `integrate-v1` includes snapshot, history, launch proxy and message reply capabilities from the ticket dependencies.
- Added `HerdrSocketClient` as an independent NDJSON one-shot client plus event stream. A memory Unix socket test exercises `workspace.create`, `tab.create`, send text/Enter, snapshot, close, rename, and events; no Herdr CLI writes or Collie filesystem edits.
- Registry mutations serialize the full read-transform-temp-write-rename operation; serializing only file writes would lose a concurrent upsert computed from stale state.
- During persona first-message injection, the actual pane transcript contains the system-prompt prefix. The daemon returns that exact submitted string as a confirmation hint so the existing history matcher can still confirm delivery against the transcript while the UI keeps showing only the user's text.
- Herdr has no workspace-close RPC. Failed creates close panes best-effort and persist an orphan marker for the remaining empty/unknown space; deletes close only the main pane and keep the space archived, not the task panes.
- Rescue continuation preserved all 24 original dirty paths in jj change `rmtsxrvm`; no reset, new worktree, Collie write, push, issue update, or integration bookmark move. Merged integration task-detail baseline, resume notes (`9fce9756`), and ticket #21 (`1ea5775e`).
- Stable `/persona/:personaId` URLs resolve the registry's current main pane; legacy pane-bearing persona links redirect to that stable route. Task-detail return links retain persona identity so task storage and subsequent launches remain owned after returning or rebuilding the main pane.
- A transient persona-list failure retains the mounted conversation and reports a warning, rather than dropping drafts, outgoing messages, and unknown-delivery locks. A successful response confirming deletion still removes the conversation.
- Review exposed a real protocol mismatch: Herdr agents carry `agent_status`, not `status`. The in-memory wire fixture now uses the observed protocol and verifies working/blocked/idle/done projections; the old code failed that regression before correction.
- Registry cold initialization now shares one read promise. A delayed filesystem-read regression proved that an older read could otherwise overwrite a newly committed persona; the injected reader is a filesystem boundary, not a mock of registry internals. Failed initialization remains retryable.
- Regression coverage includes stable persona navigation, task-detail return, delayed stable-shell launch in create/task/recovery, restarted runtime recovery without adopting unrelated spaces, concurrent field PATCH/message-marker updates, delete races, failed task rollback, and split UTF-8 RPC/event frames. Existing inherited fixes were tested as regressions, not represented as new RED cycles.
- Scope boundary for ticket #19: `GET persona/list` calls recovery and can create/launch panes or rename archived spaces. Startup, event, periodic, and GET recovery share `recoverPersonas`; launch readiness and actual launcher writes share `startLauncher`. A later idle-lock ticket must guard these write paths too; this ticket does not implement a lock.

## Acceptance and remaining device checks

- AC1: minimal name/color form and list, API → Herdr workspace/main-pane creation covered in memory. Phone/Tailscale creation remains a device check.
- AC2: persona message API routes to the bound pane and returns the exact injected transcript confirmation; partial outcomes retain confirmation and guard semantics. Real agent consumption/reply remains a device check; HTTP success alone is not delivery.
- AC3: a new runtime/registry reload retains associations, preserves unrelated spaces, and recreates an exited main pane in the same space with prompt injection reset. Persona routes follow the current binding.
- AC4: rejected or partial create never publishes a persona; known panes are rolled back, retained empty/unknown spaces are explicitly recorded as orphans. No verified workspace-close API exists, so orphan space cleanup can require a human.
- AC5: owned tasks are created in the persona space, task chips use stable persona storage and return navigation, and unlisted/failed task launches do not produce successful tasks. Historical ticket #6 tasks are not migrated.
- AC6: atomic registry persistence survives reload; serialized field patches, deletion coordination, and shared cold initialization avoid overwrite/resurrection races.

## Final verification

- Final `bun test`: 227 pass / 0 fail across 32 files; explicit persona integration + registry run: 17 pass / 0 fail. `bun run typecheck` and `bun run build` both passed after latest integration merge.
- Code review findings fixed; consultant's source-only acceptance review found no remaining demonstrable blocker. Applied two equivalent simplifications: registry mutations return their result directly, and message handling names its accepted/text-delivered decisions.

## Tool limitation

- `modern-web-guidance` was loaded, but its `npx ...@latest search` execution was denied by the tool permission gate; no bypass or package installation was attempted. React Router official route/param documentation was fetched through Context7. Mounted draft preservation across a failing persona poll still needs browser/device verification; the local frontend tests are server-rendered.

