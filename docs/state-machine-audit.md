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
| Current gap | Deltas still only cover known safe reply families: Wanbaolou listing/delisting, gift, and tree harvest. Unknown reward text must not mutate inventory. |
| Next action | Add new delta parsers only with fixtures from real bot replies, then backfill `inventory_current`. |

## Official Schedules

| Field | Current contract |
| --- | --- |
| State source | `official_schedule_batches` and `official_scheduled_messages`; real Telegram scheduled messages are represented by local rows with `scheduled` status. |
| Trigger | User opens an official schedule preset. `build_plan` clamps horizon to 7 days and expands the preset into scheduled commands. |
| Refresh path | `/api/schedule` lists batch/message status. Background send updates each item to `scheduled` or `failed`; the UI polls active sending batches. The official schedule rail and modal are isolated in `web/static/views/schedule.js`, with `web/static/app.js` only keeping orchestration wrappers. |
| Failure/manual fallback | A single send-as identity is capped at 100 planned/scheduled official messages. If creation would exceed 100, the API returns `quota_blocked`, `manual_required`, and a manual handling message. If Telegram reports the same limit during background send, remaining items are marked failed and sending stops. The UI keeps the detailed manual-handling messages in the modal status line instead of relying only on an alert. |
| Current gap | The local count is an estimate until scheduled history is reconciled against Telegram. Local deletion marks rows deleted, but externally deleted Telegram scheduled messages still need explicit sync. |
| Next action | Keep the 100-message guard local and strict; add Telegram history sync only as a reconciliation tool, not as a reason to exceed the local guard. |

## Resource Stats

| Field | Current contract |
| --- | --- |
| State source | Resource events and deltas derived from stored message cards. Blood trial remains archived out of this stats surface. |
| Trigger | Message ingest parses observed settlement replies; `/api/resource-stats` and `/api/resource-coverage` expose read-only summaries and parser coverage diagnostics. |
| Refresh path | The resource stats modal and coverage renderer are isolated in `web/static/views/resource_stats.js`, with `web/static/app.js` keeping compatibility wrappers for world report, health, and cockpit summaries. |
| Failure/manual fallback | Coverage diagnosis can highlight likely missed samples and reparse recent candidates, but unknown reward text does not mutate inventory or create sends. The health modal reuses the same coverage renderer so message-box gaps remain visible beside stats trust signals. |
| Current gap | Parser coverage still depends on observed stable bot replies, so new gameplay text should become fixtures before it is promoted into stats logic. |
| Next action | Add parser coverage only from real missed samples and keep the resource modal read-only. |

## Identity Cooldowns

| Field | Current contract |
| --- | --- |
| State source | `identity_module_state` rows keyed by `(send_as_id, module_key)`. Modules live under `backend/identity_state/`. |
| Trigger | `ModuleRegistry.observe_all` observes real game-bot replies. Most modules resolve the target identity from the replied-to user command. |
| Refresh path | `/api/identity-state` returns module state plus `status_summary`; identity loading and manual refresh both refresh module state, and official schedules can ask modules for an auto anchor. |
| Failure/manual fallback | No bot reply means no state update. If a module cannot compute an anchor, schedule planning falls back to the normal anchor/default time. |
| Current gap | Coverage is uneven: deep retreat, pet touch/warm, weakness, small world, and generic cooldowns are represented, but some newer gameplay loops remain message-only. |
| Next action | Add modules only where replies expose stable cooldown or readiness text; otherwise keep the result in message cards or dungeon panels. |

## Dungeon Status And Guides

| Field | Current contract |
| --- | --- |
| State source | Parsed dungeon cards plus the `dungeon_rooms` cache. Cangkun and Xutian guides live in `backend/features/cangkun_guide.py` and `backend/features/xutian_guide.py`. |
| Trigger | Message ingest classifies dungeon messages. `/api/dungeon-status` derives summaries from recent cards and hydrates context from open-room history when needed. |
| Refresh path | Recent view uses a fast window; expanded view does full lookup and refreshes the durable dungeon cache. |
| Failure/manual fallback | `.加入副本` is only a request until a bot success/failure reply arrives. Route advice is conservative and must surface uncertainty instead of pretending to know future outcomes. Dungeon playbook actions fill the composer only; they do not send automatically. |
| Current gap | Cangkun has stronger route history than Xutian. Xutian now exposes phase, route, 后殿 boundary notes, and curated negative examples in the playbook panel, but its recommendation confidence is still limited by the sample library. |
| Next action | Continue enriching Cangkun/Xutian guides from observed messages and keep the UI on top of existing guide/status payloads rather than inventing a second dungeon state store. |

## Listener Health

| Field | Current contract |
| --- | --- |
| State source | `TelegramListenerManager.status()`, account login/listener fields, and stored raw message continuity. |
| Trigger | Account login/listener start/stop and message ingest update visible state. Health endpoints read current listener status and recent message continuity. |
| Refresh path | `/api/health`, `/api/health/audit`, and the health modal expose listener state without SSH. |
| Failure/manual fallback | If the listener is stopped, disconnected, or has obvious message gaps, the user must restart or backfill before trusting derived state. |
| Current gap | Health can show symptoms, but it cannot prove Telegram upstream completeness without active backfill or scheduled history reconciliation. |
| Next action | Keep health in the tool center and use it as a diagnostic surface, not as a gameplay action surface. |

## Outbox Automation

| Field | Current contract |
| --- | --- |
| State source | `OutboxPlanner` resolves command, identity, account, reply context, and target chat; `backend/outbox/automation.py` derives `skill_key`, idempotency key, adapter, allowlist status, dry-run mode, and recent `auto_send` audit history. |
| Trigger | A detail-panel send plan can call `/api/outbox/auto-plan` for policy inspection, `/api/outbox/auto-dispatch` for a guarded dry-run/dispatch attempt, or `/api/outbox/auto-queue` to create an `auto_pending` draft for the optional worker. Settings control `automation_enabled`, `automation_dry_run`, `automation_sender_adapter`, skill allowlist, identity allowlist, per-minute limit, and worker cadence. |
| Refresh path | `web/static/views/outbox.js` renders outbox drafts, send plans, backend automation decisions, adapter names, idempotency keys, and queue counts. The access settings modal, automation guard form, and read-only Telegram account list are isolated in `web/static/views/settings.js`, while `web/static/app.js` keeps `/api/settings`, login, notification-test, and outbox automation API wrappers. `backend/outbox/adapters.py` owns sender adapter dispatch; `backend/outbox/worker.py` consumes only `auto_pending` drafts by calling the same `/api/outbox/auto-dispatch` path. `send_logs` stores `auto_send` rows with `dry_run`, `blocked`, `success`, or `failed` status, separate from `manual_send`. |
| Failure/manual fallback | Automation is disabled and dry-run by default, and the worker is disabled by default. Unknown commands, empty skill allowlists, non-allowlisted skills, unsupported adapters, missing identity/context, duplicate idempotency keys, and rate-limit hits all return `manual_required` instead of sending. Dungeon choices and ambiguous actions remain manual unless explicitly allowlisted later. |
| Current gap | The active adapter is the existing user-session sender; AyuGram GUI/IPC are represented as configuration targets but remain unsupported until a real adapter implementation is added behind the same policy guard and audit log. |
| Next action | Promote only low-risk query commands after observed use, keeping gameplay choices behind manual confirmation unless a separate fixture-backed policy exists. |

## Chat Stream

| Field | Current contract |
| --- | --- |
| State source | Stored message cards in the active frontend state. |
| Trigger | Channel selection, search, new message polling, reply jumps, and explicit user clicks rebuild or anchor the visible stream. |
| Refresh path | The chat message stream, channel chips, quick filters, scroll anchoring, and quick-action renderer are isolated in `web/static/views/chat_stream.js`, with `web/static/app.js` keeping compatibility wrappers for existing panels. |
| Failure/manual fallback | Chat stream quick actions fill the composer only; they do not call send APIs or bypass the bottom composer confirmation path. |
| Current gap | Classification quality still depends on observed bad samples and backend channel tags, so uncertain messages should stay visible rather than being aggressively archived. |
| Next action | Keep message-flow UI fixes in the chat stream module and add fixtures only from real misclassified messages. |

## Direct Composer

| Field | Current contract |
| --- | --- |
| State source | The active identity, selected message, reply context, quick-command catalog, and identity cooldown state in the frontend store. |
| Trigger | Composer input events, emoji insertion, selected-message actions, quick-command hotbar clicks, identity changes, and explicit submit clicks update or submit the composer. |
| Refresh path | The direct composer, emoji palette, and quick command hotbar are isolated in `web/static/views/direct_composer.js`, with `web/static/app.js` keeping API send and global-state wrappers. |
| Failure/manual fallback | Direct composer sends only through the injected explicit composer-submit callback. The view module fills or updates the composer and does not call `/api/skills/send` directly. |
| Current gap | Quick-command ranking still follows static priority words and unlocked-state projections, so new shortcuts should be promoted only after repeated observed use. |
| Next action | Keep send APIs out of the view module and move future composer UI refinements behind dependency-injected callbacks. |

## Detail Cards

| Field | Current contract |
| --- | --- |
| State source | The selected message card and its parsed `fields`, `title`, `summary`, `tags`, and channels. |
| Trigger | Opening a message detail panel renders a rich card or falls back to the structured field grid. |
| Refresh path | Detail rich cards and field formatting are isolated in `web/static/views/detail_cards.js`, with `web/static/app.js` keeping compatibility wrappers for callers that need `formatFieldValue` or detail rendering. |
| Failure/manual fallback | Detail cards are read-only renderers. They do not call APIs, enqueue drafts, or send commands; action buttons remain in the detail action stage and bottom composer path. |
| Current gap | Rich card coverage still follows known titles and channel families; unknown gameplay cards fall back to generic rendering or the field grid. |
| Next action | Add card renderers only for stable parsed fields, keeping send/copy/draft behavior outside this module. |

## Detail Panel

| Field | Current contract |
| --- | --- |
| State source | The selected message card, current detail mode, focus archive settings, and the draft notice map. |
| Trigger | Selecting a message or opening overview renders the detail panel; action buttons can fill the composer, copy, generate a send plan, enqueue a draft, or open focus archive tools. |
| Refresh path | The message detail panel and manual action controls are isolated in `web/static/views/detail_panel.js`, with `web/static/app.js` keeping API and composer dependencies as injected callbacks. |
| Failure/manual fallback | Detail panel actions fill the composer or create manual plans/drafts only. The module does not call send APIs or create direct API requests; `/api/skills/send` remains reachable only through the bottom composer confirmation path. |
| Current gap | Detail action behavior still depends on the parsed action suggestions attached to each message, so ambiguous game replies should remain visible for manual review. |
| Next action | Keep new detail actions dependency-injected and test that no direct send or API call enters the detail panel module. |

## Maintenance Rules

- Prefer existing state stores and APIs before adding new state tables.
- Treat bot replies and authoritative snapshots as state transitions; treat user commands as intent only.
- Keep manual refresh buttons for every state machine that can drift from Telegram or bot-side truth.
- Add regression tests for boundaries before making UI depend on a state signal.
