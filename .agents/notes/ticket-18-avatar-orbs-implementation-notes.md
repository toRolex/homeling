# Ticket #18 implementation notes

## Scope and authorized seams
- Base integrate-v1 96bd5b2123bfd9d9e712c210a0b06495b9b053cc; isolated jj workspace/bookmark ticket-18-avatar-orbs. Main checkout and integration bookmark owned by merger.
- User authorized HTTP persona PATCH/list, durable registry reload/concurrent field patch, Customize DOM and shared PersonaAvatar rendering seams. Tests only DOM/mock/local fixtures; no browser or real services.
- Customization is an independent slot component. main.tsx receives only slot wiring; retain other slots and any session wrapper after integrating dependencies.
- Rename/avatar patches go through existing #10 registry atomic field patch; never send stale systemPrompt or prompt-injection fields.
- Orb only for fresh actual thinking state; paused/needsAttention/missing/stale/idle/blocked must remain static. Keep card/detail props compatible and extend conversation narrowly.
- #19 service admission dependency requested from implementer; no default system actor for user PATCH.

## Guidance
- React official Context7 controlled inputs/effect cleanup consulted. modern-web-guidance motion retrieved: compositor transform/opacity, static reduced-motion fallback. Installed skill warns outdated; no config mutation performed.

## Implementation and verification
- TDD vertical slices demonstrated RED then GREEN for daemon avatar PATCH/reload + concurrent prompt preservation, shared three-size customized face/pet, fresh thinking-only orb, explicit state source, malformed avatar atomically rejected, session-aware appearance client, independent Customize DOM.
- Avatar values remain protocol strings: smile/curious/sleepy and none/cat/dog. Renderer draws SVG faces/pets; missing optional fields retain smile/no-pet defaults. Bounded legacy identifiers remain durable and can be explicitly replaced in Customize.
- Daemon statusSource agent/pane/missing explains availability. Only `status=thinking` AND `statusSource=agent` may animate; stale/paused/needsAttention and conversation snapshot disagreement stay static. CSSOM verifies reduced-motion removes animation/transform; no OS/device/browser claim.
- Explicit dependency merges: #19 3d4e0f975f0072bc2d3935c7044dd6af8e6038d5, then full AppRoot green d1c283cbe37ce2caa5a495ac72bb8525d3831266 (contains service 2bd32251 and admission closure 72f57330). Main only adds Customize to AppRoot slots; protected routes and SessionBoundary remain owned by #19.
- Independent review found and corrected: interrupted 423 must stay unknown; pending PATCH must survive navigation and notify remounted forms; missing statusSource cannot animate. Regression tests cover each. Shared per-persona pending/unknown attempts block repeated saves; only explicit GET matching desired durable fields confirms unknown, never auto replay.
- Simplification pass extracted appearance comparison and changed dynamic status table/cast to explicit switch. Existing #10 atomic registry field patch retained; no stale prompt fields sent.
- One mechanical UI detector pass reported only an incumbent App.tsx gray-on-color heuristic at line 106; existing home design out of scope, not changed. Browser/visual/mobile inspection deliberately not performed.
- Acceptance consultant identified hung persona polling retaining old thinking. A narrow 10-second read deadline races the transport itself, so abort-ignoring reads cannot keep stale orbs, poison polling, or revive old thinking after late completion. Actual ConversationPage DOM controlled-clock test demonstrated RED/GREEN and recovery. No changes to send/occurrence guard ownership.
- Also demonstrated RED/GREEN for a delayed initialization GET overwriting a confirmed save after navigation; shared save settlement invalidates that old read.
- Independent reviewer closed original 423/pending navigation/missing-source findings. Full final gate rerun after the extra deadline/stale-read fixes; mobile and real service acceptance remain manual.

## Deviations
- jj workspace add --ignore-working-copy created empty workspace then failed to set its base. Only the new workspace was repaired with jj new at the explicit base; main checkout untouched.
