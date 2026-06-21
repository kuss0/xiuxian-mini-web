# State Machine Audit

This audit tracks the modules that already behave like state machines and the
fallbacks that keep them maintainable. The main rule is conservative: observed
bot replies and stored snapshots can move state forward; user commands alone
do not prove success.

## Inventory

| Field | Current contract |
| --- | --- |
| State source | `inventory_snapshots`, `inventory_items`, and `inventory_current` in SQLite. A `.储物袋` panel is the authoritative snapshot; confirmed success replies become conservative deltas. |
| Trigger | `backend/parsers/inventory.py` parses snapshots and deltas during message ingest. Store ingestion replaces the owner snapshot and replays later deltas. |
| Refresh path | `/api/inventory` returns `snapshots`, `current`, and `state`. The inventory modal auto-refreshes while open and keeps the manual `刷新快照` button. |
| Failure/manual fallback | `state.owners[].status` is `missing`, `stale`, `estimated`, or `fresh`. Anything except `fresh` tells the user to run `.储物袋` before relying on transfer numbers; the modal lists the affected owners and reason so the user does not need to inspect each identity manually. |
| Current gap | Deltas still only cover known safe reply families: Wanbaolou listing/delisting, gift, narrowly-scoped tree harvest, and unopened dungeon room returns. Unknown reward text must not mutate inventory. |
| Next action | Add new delta parsers only with fixtures from real bot replies, then bump the inventory schema version so historical `inventory_current` is rebuilt from owner-resolvable `raw_messages`. |

## Official Schedules

| Field | Current contract |
| --- | --- |
| State source | `official_schedule_batches` and `official_scheduled_messages`; real Telegram scheduled messages are represented by local rows with `scheduled` status. |
| Trigger | User opens an official schedule preset. `build_plan` clamps horizon to 7 days and expands the preset into scheduled commands. |
| Refresh path | `/api/schedule` lists batch/message status. Background send updates each item to `scheduled` or `failed`; the UI polls active sending batches. Failed items can be manually requeued through `/api/schedule/retry-failed`; Telegram history sync can mark local-lost rows failed through `/api/schedule/sync/repair`. The official schedule rail and modal are isolated in `web/static/views/schedule.js`, with `web/static/app.js` only keeping orchestration wrappers. |
| Failure/manual fallback | A single send-as identity is capped at 100 planned/scheduled official messages. If creation or retry would exceed 100, the API returns `quota_blocked`, `manual_required`, and a manual handling message. If Telegram reports the same limit during background send, remaining items are marked failed and sending stops. The UI keeps the detailed manual-handling messages in the modal status line instead of relying only on an alert. |
| Current gap | The local count is an estimate until scheduled history is reconciled against Telegram. Local deletion marks rows deleted. Sync repair fixes only local rows that drifted away from Telegram; TG-side orphan scheduled messages remain explicit manual-review items. |
| Next action | Keep the 100-message guard local and strict; use Telegram history sync only as reconciliation and manual repair, not as a reason to exceed the local guard. |

## Resource Stats

| Field | Current contract |
| --- | --- |
| State source | Resource events and deltas derived from stored message cards. Blood trial remains archived out of this stats surface. |
| Trigger | Message ingest parses observed settlement replies; `/api/resource-stats` and `/api/resource-coverage` expose read-only summaries and parser coverage diagnostics. |
| Refresh path | The resource stats modal and coverage renderer are isolated in `web/static/views/resource_stats.js`, with `web/static/app.js` keeping compatibility wrappers for health and cockpit summaries. The world report modal is isolated in `web/static/views/world_report.js`, with composite health/dungeon/resource/intel/priority loading injected from `web/static/app.js`. |
| Failure/manual fallback | Coverage diagnosis can highlight likely missed samples and reparse recent candidates, but unknown reward text does not mutate inventory or create sends. The health modal reuses the same coverage renderer so message-box gaps remain visible beside stats trust signals. |
| Current gap | Parser coverage still depends on observed stable bot replies, so new gameplay text should become fixtures before it is promoted into stats logic. |
| Next action | Add parser coverage only from real missed samples and keep the resource modal read-only. |

## Identity Cooldowns

| Field | Current contract |
| --- | --- |
| State source | `identity_module_state` rows keyed by `(send_as_id, module_key)`. Modules live under `backend/identity_state/`; long-running flows share `backend/identity_state/phaseful.py`. |
| Trigger | `ModuleRegistry.observe_all` observes real game-bot replies. Most modules resolve the target identity from the replied-to user command. |
| Refresh path | `/api/identity-state` returns module state plus `status_summary`; identity loading and manual refresh both refresh module state, and official schedules can ask modules for an auto anchor. Sidebar identity list, identity snapshot, sidebar module chips, add-identity modal renderers/event flow, and send_as list/selection/status renderers are isolated in `web/static/views/identity_management.js`, while `web/static/app.js` keeps injected Telegram account/identity/send_as API binding, global timer orchestration, and event orchestration. |
| Failure/manual fallback | No bot reply means no state update. If a module cannot compute an anchor, schedule planning falls back to the normal anchor/default time. |
| Current gap | Coverage is uneven: deep retreat and Yuanying now use a shared phaseful model (`running`, `waiting_summary`, `post_summary_wait`, `idle`), pet touch/warm, weakness, small world, generic cooldowns, sect teach, explore rift, and divination are represented, but richer reply-state fields for ranch, wild training, search node, stargazer, tianti, tree, guanxing, formation, and three-sect modules still need dedicated observe-only modules. |
| Next action | Migrate old-script business state in backend-only slices: first phaseful/long-running flows, then reply-pending result modules, then multi-field panel modules. Do not migrate old send loops, retry loops, or cross-module runtime control flow. |

## Dungeon Status And Guides

| Field | Current contract |
| --- | --- |
| State source | Parsed dungeon cards plus the `dungeon_rooms` cache. Cangkun and Xutian guides live in `backend/features/cangkun_guide.py` and `backend/features/xutian_guide.py`. |
| Trigger | Message ingest classifies dungeon messages. `/api/dungeon-status` derives summaries from recent cards and hydrates context from open-room history when needed. |
| Refresh path | Recent view uses a fast window; expanded view does full lookup and refreshes the durable dungeon cache. The dungeon status modal and standalone Xutian/Cangkun guide modals are isolated in `web/static/views/dungeon_status.js`, `web/static/views/xutian_guide.js`, and `web/static/views/cangkun_guide.js`, with status and guide loading injected from `web/static/app.js`. |
| Failure/manual fallback | `.加入副本` is only a request until a bot success/failure reply arrives. Route advice is conservative and must surface uncertainty instead of pretending to know future outcomes. Dungeon playbook and standalone guide actions fill the composer only; they do not send automatically. |
| Current gap | Cangkun has stronger route history than Xutian. Xutian now exposes phase, route, 后殿 boundary notes, and curated negative examples in the playbook panel, but its recommendation confidence is still limited by the sample library. |
| Next action | Continue enriching Cangkun/Xutian guides from observed messages and keep the UI on top of existing guide/status payloads rather than inventing a second dungeon state store. |

## Listener Health

| Field | Current contract |
| --- | --- |
| State source | `TelegramListenerManager.status()`, account login/listener fields, and stored raw message continuity. |
| Trigger | Account login/listener start/stop and message ingest update visible state. Health endpoints read current listener status and recent message continuity. |
| Refresh path | `/api/health`, `/api/health/audit`, and the health modal expose listener state without SSH. Global health/setup banner is isolated in `web/static/views/global_banner.js`. Account login/logout modals, listen-target renderers, account login/listen-target event flow, account status line, and account action guards are isolated in `web/static/views/account_management.js`, while `web/static/app.js` keeps injected account save/login/dialog/topic/listener API orchestration. |
| Failure/manual fallback | If the listener is stopped, disconnected, or has obvious message gaps, the user must restart or backfill before trusting derived state. |
| Current gap | Health can show symptoms, but it cannot prove Telegram upstream completeness without active backfill or scheduled history reconciliation. |
| Next action | Keep health in the tool center and use it as a diagnostic surface, not as a gameplay action surface. |

## Outbox Drafts And Schedules

| Field | Current contract |
| --- | --- |
| State source | `OutboxPlanner` resolves command, identity, account, reply context, and target chat. `backend/outbox/send.py` is the manual-send executor; `backend/outbox/schedule.py` builds official-schedule plans. |
| Trigger | UI actions and log-command `.草稿` intents can call `/api/outbox/plan` or `/api/outbox/drafts`. No background outbox worker or auto-dispatch adapter is active. |
| Refresh path | `web/static/views/outbox.js` renders outbox drafts and send plans. The access settings modal, automation guard form, Telegram dialog/topic option renderers, and read-only Telegram account list are isolated in `web/static/views/settings.js`; the notification settings modal is isolated in `web/static/views/notify.js`, while `web/static/app.js` keeps `/api/settings`, login, notification-test, notification card-title, and outbox draft/plan API wrappers. |
| Failure/manual fallback | Missing identity/context, unresolved account target, or invalid commands return manual-required plan state instead of sending. Log-command intents can create outbox drafts only; `.发送` and `.官方定时` remain blocked unless a separate policy enables them later. |
| Current gap | Manual draft review is still required before user-session sending or official schedule creation. |
| Next action | Keep gameplay choices and ambiguous actions behind manual confirmation; expand log-command draft coverage only with fixture-backed routing rules. |

## Chat Stream (Removed From Live UI)

| Field | Current contract |
| --- | --- |
| State source | Stored message cards remain in SQLite and summary state, but the live page no longer renders the interactive chat stream. |
| Trigger | Chat stream view source is removed from mainline, so reply jumps and composer-fill interactions cannot open a chat UI. |
| Refresh path | `web/index.html` no longer loads chat-stream, direct-composer, or detail-panel modules, and the restore branch is `backup/chat-ui-before-removal-20260621`. Status boards use their own bounded snapshot loaders. The leader intelligence modal is isolated in `web/static/views/leader_intel.js`, with leader-message loading injected from `web/static/app.js`. The message logs modal is isolated in `web/static/views/logs.js`, with message paging/export APIs injected from `web/static/app.js`. |
| Failure/manual fallback | Chat jumps show a removed-feature notice and the user should use the records modal for raw message inspection. The leader-intel and logs modules are read-only; logs export only triggers a browser download from an injected response. |
| Current gap | Classification quality still depends on observed bad samples and backend channel tags, so uncertain data should stay available in records rather than being aggressively hidden from storage. |
| Next action | Keep message-flow fixes in parser/filter fixtures and restore the UI only from `backup/chat-ui-before-removal-20260621` if it is needed again. |

## Direct Composer (Removed From Live UI)

| Field | Current contract |
| --- | --- |
| State source | The active identity and skill catalog still feed status panels, but the live page no longer exposes a direct-send composer. |
| Trigger | Composer DOM entrypoints are absent from `web/index.html`; `web/static/app.js` blocks fill helpers and no longer keeps direct-send session state. |
| Refresh path | `web/static/views/direct_composer.js` is removed from mainline; restoration must come from `backup/chat-ui-before-removal-20260621`. `web/static/app.js` no longer contains the direct composer `/api/skills/send` submission implementation. |
| Failure/manual fallback | Manual sending through the chat composer is removed. Operators should use outbox drafts, official schedule workflows, or log-command draft intents instead of direct composer sends. |
| Current gap | Some action buttons still surface historical action labels; clicking them now returns a removed-feature notice rather than filling a composer. |
| Next action | Convert any still-useful action button into an outbox draft flow before reintroducing direct sending. |

## Detail Cards

| Field | Current contract |
| --- | --- |
| State source | The selected message card and its parsed `fields`, `title`, `summary`, `tags`, and channels. |
| Trigger | Dormant compatibility callers can render a rich card or fall back to the structured field grid, but the live chat detail pane is no longer mounted. |
| Refresh path | Detail rich cards and field formatting are isolated in `web/static/views/detail_cards.js`, with `web/static/app.js` keeping compatibility wrappers for callers that need `formatFieldValue` or detail rendering. |
| Failure/manual fallback | Detail cards are read-only renderers. They do not call APIs, enqueue drafts, or send commands. |
| Current gap | Rich card coverage still follows known titles and channel families; unknown gameplay cards fall back to generic rendering or the field grid. |
| Next action | Add card renderers only for stable parsed fields, keeping send/copy/draft behavior outside this module. |

## Detail Panel (Removed With Chat UI)

| Field | Current contract |
| --- | --- |
| State source | The selected message card, current detail mode, focus archive settings, and the draft notice map. |
| Trigger | Live chat selection and overview detail openings are blocked while `CHAT_FEATURE_ENABLED` is false; the old detail panel code is kept only for restoration. |
| Refresh path | The old message detail panel and manual action controls were removed from mainline with the chat UI; restoration must come from `backup/chat-ui-before-removal-20260621`. The focus archive rule modal is isolated in `web/static/views/focus_archive.js`, with `/api/focus-exclude/preview` injected from `web/static/app.js`; the filter settings modal is isolated in `web/static/views/filter_settings.js`, with diagnostics and focus-exclude preview APIs injected from `web/static/app.js`. |
| Failure/manual fallback | Detail panel actions no longer fill a live composer; the detail, focus-archive, and filter-settings modules do not call send APIs or create direct API requests. |
| Current gap | Some dormant detail action labels still reference historical composer behavior and should be converted to outbox draft flows before any restore. |
| Next action | Keep new detail actions dependency-injected and restore the panel only from `backup/chat-ui-before-removal-20260621` if the product direction changes. |

## Maintenance Rules

- Prefer existing state stores and APIs before adding new state tables.
- Treat bot replies and authoritative snapshots as state transitions; treat user commands as intent only.
- Keep the live frontend boundary aligned with the Rust-line module style: shell
  and workbench CSS load through `web/static/styles/pages/app-shell.css` and
  `web/static/styles/pages/workbench-layout.css`, while removed chat assets stay
  out of mainline and are not live stylesheet entrypoints.
- Keep manual refresh buttons for every state machine that can drift from Telegram or bot-side truth.
- Add regression tests for boundaries before making UI depend on a state signal.
