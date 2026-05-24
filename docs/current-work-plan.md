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
   - Current state: implemented in the final chat layout contract and covered by
     `tests/layout_probe.py`, including composer visibility, tool-center
     reachability, two-row quick-command hotbar visibility, dungeon panel
     clickability, and page-level overflow guards.

2. Message classification regression suite
   - Player plain messages that should stay in focus remain visible.
   - Known routine or dungeon bot replies that should be archived do not leak
     into focus.
   - Blood Trial messages are always archived.
   - Falling Demon Heart Trial messages are archived unless they are a direct
     reply or mention for the active identity.
   - Xutian rear-hall stop messages are archived and labeled.
   - Current state: covered by parser/filter regression tests. New examples
     should still be added when real misclassified messages appear, rather than
     broadening heuristics from guesses.

3. State-machine audit and improvements
   - Inventory, official schedules, dungeon guides, cooldowns, and listener
     health each document state source, trigger, refresh path, failure mode,
     and manual fallback.
   - Automatic refresh reduces manual refresh pressure without removing the
     manual fallback.
   - Outbox automation uses a guarded dry-run-first flow before any sender
     adapter can dispatch; the optional `auto_pending` worker consumes only
     queued outbox drafts through the same policy guard.
   - Official schedule creation respects the observed 100 scheduled-message
     per-identity boundary and refuses additional automation with a manual
     handling notice.
   - Current state: inventory auto-refreshes while open and names the owners
     that need manual `.储物袋` calibration; `inventory_current` consumes stable
     Wanbaolou listing/delisting, gift, and tree-harvest success replies as
     conservative deltas; official schedule manual handling details persist in
     the modal status line. The official schedule rail and modal live in
     `web/static/views/schedule.js`; the resource stats modal and coverage
     renderer live in `web/static/views/resource_stats.js`; identity state
     refresh is part of the normal identity refresh path. Outbox automation
     guard logic lives in `backend/outbox/automation.py`; sender adapters live
     in `backend/outbox/adapters.py`; the optional queue worker lives in
     `backend/outbox/worker.py`. Outbox drafts, send-plan rendering, and
     automation decision panels live in `web/static/views/outbox.js`, while
     `web/static/app.js` keeps `/api/outbox/auto-plan`,
     `/api/outbox/auto-dispatch`, and `/api/outbox/auto-queue` wrappers for
     guarded dry-run/dispatch/queue checks.

4. Tool center cleanup
   - Common workflows remain on the main page.
   - Settings, health, refresh, identity, and notification controls live in the
     tool center without duplicating controls already present elsewhere.
   - Secondary panels are grouped by usage frequency and do not hide chat input.
   - Current state: common workflows stay on the main page, and the top-right
     tool center is covered by layout probe checks. Future work should avoid
     adding new always-visible header controls unless they pass the same width
     and clickability checks.

5. Dungeon panel page-game pass
   - Cangkun and Xutian expose current stage, route/history, advice, and known
     failure boundaries in a dedicated panel.
   - Dungeon state is projected from messages, not from an automatic sender.
   - Uncertain route recommendations are explicit and conservative.
   - Current state: Cangkun and Xutian playbook cards are in the dungeon modal.
     Cangkun uses the conservative route guide; Xutian shows stage, route,
     advice, 后殿 boundary notes, and curated negative examples while keeping
     command buttons as composer-fill actions only. The dungeon status modal and
     standalone Xutian/Cangkun guide modals live in
     `web/static/views/dungeon_status.js`, `web/static/views/xutian_guide.js`,
     and `web/static/views/cangkun_guide.js` with status/guide loading injected
     from `web/static/app.js`.

6. Frontend CSS/module debt cleanup
   - Chat shell, composer, tool center, and dungeon panels have clear ownership.
   - New fixes land in final contract files or small modules, not as unrelated
     overrides across multiple sections.
   - Current state: chat viewport stability lives in `web/static/chat-layout.css`;
     inventory lives in `web/static/views/inventory.js`; dungeon Xutian/Cangkun
     playbook cards live in `web/static/views/dungeon_playbook.js`; the dungeon
     status modal shell and refresh flow live in
     `web/static/views/dungeon_status.js`, along with reusable status render
     helpers. The identity status modal and shared module-status helpers live in
     `web/static/views/identity_status.js`; the cultivation status modal and
     timers live in `web/static/views/cultivation.js`. The overview detail panel
     lives in `web/static/views/overview.js`; the quest tracker and manual
     action-fill flow live in `web/static/views/quest_tracker.js`. The game
     scene board and manual scene actions live in
     `web/static/views/game_scene.js`. The resource stats modal and coverage
     renderer live in `web/static/views/resource_stats.js`; the world report
     modal lives in `web/static/views/world_report.js` with composite payload
     loading injected from `web/static/app.js`; the world event strip and
     manual event actions live in `web/static/views/world_event.js`. The
     live situation board and signal snapshot helpers live in
     `web/static/views/live_situation.js`. The game cockpit, primary strip, and
     action dock live in `web/static/views/game_cockpit.js`. The global
     health/setup banner lives in `web/static/views/global_banner.js`. The leader
     intelligence modal lives in `web/static/views/leader_intel.js` with
     leader-message loading injected from `web/static/app.js`. The official
     schedule rail and modal live in `web/static/views/schedule.js`. The chat
     message stream, channel chips, quick filters, scroll anchoring, and quick actions live in
     `web/static/views/chat_stream.js`; the direct composer, emoji palette, and
     quick command hotbar live in `web/static/views/direct_composer.js`; detail
     rich cards and field formatting live in `web/static/views/detail_cards.js`;
     the message detail panel and manual action controls live in
     `web/static/views/detail_panel.js`; the focus archive rule modal lives in
     `web/static/views/focus_archive.js` with preview API injected from
     `web/static/app.js`; the filter settings modal lives in
     `web/static/views/filter_settings.js` with diagnostics and preview APIs
     injected from `web/static/app.js`; the access settings modal, automation
     guard form, Telegram dialog/topic option renderers, and read-only
     Telegram account list live in
     `web/static/views/settings.js`; the Telegram account login/logout modals,
     listen-target renderers, account login/listen-target event flow, account status line, and account action guards live in
     `web/static/views/account_management.js`; the sidebar identity list,
     identity snapshot,
     identity module chips,
     add-identity modal body/event flow, and send_as list/selection/status/result renderers live in
     `web/static/views/identity_management.js`,
     while
     `web/static/app.js` keeps
     compatibility wrappers and injected account/identity/send_as API orchestration callbacks.

## Remaining Work

- Keep adding concrete message-classification fixtures only from observed bad
  samples.
- Add new inventory delta parsers only from stable real bot success replies,
  then backfill `inventory_current`; current stable families are Wanbaolou
  listing/delisting, gift, and tree harvest.
- Treat official schedule Telegram-history sync as reconciliation only; never
  use it to exceed the local 100-message guard.
- Keep automatic dispatch limited to explicit settings allowlists; unrecognized
  commands, dungeon choices, and ambiguous actions stay manual.
- Continue CSS/module cleanup opportunistically when a touched surface already
  has tests or layout-probe coverage.

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
