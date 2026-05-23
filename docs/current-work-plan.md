# Current Work Plan

This document tracks the current multi-hour cleanup goal. It turns the broad
"do all recommended work" direction into verifiable slices.

## Scope

1. Chat UI stabilization
   - Channel switching owns the primary header width.
   - Tool center is reachable from the top-right and does not clip or overlap
     the message stream.
   - Message list and composer remain visible at desktop, tablet, and narrow
     mobile widths.
   - Width guards prevent page-level horizontal overflow.

2. Message classification regression suite
   - Player plain messages that should stay in focus remain visible.
   - Known routine or dungeon bot replies that should be archived do not leak
     into focus.
   - Blood Trial messages are always archived.
   - Falling Demon Heart Trial messages are archived unless they are a direct
     reply or mention for the active identity.
   - Xutian rear-hall stop messages are archived and labeled.

3. State-machine audit and improvements
   - Inventory, official schedules, dungeon guides, cooldowns, and listener
     health each document state source, trigger, refresh path, failure mode,
     and manual fallback.
   - Automatic refresh reduces manual refresh pressure without removing the
     manual fallback.
   - Official schedule creation respects the observed 100 scheduled-message
     per-identity boundary and refuses additional automation with a manual
     handling notice.

4. Tool center cleanup
   - Common workflows remain on the main page.
   - Settings, health, refresh, identity, and notification controls live in the
     tool center without duplicating controls already present elsewhere.
   - Secondary panels are grouped by usage frequency and do not hide chat input.

5. Dungeon panel page-game pass
   - Cangkun and Xutian expose current stage, route/history, advice, and known
     failure boundaries in a dedicated panel.
   - Dungeon state is projected from messages, not from an automatic sender.
   - Uncertain route recommendations are explicit and conservative.

6. Frontend CSS/module debt cleanup
   - Chat shell, composer, tool center, and dungeon panels have clear ownership.
   - New fixes land in final contract files or small modules, not as unrelated
     overrides across multiple sections.

## Verification

- Backend/parser changes: targeted pytest first, then `pytest -q` before a
  milestone commit.
- Frontend syntax: `node --check web/static/app.js` plus any changed view
  modules.
- Layout changes: browser checks at 1280, 1024, 800, and 390 px, including
  `documentElement.scrollWidth <= innerWidth`, tool center open state, message
  list, and composer visibility.
- Runtime changes: restart `xiuxian-mini-web.service`, then verify
  `/api/health` returns `ok` and listener status settles to `running`.
- Repository changes: each coherent milestone is committed and pushed to the
  SSH remote.
