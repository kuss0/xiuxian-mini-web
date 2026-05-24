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
| Current gap | Deltas still only cover known safe reply families: listing, gift, and tree harvest. Unknown reward text must not mutate inventory. |
| Next action | Add new delta parsers only with fixtures from real bot replies, then backfill `inventory_current`. |

## Official Schedules

| Field | Current contract |
| --- | --- |
| State source | `official_schedule_batches` and `official_scheduled_messages`; real Telegram scheduled messages are represented by local rows with `scheduled` status. |
| Trigger | User opens an official schedule preset. `build_plan` clamps horizon to 7 days and expands the preset into scheduled commands. |
| Refresh path | `/api/schedule` lists batch/message status. Background send updates each item to `scheduled` or `failed`; the UI polls active sending batches. |
| Failure/manual fallback | A single send-as identity is capped at 100 planned/scheduled official messages. If creation would exceed 100, the API returns `quota_blocked`, `manual_required`, and a manual handling message. If Telegram reports the same limit during background send, remaining items are marked failed and sending stops. The UI keeps the detailed manual-handling messages in the modal status line instead of relying only on an alert. |
| Current gap | The local count is an estimate until scheduled history is reconciled against Telegram. Local deletion marks rows deleted, but externally deleted Telegram scheduled messages still need explicit sync. |
| Next action | Keep the 100-message guard local and strict; add Telegram history sync only as a reconciliation tool, not as a reason to exceed the local guard. |

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

## Maintenance Rules

- Prefer existing state stores and APIs before adding new state tables.
- Treat bot replies and authoritative snapshots as state transitions; treat user commands as intent only.
- Keep manual refresh buttons for every state machine that can drift from Telegram or bot-side truth.
- Add regression tests for boundaries before making UI depend on a state signal.
