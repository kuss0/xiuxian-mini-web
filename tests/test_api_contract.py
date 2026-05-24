import re
from pathlib import Path

from backend.domain import CHANNELS
from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent, utc_now_iso
from backend.app import MiniWebHandler, create_handler, is_authorized_api_headers
from backend.config import MAX_ACCOUNTS, MAX_IDENTITIES, MAX_LISTENERS
import backend.server as server_module
from backend.repo.sample_store import SAMPLE_EVENTS, SampleStore
from backend.repo.sqlite_store import SQLiteStore
from backend.server import MiniWebServer
from backend.tg.client import build_telethon_proxy, split_host_port
from backend.tg.listener import (
    _format_sender_display,
    _raw_event_from_telethon,
)
from backend.outbox.planner import OutboxPlanner
from backend.processors.message_filter import enrich_filter_channels


def seed_sqlite_samples(store: SQLiteStore) -> None:
    store.ingest_many(SAMPLE_EVENTS)


def test_channels_have_unique_keys():
    keys = [channel.key for channel in CHANNELS]
    assert len(keys) == len(set(keys))


def test_default_capacity_matches_multi_account_design():
    assert MAX_ACCOUNTS == 100
    assert MAX_IDENTITIES == 100
    assert MAX_LISTENERS == 1


def test_sample_messages_reference_known_channels():
    known = {channel.key for channel in CHANNELS}
    messages = [card.to_api() for card in SampleStore().list_cards()]
    assert {message["channel"] for message in messages} <= known


def test_api_handler_route_tables_cover_collected_handlers():
    from backend.api.routes import PostRoute
    from backend.app import API_HANDLERS, GET_ROUTES, POST_ROUTES

    routed_handlers = set(GET_ROUTES.values())
    routed_handlers.update(route._handler for route in POST_ROUTES.values())

    unused_handlers = sorted(
        name for name, handler in API_HANDLERS.items()
        if handler not in routed_handlers
    )
    assert unused_handlers == []
    assert all(path.startswith("/api/") for path in GET_ROUTES)
    assert all(path.startswith("/api/") for path in POST_ROUTES)
    assert all(callable(handler) for handler in GET_ROUTES.values())
    assert all(isinstance(route, PostRoute) for route in POST_ROUTES.values())
    assert all(callable(route._handler) for route in POST_ROUTES.values())
    assert sorted(path for path, route in POST_ROUTES.items() if not route.needs_payload) == [
        "/api/listener/start",
        "/api/listener/stop",
        "/api/login/cancel",
        "/api/login/start",
    ]


def test_static_modules_are_loaded_and_cache_busted():
    from backend.app import BUILD_ID, _inject_build_id

    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text(encoding="utf-8")
    loaded_assets = re.findall(r'(?:src|href)="/static/([^"?]+)"', html)
    view_assets = {
        f"views/{path.name}"
        for path in (root / "web" / "static" / "views").glob("*.js")
    }

    missing_assets = [
        asset for asset in loaded_assets
        if not (root / "web" / "static" / asset).is_file()
    ]
    assert missing_assets == []
    assert view_assets <= set(loaded_assets)
    assert "styles.css" in loaded_assets
    assert "chat-layout.css" in loaded_assets
    assert loaded_assets.index("styles.css") < loaded_assets.index("chat-layout.css")

    injected = _inject_build_id(html.encode("utf-8")).decode("utf-8")
    for asset in loaded_assets:
        assert f'"/static/{asset}?v={BUILD_ID}"' in injected

    synthetic = '<link rel="stylesheet" href="/static/future-panel.css" /><script src="/static/views/future.js"></script>'
    injected_synthetic = _inject_build_id(synthetic.encode("utf-8")).decode("utf-8")
    assert f'"/static/future-panel.css?v={BUILD_ID}"' in injected_synthetic
    assert f'"/static/views/future.js?v={BUILD_ID}"' in injected_synthetic


def test_frontend_bootstrap_loads_registered_views_before_app():
    root = Path(__file__).resolve().parents[1]
    web_dir = root / "web"
    html = (web_dir / "index.html").read_text(encoding="utf-8")
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    scripts = re.findall(r'<script src="/static/([^"?]+)"', html)

    assert scripts[-1] == "app.js"
    for required in [
        "state.js",
        "constants.js",
        "ui/format.js",
        "api.js",
        "ui/modal.js",
        "ui/toast.js",
    ]:
        assert scripts.index(required) < scripts.index("app.js")

    view_files = sorted((web_dir / "static" / "views").glob("*.js"))
    loaded_views = [script for script in scripts if script.startswith("views/")]
    assert sorted(loaded_views) == [f"views/{path.name}" for path in view_files]
    assert all(scripts.index(view) < scripts.index("app.js") for view in loaded_views)

    registered_views = set()
    for path in view_files:
        content = path.read_text(encoding="utf-8")
        registered_views.update(re.findall(r"window\.MiniwebViews\.([A-Za-z0-9_]+)\s*=", content))
    app_view_refs = set(re.findall(r"window\.MiniwebViews\.([A-Za-z0-9_]+)\b", app_js))

    assert app_view_refs <= registered_views


def test_current_work_docs_match_implemented_state_machine_contracts():
    root = Path(__file__).resolve().parents[1]
    work_plan = (root / "docs" / "current-work-plan.md").read_text(encoding="utf-8")
    audit = (root / "docs" / "state-machine-audit.md").read_text(encoding="utf-8")
    normalized_work_plan = re.sub(r"\s+", " ", work_plan)

    assert "tests/layout_probe.py" in work_plan
    assert "two-row quick-command hotbar visibility" in work_plan
    assert "dungeon panel" in work_plan and "clickability" in work_plan
    assert "official schedule manual handling" in normalized_work_plan
    assert "details persist in the modal status line" in normalized_work_plan
    assert "inventory lives in `web/static/views/inventory.js`" in work_plan
    assert "playbook cards live in `web/static/views/dungeon_playbook.js`" in work_plan
    assert "status modal shell and refresh flow live in" in work_plan
    assert "`web/static/views/dungeon_status.js`" in work_plan
    assert "identity status modal and shared module-status helpers live in `web/static/views/identity_status.js`" in normalized_work_plan
    assert "cultivation status modal and timers live in `web/static/views/cultivation.js`" in normalized_work_plan
    assert "overview detail panel lives in `web/static/views/overview.js`" in normalized_work_plan
    assert "quest tracker and manual action-fill flow live in `web/static/views/quest_tracker.js`" in normalized_work_plan
    assert "game scene board and manual scene actions live in `web/static/views/game_scene.js`" in normalized_work_plan
    assert "resource stats modal and coverage renderer live in `web/static/views/resource_stats.js`" in normalized_work_plan
    assert "world report modal lives in `web/static/views/world_report.js`" in normalized_work_plan
    assert "official schedule rail and modal live in `web/static/views/schedule.js`" in normalized_work_plan

    assert "/api/dungeon-status" in audit
    assert "/api/dungeons/status" not in audit
    assert "modal lists the affected owners and reason" in audit
    assert "detailed manual-handling messages in the modal status line" in audit
    assert "resource stats modal and coverage renderer are isolated in `web/static/views/resource_stats.js`" in audit
    assert "official schedule rail and modal are isolated in `web/static/views/schedule.js`" in audit
    assert "Dungeon playbook actions fill the composer only" in audit
    assert "Xutian now exposes phase, route" in audit


def test_resource_stats_view_module_keeps_app_wrappers_and_health_renderer_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    resource_js = (root / "web" / "static" / "views" / "resource_stats.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function resourceStatsDeps()",
        "function resourceStatsView()",
        "async function openResourceStatsModal()",
        "return resourceStatsView().openResourceStatsModal(resourceStatsDeps())",
        "function renderResourceCoverage(payload)",
        "return resourceStatsView().renderResourceCoverage(payload)",
        "function latestResourcePeriod(rows, eventSummary)",
        "function aggregateRareResourceRows(rows)",
        "function formatResourceAmount(value, unit)",
        "renderResourceCoverage,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: resource stats modal and coverage renderer",
        "async function openResourceStatsModal(deps = {})",
        "function resourceStatsState(deps = {})",
        "function renderResourceTrustCards(deps = {}, payload)",
        "resourceStatsState(deps).messageAudit",
        "function renderResourceCoverage(payload)",
        "function latestResourcePeriod(rows, eventSummary)",
        "function aggregateRareResourceRows(rows)",
        "function formatResourceAmount(value, unit)",
        "window.MiniwebViews.resourceStats = {",
        "openResourceStatsModal,",
        "renderResourceCoverage,",
        "latestResourcePeriod,",
        "aggregateRareResourceRows,",
        "formatResourceAmount,",
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in resource_js


def test_world_report_view_module_keeps_app_wrappers_and_read_only_action_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    world_report_js = (root / "web" / "static" / "views" / "world_report.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function worldReportDeps()",
        "async function openWorldReportModal()",
        "return window.MiniwebViews.worldReport.openWorldReportModal(worldReportDeps())",
        "function renderWorldReport(payload)",
        "return window.MiniwebViews.worldReport.renderWorldReport(worldReportDeps(), payload)",
        "renderLiveSituationBoard,",
        "renderGameActionDock,",
        "fillQuestTrackerAction,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: world report modal",
        "async function openWorldReportModal(deps = {})",
        "function renderWorldReport(deps = {}, payload)",
        "function renderWorldReportQuestCard(deps = {}, message)",
        "function bindWorldReport(deps = {}, dialog, payload)",
        "window.MiniwebViews.worldReport = {",
        "openWorldReportModal,",
        "renderWorldReport,",
        "bindWorldReport,",
        "await deps.fillQuestTrackerAction?.(key, Number(indexText || 0), \"战报动作\")",
        "await deps.openResourceStatsModal?.()",
        "await deps.openDungeonStatusModal?.()",
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in world_report_js


def test_identity_status_view_module_keeps_shared_helpers_and_composer_fill_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    identity_status_js = (root / "web" / "static" / "views" / "identity_status.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function identityStatusDeps()",
        "const IDENTITY_STATUS_GROUPS = identityStatusView().IDENTITY_STATUS_GROUPS",
        "function openIdentityStatusModal()",
        "return identityStatusView().openIdentityStatusModal(identityStatusDeps())",
        "function identityModuleView(spec, item)",
        "return identityStatusView().identityModuleView(identityStatusDeps(), spec, item)",
        "function identityStatusFlatSpecs()",
        "return identityStatusView().identityStatusFlatSpecs()",
        "function tickIdentityStatusCards()",
        "return identityStatusView().tickIdentityStatusCards(identityStatusDeps())",
        "fillSkillIntoComposer,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: identity status modal and shared module helpers",
        "const IDENTITY_STATUS_GROUPS = [",
        "function openIdentityStatusModal(deps = {})",
        "function renderIdentityStatusBody(deps = {})",
        "function identityModuleView(deps = {}, spec, item)",
        "function identityStatusFlatSpecs()",
        "function tickIdentityStatusCards(deps = {})",
        "window.MiniwebViews.identityStatus = {",
        "IDENTITY_STATUS_GROUPS,",
        "openIdentityStatusModal,",
        "identityModuleView,",
        "identityStatusFlatSpecs,",
        "tickIdentityStatusCards,",
        "deps.fillSkillIntoComposer?.(button.dataset.statusSkill, button)",
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in identity_status_js


def test_cultivation_view_module_keeps_timer_and_composer_fill_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    cultivation_js = (root / "web" / "static" / "views" / "cultivation.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function cultivationDeps()",
        "function cultivationView()",
        "const CULTIVATION_MODULE_SPECS = cultivationView().CULTIVATION_MODULE_SPECS",
        "function renderCultivationModules()",
        "return cultivationView().renderCultivationModules(cultivationDeps())",
        "function renderCultivationModulesInto(container)",
        "return cultivationView().renderCultivationModulesInto(cultivationDeps(), container)",
        "function openCultivationModal()",
        "return cultivationView().openCultivationModal(cultivationDeps())",
        "function tickCultivationModules()",
        "return cultivationView().tickCultivationModules(cultivationDeps())",
        "fillSkillIntoComposer,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: cultivation status modal and timers",
        "const CULTIVATION_MODULE_SPECS = [",
        "function renderCultivationModules(deps = {})",
        "function renderCultivationModulesInto(deps = {}, container)",
        "function openCultivationModal(deps = {})",
        "function cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs)",
        "function bindCultivationModuleActions(deps = {}, container)",
        "function tickCultivationModules(deps = {})",
        "window.MiniwebViews.cultivation = {",
        "CULTIVATION_MODULE_SPECS,",
        "openCultivationModal,",
        "tickCultivationModules,",
        "deps.fillSkillIntoComposer?.(btn.dataset.cultFire, btn)",
        "deps.fillSkillIntoComposer?.(btn.dataset.cultQuery, btn)",
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in cultivation_js


def test_overview_view_module_keeps_panel_wrappers_and_manual_action_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    overview_js = (root / "web" / "static" / "views" / "overview.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function overviewDeps()",
        "function overviewView()",
        "function renderOverviewDetailPanel()",
        "return overviewView().renderOverviewDetailPanel(overviewDeps())",
        "function overviewModuleRows(activeId)",
        "return overviewView().overviewModuleRows(overviewDeps(), activeId)",
        "function renderOverviewQuestRow(message)",
        "return overviewView().renderOverviewQuestRow(overviewDeps(), message)",
        "function bindOverviewDetailPanel()",
        "return overviewView().bindOverviewDetailPanel(overviewDeps())",
        "fillQuestTrackerAction,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: overview detail panel",
        "function renderOverviewDetailPanel(deps = {})",
        "function overviewModuleRows(deps = {}, activeId)",
        "function renderOverviewModuleRow(row)",
        "function renderOverviewQuestRow(deps = {}, message)",
        "function bindOverviewDetailPanel(deps = {})",
        "window.MiniwebViews.overview = {",
        "renderOverviewDetailPanel,",
        "overviewModuleRows,",
        "bindOverviewDetailPanel,",
        "await deps.fillQuestTrackerAction?.(key, Number(indexText || 0), \"概览动作\")",
        "await Promise.all([deps.refreshChatViewport?.(), deps.loadIdentityPatches?.(), deps.loadIdentityModuleStates?.()])",
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in overview_js


def test_quest_tracker_view_module_keeps_wrappers_and_manual_fill_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    quest_tracker_js = (root / "web" / "static" / "views" / "quest_tracker.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function questTrackerDeps()",
        "function questTrackerView()",
        "function renderQuestTracker()",
        "return questTrackerView().renderQuestTracker(questTrackerDeps())",
        "function questTrackerItems()",
        "return questTrackerView().questTrackerItems(questTrackerDeps())",
        "function currentDungeonQuestItem(existingItems = [])",
        "return questTrackerView().currentDungeonQuestItem(questTrackerDeps(), existingItems)",
        "function questItemKind(message, actionEntries = null)",
        "return questTrackerView().questItemKind(questTrackerDeps(), message, actionEntries)",
        "async function fillQuestTrackerAction(key, index, label)",
        "return questTrackerView().fillQuestTrackerAction(questTrackerDeps(), key, index, label)",
        "fillDirectSendComposer,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: quest tracker and manual action filling",
        "function renderQuestTracker(deps = {})",
        "function questTrackerItems(deps = {})",
        "function currentDungeonQuestItem(deps = {}, existingItems = [])",
        "function currentModuleQuestItems(deps = {}, existingItems = [])",
        "function questTrackerRank(deps = {}, message)",
        "function renderQuestTrackerItem(deps = {}, message)",
        "function questItemKind(deps = {}, message, actionEntries = null)",
        "async function fillQuestTrackerAction(deps = {}, key, index, label)",
        "window.MiniwebViews.questTracker = {",
        "renderQuestTracker,",
        "questTrackerItems,",
        "fillQuestTrackerAction,",
        "只填入发送栏，不自动发送",
        "await fillQuestTrackerAction(deps, key, Number(indexText || 0), \"任务动作\")",
        "deps.fillDirectSendComposer?.(action.command, {",
        "statusText: deps.quickActionNeedsManualReview?.(action)",
    ]
    forbidden_module_fragments = [
        "postJson(",
        "sendDirectComposerMessage",
        '"/api/skills/send"',
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in quest_tracker_js
    for fragment in forbidden_module_fragments:
        assert fragment not in quest_tracker_js


def test_game_scene_view_module_keeps_wrappers_and_manual_action_contract():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    game_scene_js = (root / "web" / "static" / "views" / "game_scene.js").read_text(encoding="utf-8")

    required_app_fragments = [
        "function gameSceneDeps()",
        "function gameSceneView()",
        "function renderGameSceneBoard()",
        "return gameSceneView().renderGameSceneBoard(gameSceneDeps())",
        "function gameSceneSummaries()",
        "return gameSceneView().gameSceneSummaries(gameSceneDeps())",
        "function gameSceneCommandActions(def)",
        "return gameSceneView().gameSceneCommandActions(gameSceneDeps(), def)",
        "function actionableDungeonSnapshot()",
        "return gameSceneView().actionableDungeonSnapshot(gameSceneDeps())",
        "async function openGameScenePanel(panel)",
        "return gameSceneView().openGameScenePanel(gameSceneDeps(), panel)",
        "fillSkillIntoComposer,",
        "fillDirectSendComposer,",
    ]
    required_module_fragments = [
        "// MINIWEB-VIEW: game scene board and manual scene actions",
        "function renderGameSceneBoard(deps = {})",
        "function bindGameSceneBoard(deps = {}, gameSceneBoard)",
        "function gameSceneDefs()",
        "function gameSceneSummaries(deps = {})",
        "function gameSceneSnapshot(deps = {}, def)",
        "function gameSceneSkillActions(deps = {}, def)",
        "function gameSceneCommandActions(deps = {}, def)",
        "function actionableDungeonSnapshot(deps = {})",
        "async function openGameScenePanel(deps = {}, panel)",
        "window.MiniwebViews.gameScene = {",
        "renderGameSceneBoard,",
        "gameSceneSummaries,",
        "openGameScenePanel,",
        "deps.fillSkillIntoComposer?.(button.dataset.sceneSkill || \"\", button)",
        "deps.fillDirectSendComposer?.(action.command, {",
        "statusText: \"已填入副本动作，请确认原文后发送。\"",
    ]
    forbidden_module_fragments = [
        "postJson(",
        "sendDirectComposerMessage",
        '"/api/skills/send"',
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_module_fragments:
        assert fragment in game_scene_js
    for fragment in forbidden_module_fragments:
        assert fragment not in game_scene_js


def test_frontend_identity_state_refresh_is_first_class():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")

    load_identities_start = app_js.index("async function loadIdentities()")
    load_identity_states_start = app_js.index("async function loadIdentityModuleStates()")
    load_identities = app_js[load_identities_start:load_identity_states_start]
    assert "await loadIdentityModuleStates();" in load_identities
    assert "loadIdentityModuleStates().catch" not in load_identities

    refresh_start = app_js.index("refreshButton.addEventListener")
    health_start = app_js.index("if (healthButton)", refresh_start)
    refresh_handler = app_js[refresh_start:health_start]
    assert "loadIdentityModuleStates()," in refresh_handler

    cultivation_start = app_js.index("if (openCultivationButton)")
    outbox_start = app_js.index("outboxButton.addEventListener", cultivation_start)
    cultivation_handler = app_js[cultivation_start:outbox_start]
    assert "loadIdentityModuleStates()" not in cultivation_handler


def test_schedule_manual_required_details_persist_in_status_line():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    schedule_js = (root / "web" / "static" / "views" / "schedule.js").read_text(encoding="utf-8")
    css = (root / "web" / "static" / "styles.css").read_text(encoding="utf-8")

    assert "function scheduleManualMessages(result)" in app_js
    assert "function scheduleStatusWithManualMessages(baseText, manualMessages)" in app_js
    assert "window.MiniwebViews.schedule.scheduleManualMessages(result)" in app_js
    assert "window.MiniwebViews.schedule.scheduleStatusWithManualMessages(baseText, manualMessages)" in app_js
    assert "function scheduleManualMessages(result)" in schedule_js
    assert "(result?.results || []).forEach(push);" in schedule_js
    assert "function scheduleStatusWithManualMessages(baseText, manualMessages)" in schedule_js
    assert 'return `${baseText || "官方定时需要手动处理"}\\n需手动处理 ${messages.length} 条:\\n${detail}`;' in schedule_js

    create_start = schedule_js.index('if (action === "create")')
    cancel_start = schedule_js.index('if (action === "cancel")', create_start)
    create_handler = schedule_js[create_start:cancel_start]
    assert "scheduleStatusWithManualMessages(\"官方定时未创建\", manualMessages)" in create_handler
    assert "scheduleStatusWithManualMessages(stats, manualMessages)" in create_handler
    assert 'stats += `｜需手动处理 ${manualMessages.length}`' not in create_handler

    assert "function scheduleDeps()" in app_js
    assert "scheduleRail," in app_js
    assert "loadAccounts," in app_js
    assert "loadIdentities," in app_js

    modal_status = css[css.index(".modal-status-line {"):css.index(".modal-status-line.info")]
    assert "white-space: pre-line;" in modal_status
    assert "overflow-wrap: anywhere;" in modal_status


def test_inventory_modal_keeps_auto_refresh_with_manual_owner_fallback():
    root = Path(__file__).resolve().parents[1]
    inventory_js = (root / "web" / "static" / "views" / "inventory.js").read_text(encoding="utf-8")

    assert "const INVENTORY_AUTO_REFRESH_MS = 60 * 1000;" in inventory_js
    assert "await refreshInventorySnapshots(dialog);" in inventory_js
    assert "startInventoryAutoRefresh(dialog);" in inventory_js
    assert "window.setTimeout(tick, INVENTORY_AUTO_REFRESH_MS)" in inventory_js
    assert 'dialog.querySelector("#inventoryRefresh")?.addEventListener("click"' in inventory_js
    assert "refreshInventorySnapshots(dialog, { manual: true })" in inventory_js

    assert "function inventoryManualRefreshLines(dialog)" in inventory_js
    assert "function inventoryManualRefreshReason(state)" in inventory_js
    assert "state?.needs_manual_refresh" in inventory_js
    assert '需手动 .储物袋 校准:' in inventory_js
    assert '`${index + 1}. ${owner}: ${inventoryManualRefreshReason(state)}`' in inventory_js
    assert "缺快照,发送 .储物袋 建立权威基线" in inventory_js
    assert "快照偏旧(${formatInventoryAge(state?.snapshot_age_seconds)}),建议重新 .储物袋" in inventory_js
    assert "${formatNumber(estimated)} 类估算项,关键转移前建议 .储物袋" in inventory_js


def test_chat_viewport_layout_contract_keeps_composer_visible():
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text(encoding="utf-8")
    base_css = (root / "web" / "static" / "styles.css").read_text(encoding="utf-8")
    css = (root / "web" / "static" / "chat-layout.css").read_text(encoding="utf-8")

    workspace = html.index('<main class="main chat-workspace">')
    layout = html.index('<section class="layout-grid detail-closed">')
    composer = html.index('<footer id="directSendComposer" class="direct-send-composer chat-composer"')
    styles_link = html.index('<link rel="stylesheet" href="/static/styles.css"')
    layout_link = html.index('<link rel="stylesheet" href="/static/chat-layout.css"')
    assert styles_link < layout_link
    assert workspace < layout < composer
    assert '<section id="gamePrimaryStrip" class="game-primary-strip"' in html
    assert '<div id="messageList" class="message-list"></div>' in html
    assert '<div id="quickActionHotbar" class="quick-action-hotbar"' in html
    assert '<textarea id="directSendInput"' in html
    assert "/* ---------- Final chat viewport stability contract ---------- */" not in base_css
    stale_base_fragments = [
        ".chat-client-shell .quick-action-hotbar .skill-chip {\n  min-height: 34px;",
        ".chat-client-shell .direct-send-row {\n  grid-template-columns: clamp(140px, 15vw, 190px)",
        ".chat-client-shell .message-count-pill,\n.chat-client-shell .composer-tool-button",
    ]
    for fragment in stale_base_fragments:
        assert fragment not in base_css

    final_contract = css
    required_fragments = [
        "Final chat viewport stability contract.",
        ".chat-client-shell {\n  height: 100dvh;\n  max-height: 100dvh;\n  overflow: hidden;",
        ".chat-client-shell .chat-workspace {\n  display: grid;\n  grid-template-rows: auto minmax(0, 1fr) auto;",
        ".chat-client-shell .layout-grid,\n.chat-client-shell .layout-grid.detail-open,\n.chat-client-shell .layout-grid.detail-closed {\n  grid-row: 2;\n  display: grid;\n  min-height: 0;\n  height: 100%;\n  overflow: hidden;",
        ".chat-client-shell .chat-pane {\n  display: grid;\n  grid-template-rows: auto auto minmax(0, 1fr);\n  min-height: 0;\n  height: 100%;\n  overflow: hidden;",
        ".chat-client-shell .message-list {\n  grid-row: 3;\n  min-height: 0;\n  height: auto;\n  overflow-y: auto;",
        ".chat-client-shell .chat-composer {\n  grid-row: 3;\n  align-self: stretch;\n  max-height: min(34dvh, 310px);",
        ".chat-client-shell .quick-action-hotbar {\n  display: grid;\n  grid-template-columns: repeat(var(--hotbar-columns, 6), minmax(0, 1fr));\n  grid-template-rows: repeat(2, 18px);",
        "justify-content: start;",
        "max-height: 38px;",
        "overflow-x: hidden;",
        ".chat-client-shell .quick-action-hotbar .skill-chip {\n  width: 100%;\n  min-width: 0;\n  min-height: 0;\n  height: 18px;",
        ".chat-client-shell .direct-send-head {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;",
        ".chat-client-shell .direct-send-actions .composer-tool-button {\n  min-height: 26px;",
        ".chat-client-shell .direct-send-row {\n  grid-template-columns: clamp(108px, 12vw, 150px) minmax(0, 1fr) 68px;",
        "@media (max-width: 900px)",
        "grid-template-rows: clamp(112px, 20dvh, 170px) minmax(0, 1fr);",
        ".chat-client-shell .conversation-rail {\n    grid-row: 1;\n    overflow: auto;",
        ".chat-client-shell .chat-workspace {\n    grid-row: 2;\n    min-height: 0;",
        ".chat-client-shell .chat-composer {\n    position: static;\n    bottom: auto;\n    max-height: min(42dvh, 220px);",
        ".chat-client-shell .chat-pane .section-head {\n    display: grid;\n    grid-template-columns: minmax(0, 1fr);\n    grid-template-rows: auto auto;",
        ".chat-client-shell .stream-channel-tools {\n    justify-content: flex-start;",
        "scrollbar-width: none;",
        ".chat-client-shell .direct-send-row {\n    grid-template-columns: minmax(96px, 28%) minmax(0, 1fr) 72px;",
        ".chat-client-shell .workspace-tools-panel {\n  position: fixed;\n  top: 48px;\n  right: 14px;",
        "max-height: calc(100dvh - 64px);\n  align-content: start;\n  overflow: auto;",
        ".chat-client-shell .workspace-tools-panel .tool-panel {\n  order: -1;",
        ".chat-client-shell .workspace-tools-panel .tool-panel .sidebar-toolbox {\n  grid-template-columns: repeat(3, minmax(0, 1fr));",
        ".chat-client-shell .workspace-tools-toggle {\n  justify-content: center;\n  min-width: 96px;",
    ]
    for fragment in required_fragments:
        assert fragment in final_contract


def test_dungeon_playbook_panel_contract_is_read_only_until_composer_send():
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "web" / "static" / "app.js").read_text(encoding="utf-8")
    playbook_js = (root / "web" / "static" / "views" / "dungeon_playbook.js").read_text(encoding="utf-8")
    status_js = (root / "web" / "static" / "views" / "dungeon_status.js").read_text(encoding="utf-8")
    css = (root / "web" / "static" / "styles.css").read_text(encoding="utf-8")

    required_app_fragments = [
        "window.MiniwebViews.dungeonStatus.openDungeonStatusModal",
        "window.MiniwebViews.dungeonStatus.renderDungeonStatusModal",
        "window.MiniwebViews.dungeonStatus.normalizeDungeonStatusSummary",
        "dungeonStatusDeps",
        "openXutianOracleGuideModal",
        "openCangkunGuideModal",
        "window.MiniwebViews.dungeonPlaybook.renderDungeonPlaybookPanels",
        "window.MiniwebViews.dungeonPlaybook.bindDungeonPlaybookPanels",
        "fillDirectSendComposer(command",
    ]
    required_status_fragments = [
        'id="dungeonPlaybookPanels"',
        "/api/cangkun-guide",
        "/api/xutian-oracle-guide",
        "function openDungeonStatusModal",
        "function bindDungeonStatusModal",
        "async function refreshDungeonStatusModal",
        "function normalizeDungeonStatusSummary",
        "function renderDungeonStatusModal",
        "function renderCurrentDungeonPanel",
        "function bindDungeonStatusCards",
        "function visibleDungeonActions",
        "function compareActionableDungeonSummary",
        "data-cangkun-fill",
        "data-dungeon-action-index",
        "data-dungeon-jump",
        "deps.fillDungeonCommand",
        "deps.fillCangkunCommand",
        "deps.copyCommandToClipboard",
        "window.MiniwebViews.dungeonStatus",
    ]
    required_playbook_fragments = [
        "function renderDungeonPlaybookPanels",
        "function renderDungeonPlaybookCard",
        "function bindDungeonPlaybookPanels",
        "data-playbook-command",
        "data-playbook-guide",
        "data-playbook-jump",
        'label: "虚天殿"',
        'label: "苍坤上人洞府"',
        "boundaries: xutianPlaybookBoundaries(xutian, guides.xutian)",
        "function xutianPlaybookBoundaries(summary, guide)",
        "function xutianNegativeExamplesForSummary(summary, guide)",
        "后殿止步",
        "第三关结算已锁定",
        "避坑反例",
        "113/五幕 3",
        "默认 ${guide?.default_route || \"1 -> 1 -> 2\"}",
        "window.MiniwebViews.dungeonPlaybook",
    ]
    for fragment in required_app_fragments:
        assert fragment in app_js
    for fragment in required_status_fragments:
        assert fragment in status_js
    for fragment in required_playbook_fragments:
        assert fragment in playbook_js

    handler_start = playbook_js.index("function bindDungeonPlaybookPanels(root")
    handler_end = playbook_js.index("window.MiniwebViews = window.MiniwebViews || {}", handler_start)
    playbook_handler = playbook_js[handler_start:handler_end]
    app_wrapper_start = app_js.index("function bindDungeonPlaybookPanels(root)")
    app_wrapper_end = app_js.index("function renderCurrentDungeonPanel", app_wrapper_start)
    app_wrapper = app_js[app_wrapper_start:app_wrapper_end]
    assert 'statusText: "已填入副本命令，请确认后发送。"' in app_wrapper
    assert "deps.fillCommand?.(command)" in playbook_handler
    assert "postJson(" not in playbook_handler
    assert "sendDirectComposerMessage" not in playbook_handler
    assert '"/api/skills/send"' not in playbook_handler

    required_css_fragments = [
        ".dungeon-playbook-panels {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));",
        ".dungeon-playbook-card.xutian",
        ".dungeon-playbook-card.cangkun",
        ".dungeon-playbook-boundaries",
        ".dungeon-playbook-boundaries span",
        ".dungeon-playbook-boundaries b",
        ".dungeon-playbook-actions button",
        "@media (max-width: 720px)",
        ".dungeon-playbook-panels {\n    grid-template-columns: 1fr;",
        ".dungeon-playbook-head {\n    display: grid;",
        ".dungeon-playbook-head small {\n    max-width: none;\n    text-align: left;",
    ]
    for fragment in required_css_fragments:
        assert fragment in css


def test_sample_store_filters_by_secondary_channel():
    messages = [card.to_api() for card in SampleStore().list_cards("dungeon")]
    assert len(messages) == 1
    assert messages[0]["title"] == "虚天殿开启"


def test_message_filter_promotes_plain_mentions_and_archives_commands():
    base = ParsedCard(
        id="x",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="玩家",
        time="",
        tags=(),
        raw="",
    )

    plain = enrich_filter_channels(
        base,
        RawMessageEvent(id="x1", chat_id=1, msg_id=1, text="今晚虚天殿有人吗", source="玩家", date=""),
        {"focus_keywords": ["虚天殿"], "focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
    )
    command = enrich_filter_channels(
        base,
        RawMessageEvent(id="x2", chat_id=1, msg_id=2, text=".加入副本 394", source="玩家", date=""),
        {"archive_dot_commands": True, "focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
    )
    keyword_command = enrich_filter_channels(
        base,
        RawMessageEvent(id="x2b", chat_id=1, msg_id=22, text=".洞府", source="玩家", date=""),
        {"archive_dot_commands": True, "focus_keywords": ["洞府"], "focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
    )
    mention = enrich_filter_channels(
        base,
        RawMessageEvent(id="x3", chat_id=1, msg_id=3, text="@wa2000 来看玄骨", source="玩家", date=""),
        {"own_aliases": ["wa2000"], "focus_keywords": []},
        is_game_bot_sender=lambda _sid: False,
    )
    other_mention = enrich_filter_channels(
        base,
        RawMessageEvent(id="x4", chat_id=1, msg_id=4, text="@other 来看", source="玩家", date=""),
        {"own_aliases": ["wa2000"], "focus_keywords": [], "focus_include_player_plain": False},
        is_game_bot_sender=lambda _sid: False,
    )
    short_reply = enrich_filter_channels(
        base,
        RawMessageEvent(id="x5", chat_id=1, msg_id=5, text="1", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True, "focus_exclude_patterns": [r"^\d{1,2}$"]},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    own_command = enrich_filter_channels(
        base,
        RawMessageEvent(id="x6", chat_id=1, msg_id=6, text=".闯塔", source="我", date="", sender_id=123),
        {"archive_dot_commands": True, "focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    short_reply_without_exclude = enrich_filter_channels(
        base,
        RawMessageEvent(id="x7", chat_id=1, msg_id=7, text="1", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True, "focus_exclude_patterns": []},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    command_without_dot = enrich_filter_channels(
        base,
        RawMessageEvent(id="x8", chat_id=1, msg_id=8, text="洞天绘卷", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    resource_command_without_dot = enrich_filter_channels(
        base,
        RawMessageEvent(id="x8b", chat_id=1, msg_id=81, text="储物袋", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    keyword_command_without_dot = enrich_filter_channels(
        base,
        RawMessageEvent(id="x9", chat_id=1, msg_id=9, text="洞府", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True, "focus_keywords": ["洞府"]},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    command_without_dot_args = enrich_filter_channels(
        base,
        RawMessageEvent(id="x9b", chat_id=1, msg_id=91, text="上架 玄铁剑 换 灵石*8", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    muted_sender = enrich_filter_channels(
        base,
        RawMessageEvent(id="x10", chat_id=1, msg_id=10, text="今晚虚天殿有人吗", source="刷屏玩家", date="", sender_id=222),
        {
            "focus_include_player_plain": True,
            "focus_keywords": ["虚天殿"],
            "focus_muted_sender_ids": [222],
        },
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    muted_sender_mentions_me = enrich_filter_channels(
        base,
        RawMessageEvent(id="x11", chat_id=1, msg_id=11, text="@wa2000 来看虚天殿", source="刷屏玩家", date="", sender_id=222),
        {
            "own_aliases": ["wa2000"],
            "focus_include_player_plain": True,
            "focus_keywords": ["虚天殿"],
            "focus_muted_source_names": ["刷屏玩家"],
        },
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    keyword_blacklist = enrich_filter_channels(
        base,
        RawMessageEvent(id="x11b", chat_id=1, msg_id=111, text="坠魔谷护持还有人要吗", source="玩家", date="", sender_id=222),
        {
            "focus_include_player_plain": True,
            "focus_keywords": ["坠魔谷"],
            "focus_exclude_patterns": ["坠魔谷护持"],
        },
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    keyword_still_focus = enrich_filter_channels(
        base,
        RawMessageEvent(id="x11c", chat_id=1, msg_id=112, text="坠魔谷路线怎么走", source="玩家", date="", sender_id=222),
        {
            "focus_include_player_plain": True,
            "focus_keywords": ["坠魔谷"],
            "focus_exclude_patterns": ["坠魔谷护持"],
        },
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    punctuation_noise = enrich_filter_channels(
        base,
        RawMessageEvent(id="x12", chat_id=1, msg_id=12, text="？？", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    emoji_only = enrich_filter_channels(
        base,
        RawMessageEvent(id="x13", chat_id=1, msg_id=13, text="🔥", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    short_noise = enrich_filter_channels(
        base,
        RawMessageEvent(id="x14", chat_id=1, msg_id=14, text="ok", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    vague_reply = enrich_filter_channels(
        base,
        RawMessageEvent(id="x15", chat_id=1, msg_id=15, text="你看看", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    observed_low_signal = enrich_filter_channels(
        base,
        RawMessageEvent(id="x16", chat_id=1, msg_id=16, text="我看看", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    observed_placeholder = enrich_filter_channels(
        base,
        RawMessageEvent(id="x16b", chat_id=1, msg_id=161, text="路过", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    observed_short_ack = enrich_filter_channels(
        base,
        RawMessageEvent(id="x16c", chat_id=1, msg_id=162, text="明了", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    observed_single_word_ack = enrich_filter_channels(
        base,
        RawMessageEvent(id="x16d", chat_id=1, msg_id=163, text="知道", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    observed_go_noise = enrich_filter_channels(
        base,
        RawMessageEvent(id="x16e", chat_id=1, msg_id=164, text="冲冲冲", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    dungeon_choice_noise = enrich_filter_channels(
        base,
        RawMessageEvent(id="x17", chat_id=1, msg_id=17, text="稳", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    useful_plain_question = enrich_filter_channels(
        base,
        RawMessageEvent(id="x18", chat_id=1, msg_id=18, text="冲击元婴需要准备什么材料？", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True, "focus_keywords": []},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    keyword_question_with_short_word = enrich_filter_channels(
        base,
        RawMessageEvent(id="x19", chat_id=1, msg_id=19, text="坠魔心劫怎么选比较稳", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True, "focus_keywords": ["坠魔心劫"]},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    useful_route_discussion = enrich_filter_channels(
        base,
        RawMessageEvent(id="x20", chat_id=1, msg_id=20, text="刚刚路过虚天殿的时候看到队伍满了", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True, "focus_keywords": ["虚天殿"]},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )
    useful_coordination = enrich_filter_channels(
        base,
        RawMessageEvent(id="x21", chat_id=1, msg_id=21, text="这边好了", source="玩家", date="", sender_id=222),
        {"focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
        my_identity_ids=[123],
    )

    assert "focus" in plain.channels
    assert "archive" in command.channels
    assert "focus" not in command.channels
    assert "archive" in keyword_command.channels
    assert "focus" not in keyword_command.channels
    assert "focus" in mention.channels
    assert "focus" not in other_mention.channels
    assert "focus" not in short_reply.channels
    assert "archive" in short_reply.channels
    assert any(str(tag).startswith("重点排除:") for tag in short_reply.tags)
    assert "focus" not in own_command.channels
    assert "archive" in own_command.channels
    assert "mine" in own_command.channels
    assert "training" in own_command.channels
    assert "我发出" in own_command.tags
    assert "focus" in short_reply_without_exclude.channels
    assert "archive" in command_without_dot.channels
    assert "focus" not in command_without_dot.channels
    assert any(str(tag).startswith("重点排除:") for tag in command_without_dot.tags)
    assert "archive" in resource_command_without_dot.channels
    assert "focus" not in resource_command_without_dot.channels
    assert any(str(tag).startswith("重点排除:") for tag in resource_command_without_dot.tags)
    assert "archive" in keyword_command_without_dot.channels
    assert "focus" not in keyword_command_without_dot.channels
    assert any(str(tag).startswith("重点排除:") for tag in keyword_command_without_dot.tags)
    assert "archive" in command_without_dot_args.channels
    assert "focus" not in command_without_dot_args.channels
    assert "archive" in muted_sender.channels
    assert "focus" not in muted_sender.channels
    assert any(str(tag).startswith("重点静音:") for tag in muted_sender.tags)
    assert "focus" in muted_sender_mentions_me.channels
    assert "archive" not in muted_sender_mentions_me.channels
    assert "被@" in muted_sender_mentions_me.tags
    assert "archive" in keyword_blacklist.channels
    assert "focus" not in keyword_blacklist.channels
    assert any(str(tag).startswith("重点排除:") for tag in keyword_blacklist.tags)
    assert "focus" in keyword_still_focus.channels
    assert "archive" not in keyword_still_focus.channels
    assert "archive" in punctuation_noise.channels
    assert "focus" not in punctuation_noise.channels
    assert "archive" in emoji_only.channels
    assert "focus" not in emoji_only.channels
    assert "archive" in short_noise.channels
    assert "focus" not in short_noise.channels
    assert "archive" in vague_reply.channels
    assert "focus" not in vague_reply.channels
    assert "archive" in observed_low_signal.channels
    assert "focus" not in observed_low_signal.channels
    assert "archive" in observed_placeholder.channels
    assert "focus" not in observed_placeholder.channels
    assert "archive" in observed_short_ack.channels
    assert "focus" not in observed_short_ack.channels
    assert "archive" in observed_single_word_ack.channels
    assert "focus" not in observed_single_word_ack.channels
    assert "archive" in observed_go_noise.channels
    assert "focus" not in observed_go_noise.channels
    assert "archive" in dungeon_choice_noise.channels
    assert "focus" not in dungeon_choice_noise.channels
    assert "focus" in useful_plain_question.channels
    assert "archive" not in useful_plain_question.channels
    assert "focus" in keyword_question_with_short_word.channels
    assert "archive" not in keyword_question_with_short_word.channels
    assert "focus" in useful_route_discussion.channels
    assert "archive" not in useful_route_discussion.channels
    assert "focus" in useful_coordination.channels
    assert "archive" not in useful_coordination.channels


def test_message_filter_archives_observed_low_signal_without_hiding_coordination():
    base = ParsedCard(
        id="observed-short-plain",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="玩家",
        time="",
        tags=(),
        raw="",
    )

    def classify(text: str):
        return enrich_filter_channels(
            base,
            RawMessageEvent(
                id=f"obs-{text}",
                chat_id=1,
                msg_id=1000,
                text=text,
                source="玩家",
                date="",
                sender_id=222,
            ),
            {"focus_include_player_plain": True, "focus_keywords": []},
            is_game_bot_sender=lambda _sid: False,
            my_identity_ids=[123],
        )

    archived_texts = [
        "不好说",
        "家人们谁懂啊",
        "这事可太难办啦",
        "随机",
        "收到啦",
        "知道啦",
        "懂了懂了",
        "哦哦好",
        "牛的",
        "真敢说",
    ]
    kept_texts = [
        "来个助阵呗",
        "带带我",
        "蹭车",
        "怎么玩",
        "打不动",
        "职业不能重复",
        "解散吧",
        "我到了",
        "这边好了",
    ]

    for text in archived_texts:
        result = classify(text)
        assert "archive" in result.channels
        assert "focus" not in result.channels
    for text in kept_texts:
        result = classify(text)
        assert "focus" in result.channels
        assert "archive" not in result.channels


def test_message_filter_archives_commerce_and_empty_noise_without_hiding_discussion():
    base = ParsedCard(
        id="commerce-noise",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="玩家",
        time="",
        tags=(),
        raw="",
    )
    settings = {
        "focus_include_player_plain": True,
        "focus_keywords": [],
        "leader_sender_ids": [2049298748],
    }

    def classify(text: str, **event_patch):
        return enrich_filter_channels(
            base,
            RawMessageEvent(
                id=f"commerce-{len(text)}-{event_patch.get('msg_id', 1)}",
                chat_id=1,
                msg_id=int(event_patch.pop("msg_id", 1)),
                text=text,
                source=str(event_patch.pop("source", "玩家")),
                date="",
                sender_id=event_patch.pop("sender_id", 222),
                **event_patch,
            ),
            settings,
            is_game_bot_sender=lambda _sid: False,
            my_identity_ids=[123],
        )

    shop = classify(
        "🌟 乐上师的小店【LDC商城】\n"
        "━━━━━━━━━━━━━━━\n"
        "1. 天雷竹*1\n"
        "   └ 💰价格:1.50 | 📦库存:467\n"
        "📝 使用 .购入 <编号> [数量] 或 .购入 <编号>*<数量> 下单"
    )
    order = classify("✅ 订单已创建\n\n📋 订单号：ORD_1\n🛍 商品：养魂木*1")
    done = classify("🎉 交易完成啦！\n\n谢谢您的支持！东西已经发给你了。")
    plain_discussion = classify("LDC商城现在还有凝魂丹吗")
    empty_plain = classify("")
    empty_media = classify("", media_kind="photo")
    empty_leader = classify("", source="嬴驷", sender_id=2049298748)

    for result in (shop, order, done, empty_plain):
        assert "archive" in result.channels
        assert "focus" not in result.channels
    assert "商城目录归档" in shop.reasons
    assert "交易订单归档" in order.reasons
    assert "交易完成归档" in done.reasons
    assert "空白普通消息归档" in empty_plain.reasons

    for result in (plain_discussion, empty_media, empty_leader):
        assert "focus" in result.channels
        assert "archive" not in result.channels
    assert "leader" in empty_leader.channels


def test_message_filter_promotes_bot_reply_to_me_and_archives_reply_to_others():
    base = ParsedCard(
        id="reply",
        channels=("system",),
        title="系统消息",
        summary="",
        source="韩天尊",
        time="",
        tags=("未分类",),
        raw="",
    )
    settings = {"archive_bot_replies": False, "focus_keywords": []}
    bot_event = RawMessageEvent(
        id="r1", chat_id=1, msg_id=11, text="你已进入深度闭关状态。", source="韩天尊",
        date="", sender_id=-100, reply_to_msg_id=10,
    )
    mine = RawMessageEvent(id="p1", chat_id=1, msg_id=10, text=".深度闭关", source="me", date="", sender_id=12345)
    other = RawMessageEvent(id="p2", chat_id=1, msg_id=10, text=".深度闭关", source="other", date="", sender_id=67890)

    reply_to_me = enrich_filter_channels(
        base, bot_event, settings,
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=mine,
        my_identity_ids=[12345],
    )
    reply_to_other = enrich_filter_channels(
        base, bot_event, settings,
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=other,
        my_identity_ids=[12345],
    )
    reply_to_me_with_other_mentions = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="r1b", chat_id=1, msg_id=12,
            text="【宗门战况】\n战功榜: 1. @other 7444",
            source="韩天尊", date="", sender_id=-100, reply_to_msg_id=10,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=mine,
        my_identity_ids=[12345],
    )

    assert "focus" not in reply_to_me.channels
    assert "archive" in reply_to_me.channels
    assert "mine" in reply_to_me.channels
    assert "training" in reply_to_me.channels
    assert "回复我" in reply_to_me.tags
    assert "focus" not in reply_to_me_with_other_mentions.channels
    assert "mine" in reply_to_me_with_other_mentions.channels
    assert "archive" not in reply_to_me_with_other_mentions.channels
    assert "回复我" in reply_to_me_with_other_mentions.tags
    assert "提到别人" in reply_to_me_with_other_mentions.tags
    assert "archive" in reply_to_other.channels
    assert "focus" not in reply_to_other.channels
    assert "回复别人" in reply_to_other.tags


def test_message_filter_archives_action_prompt_for_other_player():
    base = ParsedCard(
        id="heart-other",
        channels=("system", "prompt", "home"),
        title="共历心劫",
        summary="bot 在等你 .稳(回复本消息)",
        source="韩天尊",
        time="",
        tags=("侍妾", "心劫"),
        raw="",
        actions=(ActionSuggestion("copy", "稳(回复)", ".稳"),),
    )
    parent = RawMessageEvent(
        id="p-heart", chat_id=1, msg_id=101, text=".共历心劫", source="other", date="", sender_id=67890
    )
    bot_event = RawMessageEvent(
        id="b-heart",
        chat_id=1,
        msg_id=102,
        text=(
            "【坠魔心劫·第2轮已定】\n"
            "你按韩立式谨慎节奏步步为营，侍妾神念与你渐趋同频。\n\n"
            "【坠魔心劫·第3轮】\n"
            "幻境再变，请继续回复 .稳 / .狠 / .骗。"
        ),
        source="韩天尊",
        date="",
        sender_id=-100,
        reply_to_msg_id=101,
    )

    result = enrich_filter_channels(
        base,
        bot_event,
        {"archive_bot_replies": False, "focus_keywords": []},
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=parent,
        my_identity_ids=[12345],
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "回复别人" in result.tags
    assert "有可操作按钮" in result.reasons


def test_message_filter_archives_bot_mentions_to_others():
    base = ParsedCard(
        id="mention-reply",
        channels=("system",),
        title="系统消息",
        summary="",
        source="韩天尊",
        time="",
        tags=("未分类",),
        raw="",
    )
    settings = {
        "archive_bot_replies": False,
        "focus_keywords": ["洞府"],
        "own_aliases": ["wa2000"],
    }
    other_mention = RawMessageEvent(
        id="r2", chat_id=1, msg_id=12, text="@other 的洞府", source="韩天尊",
        date="", sender_id=-100,
    )
    own_mention = RawMessageEvent(
        id="r3", chat_id=1, msg_id=13, text="@wa2000 的洞府", source="韩天尊",
        date="", sender_id=-100,
    )

    reply_to_other = enrich_filter_channels(
        base, other_mention, settings,
        is_game_bot_sender=lambda sid: sid == -100,
    )
    reply_to_me = enrich_filter_channels(
        base, own_mention, settings,
        is_game_bot_sender=lambda sid: sid == -100,
    )

    assert "archive" in reply_to_other.channels
    assert "focus" not in reply_to_other.channels
    assert "提到别人" in reply_to_other.tags
    assert "focus" in reply_to_me.channels
    assert "archive" not in reply_to_me.channels


def test_message_filter_keeps_dungeon_bot_mentions_in_focus():
    base = ParsedCard(
        id="dungeon-mention",
        channels=("system", "dungeon"),
        title="虚天殿开启",
        summary="",
        source="韩天尊",
        time="",
        tags=("副本",),
        raw="",
    )
    settings = {
        "archive_bot_replies": True,
        "focus_keywords": [],
        "own_aliases": ["wa2000"],
    }

    result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="d1",
            chat_id=1,
            msg_id=21,
            text="【虚天殿已开启】 @other 开启了传送门！副本ID: 809",
            source="韩天尊",
            date="",
            sender_id=-100,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == -100,
    )

    assert "focus" in result.channels
    assert "archive" not in result.channels
    assert "提到别人" in result.tags
    assert "副本消息" in result.reasons


def test_message_filter_archives_blood_trial_dungeon_messages():
    base = ParsedCard(
        id="blood-trial",
        channels=("system", "dungeon", "resource"),
        title="血色试炼集结",
        summary="",
        source="韩天尊",
        time="",
        tags=("副本",),
        raw="",
    )

    result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="bt1",
            chat_id=1,
            msg_id=22,
            text="【血色试炼·集结】 @MayaLing 正在召集同伴，准备进入【血色禁地】采药试炼！房间ID: 520",
            source="韩天尊",
            date="",
            sender_id=-100,
        ),
        {"archive_bot_replies": False, "focus_keywords": ["血色试炼", "副本ID"]},
        is_game_bot_sender=lambda sid: sid == -100,
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "dungeon" in result.channels
    assert "血色禁地归档" in result.reasons


def test_message_filter_archives_xutian_back_hall_stop_message():
    base = ParsedCard(
        id="xutian-back-hall-stop",
        channels=("system", "dungeon"),
        title="后殿冲关止步",
        summary="",
        source="韩天尊",
        time="",
        tags=("副本",),
        raw="",
    )

    result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="xh1",
            chat_id=1,
            msg_id=23,
            text=(
                "【后殿冲关止步】\n"
                "回合耗尽，鼎灵残焰仍未被真正压灭。\n"
                "好在第三关结算所得早已锁定，这次失去的只有后殿追加机缘。"
            ),
            source="韩天尊",
            date="",
            sender_id=-100,
        ),
        {"archive_bot_replies": False, "focus_keywords": ["虚天殿", "后殿冲关止步"]},
        is_game_bot_sender=lambda sid: sid == -100,
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "dungeon" in result.channels
    assert "虚天殿后殿止步归档" in result.reasons


def test_message_filter_archives_unconfigured_tianzun_heart_demon_result():
    base = ParsedCard(
        id="heart-demon-result",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="韩天尊",
        time="",
        tags=("未分类",),
        raw="",
    )

    result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="hm1",
            chat_id=1,
            msg_id=24,
            text=(
                "【坠魔心劫·结算】\n"
                "三轮抉择：稳 / 稳 / 稳\n"
                "你以守代攻，借势封魔，终在险境中稳稳落子。\n\n"
                "修为结算：+659\n"
                "情缘结算：+7\n"
                "心魔值结算：-5（当前 0）"
            ),
            source="韩天尊",
            date="",
            sender_id=8567800706,
        ),
        {"archive_bot_replies": False, "focus_include_player_plain": True, "focus_keywords": ["心魔"]},
        is_game_bot_sender=lambda _sid: False,
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "坠魔心劫归档" in result.reasons


def test_message_filter_keeps_player_heart_demon_discussion_in_focus():
    base = ParsedCard(
        id="heart-demon-player",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="玩家",
        time="",
        tags=("未分类",),
        raw="",
    )

    result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="hm2",
            chat_id=1,
            msg_id=25,
            text="坠魔心劫这个怎么选比较稳",
            source="玩家",
            date="",
            sender_id=222,
        ),
        {"archive_bot_replies": False, "focus_include_player_plain": True, "focus_keywords": ["坠魔心劫"]},
        is_game_bot_sender=lambda _sid: False,
    )

    assert "focus" in result.channels
    assert "archive" not in result.channels


def test_message_filter_archives_unconfigured_tianzun_short_reply():
    base = ParsedCard(
        id="tianzun-short-reply",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="韩天尊",
        time="",
        tags=("未分类",),
        raw="",
    )

    result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz-short",
            chat_id=1,
            msg_id=26,
            text="你的观星台上没有需要安抚的星辰。",
            source="韩天尊",
            date="",
            sender_id=8400307678,
            reply_to_msg_id=25,
        ),
        {"archive_bot_replies": True, "focus_include_player_plain": True, "focus_keywords": []},
        is_game_bot_sender=lambda _sid: False,
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "普通天尊回复归档" in result.reasons


def test_message_filter_promotes_plain_tianzun_speech_to_leader():
    base = ParsedCard(
        id="tianzun-plain",
        channels=("system",),
        title="系统消息",
        summary="",
        source="韩天尊",
        time="",
        tags=("未分类",),
        raw="",
    )
    settings = {
        "archive_bot_replies": True,
        "focus_keywords": [],
        "leader_sender_ids": [2049298748],
        "leader_source_names": ["@iosdo7", "韩天尊"],
    }

    plain = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz1",
            chat_id=1,
            msg_id=31,
            text="今晚先别开虚天殿，等我看一下新机制",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    gameplay_note = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz1-note",
            chat_id=1,
            msg_id=41,
            text=(
                "每轮重生固定生成三条命途：稳妥之身、承脉之身、赌命之身。\n"
                "灵根由代码按前世因果生成，不再交给 AI 随机乱抽。\n"
                "权重会参考前世灵根、境界/总修为、击杀数带来的业力、五行淬体、第二元神等信息。\n"
                "同一轮仍然只锁一组结果，不能反复 .夺舍重生 刷词条。\n"
                "展示里增加了 命途 和 批命，能看懂三条路分别在赌什么。"
            ),
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    titled_system_notice = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz1-title",
            chat_id=1,
            msg_id=42,
            text="【天机异闻·夺舍重生】\n天道轮回，命途已定。",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    short_mention_result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz1-short-mention",
            chat_id=1,
            msg_id=421,
            text="@Do 已做出抉择，极阴祖师的神念开始对其进行审视...",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    source_spoof_plain = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz2",
            chat_id=1,
            msg_id=32,
            text="今晚先别开虚天殿，等我看一下新机制",
            source="韩天尊",
            date="",
            sender_id=8272757053,
        ),
        settings,
        is_game_bot_sender=lambda _sid: False,
    )
    configured_leader = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="leader1",
            chat_id=1,
            msg_id=35,
            text="坠魔谷这个先别急，等新机制说明",
            source="@iosdo7",
            date="",
            sender_id=2049298748,
        ),
        settings,
        is_game_bot_sender=lambda _sid: False,
    )
    configured_leader_reply = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="leader1-reply",
            chat_id=1,
            msg_id=36,
            text="这个机制先按我刚才说的来",
            source="嬴驷",
            date="",
            sender_id=2049298748,
            reply_to_msg_id=35,
        ),
        settings,
        is_game_bot_sender=lambda _sid: False,
        parent_event=RawMessageEvent(
            id="leader-parent",
            chat_id=1,
            msg_id=35,
            text="前面那条机制说明",
            source="普通玩家",
            date="",
            sender_id=111,
        ),
    )
    configured_leader_media = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="leader1-media",
            chat_id=1,
            msg_id=49,
            text="",
            source="嬴驷",
            date="",
            sender_id=2049298748,
            media_kind="photo",
        ),
        settings,
        is_game_bot_sender=lambda _sid: False,
    )
    configured_leader_command = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="leader1-cmd",
            chat_id=1,
            msg_id=38,
            text=".admin unreport",
            source="@iosdo7",
            date="",
            sender_id=2049298748,
        ),
        settings,
        is_game_bot_sender=lambda _sid: False,
    )
    source_name_only = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="leader2",
            chat_id=1,
            msg_id=36,
            text="我是会长昵称但不是会长 ID",
            source="@iosdo7",
            date="",
            sender_id=111,
        ),
        settings,
        is_game_bot_sender=lambda _sid: False,
    )
    formatted = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz3",
            chat_id=1,
            msg_id=33,
            text="牵引成功！\n你消耗了 640 点修为，成功在 8 号引星盘上牵引了【庚金星】之力！",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    command_reply = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz4",
            chat_id=1,
            msg_id=34,
            text="你并未处于深度闭关之中。",
            source="韩天尊",
            date="",
            sender_id=7900199668,
            reply_to_msg_id=30,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
        parent_event=RawMessageEvent(
            id="parent",
            chat_id=1,
            msg_id=30,
            text="查看闭关",
            source="玩家",
            date="",
            sender_id=123,
        ),
    )
    missing_parent_reply = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz5",
            chat_id=1,
            msg_id=37,
            text="这条是回复链，父消息没查到也不要进会长频道",
            source="韩天尊",
            date="",
            sender_id=7900199668,
            reply_to_msg_id=99,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
        clean_reply_to_msg_id=99,
    )
    bot_result_plainish = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz6",
            chat_id=1,
            msg_id=39,
            text="你感觉到与青竹蜂云剑（神雷版）的联系更加紧密了，器灵传来了喜悦的情绪。\n(默契 +3, 经验 +19)",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    delayed_settlement_result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz7",
            chat_id=1,
            msg_id=40,
            text="你心念一动，丹田中的元婴化作一道流光飞出，消失在天际。\n它将在外云游 8 小时，为你寻觅天地奇珍。下一次发言时若已归来，将自动结算收获。",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    italic_flavor_text = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz8",
            chat_id=1,
            msg_id=43,
            text="*灵气微弱，元婴震颤，帖子？怎能填我空虚之渴……*",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    heart_trial_anchor_result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz9",
            chat_id=1,
            msg_id=44,
            text="心劫锚点已散，需重新引动天劫。",
            source="韩天尊",
            date="",
            sender_id=8757550896,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 8757550896,
    )
    hexagram_result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz10",
            chat_id=1,
            msg_id=45,
            text="卦象验阵：大顺\n卦门灵机已随你们的选择暗中流转，吉凶不会在此刻直示，只能靠破阵结果见分晓。",
            source="韩天尊",
            date="",
            sender_id=8388633812,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 8388633812,
    )
    treasure_notice = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz11",
            chat_id=1,
            msg_id=46,
            text="🌌 天机剧变，重宝降世！",
            source="韩天尊",
            date="",
            sender_id=8388633812,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 8388633812,
    )
    concubine_threshold_result = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz12",
            chat_id=1,
            msg_id=47,
            text="你与侍妾情缘未至，至少需 300 情缘方可代卜天机。",
            source="韩天尊",
            date="",
            sender_id=7900199668,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 7900199668,
    )
    economy_chart_notice = enrich_filter_channels(
        base,
        RawMessageEvent(
            id="tz13",
            chat_id=1,
            msg_id=48,
            text="📊 天道综合指数 (TDI) 走势图\n_反映修仙界整体经济荣枯_",
            source="韩天尊",
            date="",
            sender_id=8388633812,
        ),
        settings,
        is_game_bot_sender=lambda sid: sid == 8388633812,
    )

    assert "leader" in plain.channels
    assert "focus" in plain.channels
    assert "archive" not in plain.channels
    assert "会长上号" in plain.tags
    assert "leader" in gameplay_note.channels
    assert "会长上号" in gameplay_note.tags
    assert "leader" not in titled_system_notice.channels
    assert "leader" not in short_mention_result.channels
    assert "focus" not in short_mention_result.channels
    assert "archive" in short_mention_result.channels
    assert "leader" not in source_spoof_plain.channels
    assert "会长上号" not in source_spoof_plain.tags
    assert "leader" in configured_leader.channels
    assert "本人上号" in configured_leader.tags
    assert "leader" in configured_leader_reply.channels
    assert "focus" in configured_leader_reply.channels
    assert "本人上号" in configured_leader_reply.tags
    assert "leader" in configured_leader_media.channels
    assert "本人上号" in configured_leader_media.tags
    assert "leader" not in configured_leader_command.channels
    assert "archive" in configured_leader_command.channels
    assert "leader" not in source_name_only.channels
    assert "leader" not in formatted.channels
    assert "archive" in formatted.channels
    assert "leader" not in command_reply.channels
    assert "archive" in command_reply.channels
    assert "leader" not in missing_parent_reply.channels
    assert "leader" not in bot_result_plainish.channels
    assert "leader" not in delayed_settlement_result.channels
    assert "leader" not in italic_flavor_text.channels
    assert "leader" not in heart_trial_anchor_result.channels
    assert "leader" not in hexagram_result.channels
    assert "leader" not in treasure_notice.channels
    assert "leader" not in concubine_threshold_result.channels
    assert "leader" not in economy_chart_notice.channels


def test_server_payload_shape_stays_compatible():
    server = MiniWebServer(store=SampleStore())
    payload = server.messages_payload("all")
    assert payload["messages"]
    assert {"id", "channel", "title", "summary", "actions"} <= set(payload["messages"][0])


def test_messages_payload_supports_multi_channel_sample_store():
    server = MiniWebServer(store=SampleStore())

    payload = server.messages_payload("all", channels=["dungeon,risk"])

    assert payload["channels"] == ["dungeon", "risk"]
    titles = {message["title"] for message in payload["messages"]}
    assert "虚天殿开启" in titles
    assert titles & {"风险提醒", "天道审判"}
    assert all({"dungeon", "risk"}.intersection(message.get("channels") or [message["channel"]]) for message in payload["messages"])


def test_action_suggestions_keep_reply_context():
    dungeon = [card.to_api() for card in SampleStore().list_cards("dungeon")][0]
    action = dungeon["actions"][0]

    assert action["command"] == ".加入副本 394"
    assert action["chat_id"] == 0
    assert action["reply_to_msg_id"] == 2
    assert action["send_mode"] == "copy"


def test_outbox_declares_context_but_no_direct_send():
    payload = MiniWebServer(store=SampleStore()).outbox_payload()

    assert payload["capabilities"]["reply_context"] is True
    assert payload["capabilities"]["manual_api_reply"] is True
    assert payload["capabilities"]["direct_send"] is False


def test_sqlite_store_persists_cards(tmp_path):
    db_path = tmp_path / "miniweb.db"
    store = SQLiteStore(db_path)
    seed_sqlite_samples(store)

    first = store.list_cards("risk")
    second = SQLiteStore(db_path).list_cards("risk")

    assert len(first) == 1
    assert len(second) == 1
    # 天道审判 + 自证 提示同时落到 risk 频道(severity=risk);
    # 老 RiskParser 也会匹配但优先级在 prompt 后面,这里取 Tiandao prompt 卡。
    assert second[0].title in {"风险提醒", "天道审判"}
    assert second[0].severity == "risk"


def test_sqlite_store_persists_state_patches(tmp_path):
    db_path = tmp_path / "miniweb.db"
    store = SQLiteStore(db_path)
    seed_sqlite_samples(store)

    patches = SQLiteStore(db_path).list_state_patches("identity_profile")

    values = {(item["scope"], item["key"]): item["value"] for item in patches}
    assert values[("identity_profile", "灵根")] == "天灵根(火)"
    assert values[("identity_profile", "综合战力")] == "333.8万"


def test_sqlite_store_backfills_state_patches_for_existing_raw_messages(tmp_path):
    db_path = tmp_path / "miniweb.db"
    store = SQLiteStore(db_path)
    source = next(event for event in SAMPLE_EVENTS if event.id == "sample-4")
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:4004",
            chat_id=-1,
            msg_id=4004,
            text=source.text,
            source=source.source,
            date="2026-05-15T00:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    with store._connect() as conn:
        conn.execute("DELETE FROM state_patches")

    rebuilt = SQLiteStore(db_path)
    rebuilt.seed_samples_if_empty()
    patches = rebuilt.list_state_patches("identity_profile")

    assert patches
    assert any(item["key"] == "灵根" and item["value"] == "天灵根(火)" for item in patches)


def test_state_patches_api_shape(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    seed_sqlite_samples(store)
    payload = MiniWebServer(store=store).state_patches_payload("identity_profile")

    assert payload["ok"] is True
    assert payload["state"]
    assert {"scope", "key", "value", "source_message_id", "updated_at"} <= set(payload["state"][0])


def test_sqlite_settings_roundtrip(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    assert 7900199668 in store.get_settings()["game_bot_ids"]
    assert -1002049298748 in store.get_settings()["leader_sender_ids"]
    assert "@iosdo7" in store.get_settings()["leader_source_names"]
    assert store.get_settings()["focus_include_player_plain"] is True

    saved = store.save_settings(
        {
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
            "game_bot_ids": ["7900199668", "bad", "8757550896"],
            "listen_enabled": True,
        }
    )

    assert saved["api_id"] == "123"
    assert saved["target_chat"] == "-1001"
    assert saved["game_bot_ids"] == [7900199668, 8757550896]
    assert -1002049298748 in saved["leader_sender_ids"]
    assert "@iosdo7" in saved["leader_source_names"]
    assert SQLiteStore(tmp_path / "miniweb.db").get_settings()["listen_enabled"] is True


def test_focus_exclude_patterns_preserve_regex_commas(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    saved = store.save_settings({"focus_exclude_patterns": r"^\d{1,2}$"})

    assert r"^\d{1,2}$" in saved["focus_exclude_patterns"]
    assert r"^\d{1" not in saved["focus_exclude_patterns"]
    assert "2}$" not in saved["focus_exclude_patterns"]


def test_focus_exclude_patterns_prune_legacy_defaults(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    legacy_short_noise = r"^(嗯+|哦+|噢+|好+|好的|行吧?|对|是|收到|收到了|来了|回来了|晚安|谢谢|谢谢老板)$"
    legacy_extended_noise = r"^(a+|o+|嗯+|哦+|噢+|喵+|哈+|哈哈+|哇+|呜+|额+|呃+|好+|好的|好的呢|好吧|行吧?|对|是|是的|收到|收到了|来了|来了来了|回来了|晚安|谢谢|谢谢老板|等下|稍等|明白|知道了|没问题|可以|冒泡|打卡|起来了|欸行|你好|早安|差不多|差不多了|得嘞|妥了|好嘞|在呢|在吗|嘿嘿|呵呵|了解|okk|619|555|拉屎好爽)$"
    legacy_observed_default = r"^(a+|o+|ok+|okay|OK+|Ok+|6+|嗯+|哦+|噢+|喵+|哈+|哈哈+|哇+|呜+|额+|呃+|好+|好的|好的呢|好吧|行吧?|对|是|是的|收到|收到了|来了|来了来了|回来了|晚安|谢谢|谢谢老板|等下|稍等|明白|知道了|没问题|可以|冒泡|打卡|起来了|欸行|你好|早安|差不多|差不多了|得嘞|妥了|好嘞|在呢|在吗|嘿嘿|呵呵|了解|草|笑死|乐|泪目|绷|牛|牛逼|nb|NB|nice|看看|你看看|看下|看一下|直觉|随便|都行|可以吧|619|555|拉屎好爽)$"
    legacy_low_signal = r"^(q|Q|稳|狠|骗|信对了|我看看|氪金吧|好贵|太贵了|可以的|啊+|嗯好|嗯嗯|哦哦|对啊|是啊|不是吧|离谱)$"
    legacy_routine = r"^(查看闭关|宗门点卯|宗门悬赏|宗门战况|天机代卜|闯塔|我的侍妾|查看侍妾|我的货摊|我的宗门|宗门宝库|每日问安|万宝楼|洞府|战力|状态|观星台|观星|助阵|启阵|出关|归来|强行出关|深度闭关|闭关修炼|闭关结束|登天阶|元婴状态|元婴出窍|元婴归窍|冲击元婴|第二元神|安抚星辰|入梦寻图|黄粱一梦|共历心劫|野外历练|斩妖除魔|小药园|洞天绘卷|宗门传功|我的灵根|收集精华|解散副本)$"
    saved = store.save_settings({
        "focus_exclude_patterns": [
            legacy_short_noise,
            legacy_extended_noise,
            legacy_observed_default,
            legacy_low_signal,
            legacy_routine,
            "第二期机缘",
        ],
    })

    assert legacy_short_noise not in saved["focus_exclude_patterns"]
    assert legacy_extended_noise not in saved["focus_exclude_patterns"]
    assert legacy_observed_default not in saved["focus_exclude_patterns"]
    assert legacy_low_signal not in saved["focus_exclude_patterns"]
    assert legacy_routine not in saved["focus_exclude_patterns"]
    assert "第二期机缘" in saved["focus_exclude_patterns"]
    assert any("拉屎好爽" in item for item in saved["focus_exclude_patterns"])
    assert any("路过" in item for item in saved["focus_exclude_patterns"])
    assert any("储物袋" in item for item in saved["focus_exclude_patterns"])


def test_focus_muted_senders_roundtrip(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    saved = store.save_settings({
        "focus_muted_sender_ids": "222\n333",
        "focus_muted_source_names": "刷屏玩家\n路人甲",
    })

    assert saved["focus_muted_sender_ids"] == [222, 333]
    assert saved["focus_muted_source_names"] == ["刷屏玩家", "路人甲"]


def test_focus_exclude_preview_only_counts_unprotected_plain_focus(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"focus_include_player_plain": True})
    store.save_identity({"send_as_id": 123, "label": "me"})
    now = utc_now_iso()
    store.ingest_event(RawMessageEvent(id="plain", chat_id=1, msg_id=1, text="是这样", source="玩家", date=now, sender_id=222))
    store.ingest_event(RawMessageEvent(id="mine", chat_id=1, msg_id=2, text="是这样", source="我", date=now, sender_id=123))
    store.ingest_event(RawMessageEvent(id="bot", chat_id=1, msg_id=3, text="是这样", source="韩天尊", date=now, sender_id=7900199668))

    preview = MiniWebServer(store=store).focus_exclude_preview_payload({"mode": "exact", "text": "是这样"})

    assert preview["ok"] is True
    assert preview["pattern"] == "^是这样$"
    assert preview["total"] == 2
    assert preview["last_24h"] == 2
    assert {sample["sender_id"] for sample in preview["samples"]} == {123, 222}


def test_settings_auto_collects_own_usernames(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account(
        {
            "local_id": "main",
            "account_id": "12345",
            "username": "@wa2000",
        }
    )
    store.save_identity(
        {
            "send_as_id": "67890",
            "account_local_id": "main",
            "username": "alt_wa",
        }
    )

    aliases = store.get_settings()["own_aliases"]
    assert "wa2000" in aliases
    assert "alt_wa" in aliases


def test_settings_payload_redacts_saved_secrets(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"api_hash": "secret-hash", "proxy_password": "proxy-secret"})
    server = MiniWebServer(store=store)

    payload = server.settings_payload()

    assert payload["settings"]["api_hash"] == ""
    assert payload["settings"]["proxy_password"] == ""
    # 所有标记为 secret 的 key 都必须出现在 saved_secrets 里(True 表示已保存)
    assert payload["settings"]["saved_secrets"]["api_hash"] is True
    assert payload["settings"]["saved_secrets"]["proxy_password"] is True
    assert payload["settings"]["saved_secrets"]["notify_tg_bot_token"] is False
    assert "secret-hash" not in str(payload)
    assert "proxy-secret" not in str(payload)


def test_blank_secret_save_preserves_existing_secret(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"api_hash": "secret-hash", "proxy_password": "proxy-secret"})
    server = MiniWebServer(store=store)

    payload = server.save_settings_payload({"api_hash": "", "proxy_password": "", "api_id": "456"})

    assert payload["settings"]["api_hash"] == ""
    assert payload["settings"]["proxy_password"] == ""
    saved = store.get_settings()
    assert saved["api_id"] == "456"
    assert saved["api_hash"] == "secret-hash"
    assert saved["proxy_password"] == "proxy-secret"


def test_account_save_redacts_and_preserves_existing_secret(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)

    created = server.save_account_payload(
        {
            "phone": "+8613800138000",
            "api_id": "123",
            "api_hash": "secret-hash",
            "proxy_password": "proxy-secret",
        }
    )
    local_id = created["account"]["local_id"]
    updated = server.save_account_payload(
        {
            "local_id": local_id,
            "label": "主号",
            "api_hash": "",
            "proxy_password": "",
        }
    )

    assert created["account"]["api_hash"] == ""
    assert updated["account"]["saved_secrets"]["api_hash"] is True
    assert updated["account"]["saved_secrets"]["proxy_password"] is True
    saved = store.get_account(local_id)
    assert saved["label"] == "主号"
    assert saved["api_hash"] == "secret-hash"
    assert saved["proxy_password"] == "proxy-secret"


def test_account_limit_uses_normalized_identity(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "MAX_ACCOUNTS", 1)
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    server.save_account_payload({"phone": "+8613800138000", "api_id": "123", "api_hash": "hash"})
    server.save_account_payload({"phone": "+8613800138000", "label": "同一个账号更新"})

    try:
        server.save_account_payload({"phone": "+8613800138001", "api_id": "124", "api_hash": "hash2"})
    except ValueError as exc:
        assert "账号数量已达上限 1 个" in str(exc)
    else:
        raise AssertionError("second normalized account should exceed account limit")


def test_message_box_uses_single_collector_from_account_pool(tmp_path):
    class FakeListenerManager:
        def __init__(self) -> None:
            self.started = []

        def status(self, local_id=None):
            if local_id:
                return {"status": "stopped", "message": ""}
            return {"max_listeners": 1, "collector": "", "running": {}}

        def start(self, local_id, settings):
            self.started.append((local_id, settings["label"]))
            return {"status": "starting", "message": "fake collector starting"}

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    fake = FakeListenerManager()
    server._listeners = fake

    server.save_account_payload(
        {
            "local_id": "backup",
            "label": "备用",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "backup",
            "target_chat": "-1001",
            "collector_priority": 20,
            "login_status": "done",
        }
    )
    server.save_account_payload(
        {
            "local_id": "primary",
            "label": "主采集",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "primary",
            "target_chat": "-1001",
            "collector_priority": 0,
            "login_status": "done",
        }
    )

    payload = server.accounts_payload()

    assert payload["max_listeners"] == 1
    assert fake.started == [("primary", "主采集")]


def test_collector_skips_account_pending_login(tmp_path):
    """对照 mini-web 已修的 bug:登录中(waiting_code/need_2fa)的账号
    不能被自动启 listener,否则 listener 的 client 会跟 login 抢 session,
    Telethon 跨 loop 错误 + 登录流程被打断。"""
    class FakeListenerManager:
        def __init__(self):
            self.started = []

        def status(self, local_id=None):
            if local_id:
                return {"status": "stopped", "message": ""}
            return {"max_listeners": 1, "collector": "", "running": {}}

        def start(self, local_id, settings):
            self.started.append(local_id)
            return {"status": "starting", "message": "fake"}

        def stop(self, local_id):
            return {"status": "stopped", "message": "fake stopped"}

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    fake = FakeListenerManager()
    server._listeners = fake

    server.save_account_payload(
        {
            "local_id": "pending",
            "label": "登录中",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "pending",
            "target_chat": "-1001",
            "login_status": "waiting_code",
        }
    )

    server.accounts_payload()

    assert fake.started == [], "登录中的账号不该被自动启 listener"


def test_listener_status_reports_active_collector(tmp_path):
    class FakeListenerManager:
        def status(self, local_id=None):
            if local_id == "primary":
                return {"status": "running", "message": "采集中"}
            if local_id:
                return {"status": "stopped", "message": ""}
            return {
                "max_listeners": 1,
                "collector": "primary",
                "running": {"primary": {"status": "running", "message": "采集中"}},
            }

        def stop(self, local_id):
            return {"status": "stopped", "message": "fake stop"}

    store = SQLiteStore(tmp_path / "miniweb.db")
    # 建好 primary 账号 + 标记登录态,这样 _ensure_collector_running
    # 不会因为没账号或没登录就把它停掉。
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "primary",
            "label": "主采集",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "primary",
            "target_chat": "-1001",
            "login_status": "done",
        }
    )
    server._listeners = FakeListenerManager()

    payload = server.listener_status_payload()

    assert payload["listener"] == {"status": "running", "message": "采集中"}
    assert payload["listeners"]["collector"] == "primary"


def test_raw_message_id_is_canonical_across_collector_accounts():
    class Message:
        id = 123
        message = "hello"
        date = None
        reply_to_msg_id = None
        reply_to = None

    class Event:
        message = Message()
        sender_id = 7900199668
        chat_id = -1001

    first = _raw_event_from_telethon(Event(), account_key="account_a")
    second = _raw_event_from_telethon(Event(), account_key="account_b")

    assert first.id == "tg:-1001:123"
    assert first.id == second.id


def test_raw_event_uses_cached_sender_name_when_available():
    class Sender:
        first_name = "韩"
        last_name = "天尊"
        username = "han_tianzun"
        bot = True
        title = None

    class Message:
        id = 9
        message = "广播"
        date = None
        reply_to_msg_id = None
        reply_to = None
        sender = Sender()

    class Event:
        message = Message()
        sender_id = 7900199668
        chat_id = -1001
        sender = Sender()

    event = _raw_event_from_telethon(Event(), account_key="primary")

    assert event.source == "韩 天尊"
    assert event.sender_is_bot is True


def test_raw_event_falls_back_to_sender_id_when_sender_missing():
    class Message:
        id = 10
        message = ""
        date = None
        reply_to_msg_id = None
        reply_to = None

    class Event:
        message = Message()
        sender_id = 8757550896
        chat_id = -1002

    event = _raw_event_from_telethon(Event())

    assert event.source == "8757550896"
    assert event.sender_is_bot is False


def test_raw_event_preserves_custom_emoji_entities():
    class MessageEntityCustomEmoji:
        offset = 2
        length = 2
        document_id = 1234567890123456789

    class Sender:
        first_name = "表情道人"
        last_name = ""
        username = "emoji_dao"
        bot = False
        title = None

    class Message:
        id = 11
        message = "道友🔥"
        entities = [MessageEntityCustomEmoji()]
        date = None
        reply_to_msg_id = None
        reply_to = None
        sender = Sender()

    class Event:
        message = Message()
        sender_id = 8757550896
        chat_id = -1002
        sender = Sender()

    event = _raw_event_from_telethon(Event())

    assert event.text == "道友🔥"
    assert event.media_meta["text_entities"] == [
        {
            "type": "custom_emoji",
            "offset": 2,
            "length": 2,
            "document_id": "1234567890123456789",
        }
    ]


def test_format_sender_display_uses_channel_title():
    class Channel:
        title = "凌霄宫公告"

    assert _format_sender_display(Channel()) == "凌霄宫公告"


def test_format_sender_display_falls_back_to_username():
    class User:
        first_name = ""
        last_name = ""
        username = "wa2000"
        title = None

    assert _format_sender_display(User()) == "@wa2000"


def test_identities_are_separate_from_telegram_accounts(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)

    account = server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "phone": "+100"}
    )["account"]
    identity = server.save_identity_payload(
        {
            "send_as_id": "8659059191",
            "account_local_id": "main",
            "label": "WA2000",
            "daohao": "清源子",
            "realm": "化神",
            "sect_name": "凌霄宫",
        }
    )["identity"]
    payload = server.identities_payload()

    assert account["local_id"] == "main"
    assert identity["send_as_id"] == 8659059191
    assert identity["account_local_id"] == "main"
    assert payload["identities"][0]["account"]["local_id"] == "main"


def test_identity_allows_channel_send_as_id(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})

    identity = server.save_identity_payload({"send_as_id": "-1001234567890", "account_local_id": "main"})["identity"]

    assert identity["send_as_id"] == -1001234567890


def test_identity_binding_requires_existing_account(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    try:
        server.save_identity_payload({"send_as_id": "12345", "account_local_id": "missing"})
    except ValueError as exc:
        assert "绑定账号不存在" in str(exc)
    else:
        raise AssertionError("identity should not bind to a missing account")


def test_identity_payload_drops_legacy_profile_fields(tmp_path):
    """identities 表的 profile 类字段(道号 / 境界 / 宗门 / 灵根 / 战力)
    由消息箱解析自动写入,不应该出现在用户手填表单上。
    mini-web 不挂机不解析这些字段,因此直接从身份模型移除,角色面板走 state_patches。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})

    saved = server.save_identity_payload(
        {
            "send_as_id": "12345",
            "account_local_id": "main",
            "label": "WA2000",
            "daohao": "清源子",
            "realm": "化神",
            "sect_name": "凌霄宫",
        }
    )["identity"]

    assert "daohao" not in saved
    assert "realm" not in saved
    assert "sect_name" not in saved
    assert saved["label"] == "WA2000"


def test_identities_payload_classifies_self_and_channel_kinds(tmp_path):
    """UI 友好分类:
    send_as_id == 已登录账号 account_id => self;负数 => channel;
    其它正数 => self_unbound(预登记或 account_id 未拿到)。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "7900199668"}
    )
    server.save_identity_payload(
        {"send_as_id": "7900199668", "account_local_id": "main", "label": "self"}
    )
    server.save_identity_payload(
        {"send_as_id": "-1001234567890", "account_local_id": "main", "label": "channel"}
    )
    server.save_identity_payload(
        {"send_as_id": "9999", "account_local_id": "main", "label": "stranger"}
    )

    by_label = {item["label"]: item for item in server.identities_payload()["identities"]}

    assert by_label["self"]["kind"] == "self"
    assert by_label["channel"]["kind"] == "channel"
    assert by_label["stranger"]["kind"] == "self_unbound"


def test_account_login_done_upserts_self_identity(tmp_path):
    """account 一登录成功(account_id 已知),系统就把 identity_id == account_id 的
    self-identity upsert 进库,跳过手动建身份这一步。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    account = server.save_account_payload(
        {"local_id": "main", "account_id": "7900199668"}
    )["account"]

    server._ensure_self_identity(account)

    payload = server.identities_payload()
    self_identities = [item for item in payload["identities"] if item["kind"] == "self"]
    assert len(self_identities) == 1
    assert self_identities[0]["send_as_id"] == 7900199668
    assert self_identities[0]["account_local_id"] == "main"


def test_account_login_self_identity_is_idempotent(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    account = server.save_account_payload(
        {"local_id": "main", "account_id": "7900199668"}
    )["account"]

    server._ensure_self_identity(account)
    server._ensure_self_identity(account)

    payload = server.identities_payload()
    assert len([item for item in payload["identities"] if item["kind"] == "self"]) == 1


def test_planner_synthesizes_self_identity_when_action_matches_account_id(tmp_path):
    """action.identity_id == account.account_id 即「以自己身份发」,即使 identities
    表里没这条,plan 也应该 resolved=True,自动按 self-identity 处理。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "api_id": "123",
            "api_hash": "hash",
            "account_id": "7900199668",
            "target_chat": "-1001234567890",
        }
    )
    planner = OutboxPlanner(store)

    plan = planner.plan(
        {
            "action": {
                "type": "copy",
                "label": "签到",
                "command": ".签到",
                "identity_id": 7900199668,
                "account_local_id": "main",
            }
        }
    )

    assert plan.resolved
    assert plan.identity is not None
    assert plan.identity.get("synthesized") is True
    assert plan.identity["send_as_id"] == 7900199668


def test_planner_marks_identity_missing_when_unknown(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "api_id": "123",
            "api_hash": "hash",
            "account_id": "7900199668",
            "target_chat": "-1001234567890",
        }
    )
    planner = OutboxPlanner(store)

    plan = planner.plan(
        {
            "action": {
                "type": "copy",
                "label": "签到",
                "command": ".签到",
                "identity_id": 11111,
                "account_local_id": "main",
            }
        }
    )

    assert not plan.resolved
    assert "identity" in plan.missing


def test_messages_payload_supports_incremental_pull(tmp_path):
    """对照 docs/architecture.md inbox 设计:轮询应该走增量,不重传全部卡片。
    - 初始化(无 since_seq)取最新若干条 + 返 max_seq
    - 第二次带 since_seq → 只返新增,空列表也合法,max_seq 更新到当前水位
    """
    store = SQLiteStore(tmp_path / "miniweb.db")
    seed_sqlite_samples(store)
    server = MiniWebServer(store=store)

    initial = server.messages_payload("all")
    assert initial["messages"], "初始化应至少返回 sample 数据"
    assert initial["max_seq"] > 0
    assert initial["incremental"] is False

    high_water = initial["max_seq"]
    incremental = server.messages_payload("all", since_seq=high_water)
    assert incremental["messages"] == [], "没有新卡片应返空"
    assert incremental["max_seq"] >= high_water
    assert incremental["incremental"] is True


def test_reingesting_existing_message_preserves_card_seq(tmp_path):
    """重解析/编辑旧消息不应通过删插把旧卡片顶到最新消息流。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    old_event = RawMessageEvent(
        id="old-message",
        chat_id=-1,
        msg_id=100,
        text="old text",
        source="玩家",
        date="2026-05-15T00:00:00+00:00",
        sender_id=111,
    )
    newer_event = RawMessageEvent(
        id="newer-message",
        chat_id=-1,
        msg_id=101,
        text="newer text",
        source="玩家",
        date="2026-05-15T00:01:00+00:00",
        sender_id=111,
    )
    store.ingest_event(old_event)
    old_seq = store.get_card("old-message")[0]
    store.ingest_event(newer_event)

    store.ingest_event(
        RawMessageEvent(
            id="old-message",
            chat_id=-1,
            msg_id=100,
            text="old text edited",
            source="玩家",
            date="2026-05-15T00:00:00+00:00",
            sender_id=111,
            edited_at="2026-05-15T00:02:00+00:00",
        )
    )

    assert store.get_card("old-message")[0] == old_seq
    payload = MiniWebServer(store=store).messages_payload("all", limit=2)
    assert [item["id"] for item in payload["messages"]] == ["newer-message", "old-message"]
    assert payload["messages"][1]["raw"] == "old text edited"


def test_messages_payload_initial_order_uses_message_time_not_seq(tmp_path):
    """初始化消息流按真实消息时间排序;seq 只作为增量游标兜底。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(
        RawMessageEvent(
            id="newer-first",
            chat_id=-1,
            msg_id=200,
            text="newer by time",
            source="玩家",
            date="2026-05-15T00:10:00+00:00",
            sender_id=111,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="older-second",
            chat_id=-1,
            msg_id=199,
            text="older by time but higher seq",
            source="玩家",
            date="2026-05-15T00:00:00+00:00",
            sender_id=111,
        )
    )

    payload = MiniWebServer(store=store).messages_payload("all", limit=2)

    assert [item["id"] for item in payload["messages"]] == ["newer-first", "older-second"]
    assert payload["messages"][0]["seq"] < payload["messages"][1]["seq"]


def test_messages_payload_supports_multi_channel_sqlite_store(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    seed_sqlite_samples(store)
    server = MiniWebServer(store=store)

    payload = server.messages_payload("all", channels=["dungeon", "risk"], limit=200)

    assert payload["channels"] == ["dungeon", "risk"]
    titles = {message["title"] for message in payload["messages"]}
    assert "虚天殿开启" in titles
    assert titles & {"风险提醒", "天道审判"}
    assert all({"dungeon", "risk"}.intersection(message.get("channels") or [message["channel"]]) for message in payload["messages"])


def test_messages_payload_initial_caps_with_default_limit(tmp_path):
    """初始化默认 limit=200,避免一次拉全 SQLite。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    # 灌 250 条假事件
    from backend.domain.models import RawMessageEvent
    for i in range(250):
        store.ingest_event(
            RawMessageEvent(
                id=f"bulk-{i}",
                chat_id=-1,
                msg_id=i,
                text=f"bulk message {i}",
                source="韩天尊",
                date=f"2026-05-15T{i:02d}:00:00+00:00" if i < 24 else "2026-05-16T00:00:00+00:00",
                sender_is_bot=True,
            )
        )
    server = MiniWebServer(store=store)

    payload = server.messages_payload("all")

    assert len(payload["messages"]) <= 200
    assert payload["max_seq"] >= len(payload["messages"])


def test_messages_payload_target_id_falls_back_to_chat_msg_for_outgoing_suffix(tmp_path):
    """回复链按 tg:{chat}:{msg} 查父消息时,要能命中历史 outgoing 后缀 ID。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1001680975844:9023228:447851861646",
            chat_id=-1001680975844,
            msg_id=9023228,
            text=".闯塔",
            source="Wise Mole",
            date="2026-05-17T17:14:01+00:00",
            sender_id=8574677796,
        )
    )
    server = MiniWebServer(store=store)

    payload = server.messages_payload("all", target_id="tg:-1001680975844:9023228")

    assert len(payload["messages"]) == 1
    assert payload["messages"][0]["id"] == "tg:-1001680975844:9023228:447851861646"
    assert payload["messages"][0]["raw"] == ".闯塔"


def test_messages_payload_compact_omits_heavy_fields_but_target_stays_full(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:1",
            chat_id=-1,
            msg_id=1,
            text="【试炼古塔 - 战报】\n" + "很长的战报\n" * 40,
            source="韩天尊",
            date="2026-05-15T00:00:00+00:00",
            sender_is_bot=True,
        )
    )
    server = MiniWebServer(store=store)

    compact = server.messages_payload("all", compact=True, limit=20)["messages"][0]
    full = server.messages_payload("all", target_id="tg:-1:1", compact=True)["messages"][0]

    assert compact["compact"] is True
    assert compact["raw"] == ""
    assert compact["fields"] == {}
    assert full.get("compact") is not True
    assert "很长的战报" in full["raw"]


def test_inventory_payload_can_omit_items_for_snapshot_list(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account({"local_id": "main", "account_id": "1", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:90",
            chat_id=-1,
            msg_id=90,
            text="""@seller 的储物袋

材料:
- 灵石 x 100
- 阴凝之晶 x 2""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:91",
            chat_id=-1,
            msg_id=91,
            text="""@other 的储物袋

材料:
- 灵石 x 999""",
            source="韩天尊",
            date="2026-05-15T10:01:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    server = MiniWebServer(store=store)

    slim = server.inventory_payload(include_items=False)
    detail = server.inventory_payload(owner="seller", include_items=True, limit=1)
    blocked = server.inventory_payload(owner="other", include_items=True, limit=1)

    assert [snapshot["owner"] for snapshot in slim["snapshots"]] == ["seller"]
    assert slim["snapshots"][0]["owner"] == "seller"
    assert "items" not in slim["snapshots"][0]
    assert blocked["snapshots"] == []
    assert {(item["name"], item["amount"]) for item in detail["snapshots"][0]["items"]} == {
        ("灵石", 100),
        ("阴凝之晶", 2),
    }


def test_inventory_payload_reports_snapshot_state_for_manual_fallback(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"own_aliases": ["seller", "missing"]})
    store.save_account({"local_id": "main", "account_id": "12345", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:95",
            chat_id=-1,
            msg_id=95,
            text="""@seller 的储物袋

材料:
- 灵石 x 100
- 阴凝之晶 x 2""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:96",
            chat_id=-1,
            msg_id=96,
            text=".灵树采摘",
            source="seller",
            date="2026-05-15T10:01:00+00:00",
            sender_id=12345,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:97",
            chat_id=-1,
            msg_id=97,
            text="你稳定分得【阴凝之晶】x1。",
            source="韩天尊",
            date="2026-05-15T10:02:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
            reply_to_msg_id=96,
        )
    )
    server = MiniWebServer(store=store)

    payload = server.inventory_payload(include_items=False)
    states = {item["owner"]: item for item in payload["state"]["owners"]}

    assert payload["state"]["stale_after_seconds"] == server_module.INVENTORY_SNAPSHOT_STALE_SECONDS
    assert states["seller"]["status"] in {"estimated", "stale"}
    assert states["seller"]["estimated_item_count"] == 1
    assert states["seller"]["needs_manual_refresh"] is True
    assert states["missing"]["status"] == "missing"
    assert states["missing"]["snapshot_age_seconds"] is None
    assert states["missing"]["needs_manual_refresh"] is True
    assert payload["state"]["summary"]["manual_required_count"] >= 2
    assert payload["snapshots"][0]["estimated_item_count"] == 1
    assert payload["snapshots"][0]["needs_manual_refresh"] is True


def test_inventory_current_applies_confirmed_deltas_after_snapshot(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account({"local_id": "main", "account_id": "12345", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:100",
            chat_id=-1,
            msg_id=100,
            text="""@seller 的储物袋

材料:
- 灵石 x 100
- 阴凝之晶 x 2""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:101",
            chat_id=-1,
            msg_id=101,
            text=".灵树采摘",
            source="seller",
            date="2026-05-15T10:01:00+00:00",
            sender_id=12345,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:102",
            chat_id=-1,
            msg_id=102,
            text="你稳定分得【清灵草】x2，并获得【阴凝之晶】。",
            source="韩天尊",
            date="2026-05-15T10:02:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
            reply_to_msg_id=101,
        )
    )

    by_name = {item["name"]: item for item in store.list_inventory_current(owner="seller")}
    assert by_name["灵石"]["amount"] == 100
    assert by_name["阴凝之晶"]["amount"] == 3
    assert by_name["阴凝之晶"]["confidence"] == "estimated"
    assert by_name["清灵草"]["amount"] == 2
    assert by_name["清灵草"]["basis"] == "ledger_delta"


def test_inventory_current_adds_wanbaolou_delisting_return_to_owner(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account({"local_id": "main", "account_id": "12345", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:103",
            chat_id=-1,
            msg_id=103,
            text="""@seller 的储物袋

材料:
- 二级妖丹 x 2""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:104",
            chat_id=-1,
            msg_id=104,
            text=".下架 21179",
            source="seller",
            date="2026-05-15T10:01:00+00:00",
            sender_id=12345,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:105",
            chat_id=-1,
            msg_id=105,
            text="你已成功将 【二级妖丹】x10 从万宝楼下架，物品已归还至你的储物袋。",
            source="韩天尊",
            date="2026-05-15T10:02:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
            reply_to_msg_id=104,
        )
    )

    by_name = {item["name"]: item for item in store.list_inventory_current(owner="seller")}
    assert by_name["二级妖丹"]["amount"] == 12
    assert by_name["二级妖丹"]["confidence"] == "estimated"
    assert by_name["二级妖丹"]["basis"] == "ledger_delta"
    assert by_name["二级妖丹"]["last_delta_message_id"] == "tg:-1:105"


def test_inventory_current_resets_to_authoritative_snapshot(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account({"local_id": "main", "account_id": "12345", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:110",
            chat_id=-1,
            msg_id=110,
            text="""@seller 的储物袋

材料:
- 阴凝之晶 x 2""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:111",
            chat_id=-1,
            msg_id=111,
            text=".赠送 阴凝之晶 1",
            source="seller",
            date="2026-05-15T10:01:00+00:00",
            sender_id=12345,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:112",
            chat_id=-1,
            msg_id=112,
            text="【赠送成功】你向道友赠送了 【阴凝之晶】x1。",
            source="韩天尊",
            date="2026-05-15T10:02:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
            reply_to_msg_id=111,
        )
    )
    assert {item["name"]: item["amount"] for item in store.list_inventory_current(owner="seller")}["阴凝之晶"] == 1

    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:113",
            chat_id=-1,
            msg_id=113,
            text="""@seller 的储物袋

材料:
- 阴凝之晶 x 5""",
            source="韩天尊",
            date="2026-05-15T10:03:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    current = {item["name"]: item for item in store.list_inventory_current(owner="seller")}
    assert current["阴凝之晶"]["amount"] == 5
    assert current["阴凝之晶"]["confidence"] == "snapshot"


def test_inventory_current_delta_reingest_is_idempotent(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account({"local_id": "main", "account_id": "12345", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:120",
            chat_id=-1,
            msg_id=120,
            text="""@seller 的储物袋

材料:
- 阴凝之晶 x 2""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:121",
            chat_id=-1,
            msg_id=121,
            text=".灵树采摘",
            source="seller",
            date="2026-05-15T10:01:00+00:00",
            sender_id=12345,
        )
    )
    delta = RawMessageEvent(
        id="tg:-1:122",
        chat_id=-1,
        msg_id=122,
        text="你稳定分得【阴凝之晶】x1。",
        source="韩天尊",
        date="2026-05-15T10:02:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
        reply_to_msg_id=121,
    )
    store.ingest_event(delta)
    store.ingest_event(delta)

    current = {item["name"]: item for item in store.list_inventory_current(owner="seller")}
    assert current["阴凝之晶"]["amount"] == 3


def test_inventory_current_replays_later_deltas_when_old_snapshot_reingested(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_account({"local_id": "main", "account_id": "12345", "username": "seller"})
    snapshot = RawMessageEvent(
        id="tg:-1:130",
        chat_id=-1,
        msg_id=130,
        text="""@seller 的储物袋

材料:
- 阴凝之晶 x 2""",
        source="韩天尊",
        date="2026-05-15T10:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )
    store.ingest_event(snapshot)
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:131",
            chat_id=-1,
            msg_id=131,
            text=".灵树采摘",
            source="seller",
            date="2026-05-15T10:01:00+00:00",
            sender_id=12345,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:132",
            chat_id=-1,
            msg_id=132,
            text="你稳定分得【阴凝之晶】x1。",
            source="韩天尊",
            date="2026-05-15T10:02:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
            reply_to_msg_id=131,
        )
    )
    assert {item["name"]: item["amount"] for item in store.list_inventory_current(owner="seller")}["阴凝之晶"] == 3

    store.ingest_event(snapshot)

    current = {item["name"]: item for item in store.list_inventory_current(owner="seller")}
    assert current["阴凝之晶"]["amount"] == 3
    assert current["阴凝之晶"]["confidence"] == "estimated"


def test_account_routes_are_wired():
    """GetSendAs / resolve-entity / batch identities / accounts delete 路由必须挂上,
    前端身份表单才有得用。"""
    from backend.app import GET_ROUTES, POST_ROUTES

    assert "/api/accounts/send-as-peers" in GET_ROUTES
    assert "/api/accounts/resolve-entity" in POST_ROUTES
    assert "/api/identities/batch" in POST_ROUTES
    assert "/api/accounts/delete" in POST_ROUTES


def test_delete_account_payload_removes_record(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    assert any(item["local_id"] == "main" for item in server.accounts_payload()["accounts"])

    result = server.delete_account_payload({"local_id": "main"})

    assert result["ok"] is True
    assert result["deleted"] is True
    assert all(item["local_id"] != "main" for item in server.accounts_payload()["accounts"])


def test_delete_account_payload_rejects_missing_local_id(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.delete_account_payload({})
    assert result["ok"] is False


def test_batch_save_identities_returns_per_item_results(tmp_path):
    """「新增身份」模态框:用户勾选多个 send_as,一次性提交,
    后端逐条 save_identity,每条独立返回 ok / error。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})

    response = server.batch_save_identities_payload(
        {
            "identities": [
                {"send_as_id": "8659059191", "account_local_id": "main", "label": "A"},
                {"send_as_id": "0", "account_local_id": "main", "label": "bad"},
                {"send_as_id": "-1001234567890", "account_local_id": "missing", "label": "C"},
                {"send_as_id": "-1009999999999", "account_local_id": "main", "label": "D"},
            ]
        }
    )

    assert response["ok"] is True
    assert response["total"] == 4
    assert response["saved"] == 2
    results = response["results"]
    assert results[0]["ok"] is True
    assert results[1]["ok"] is False and "数字" in results[1]["error"]
    assert results[2]["ok"] is False and "账号" in results[2]["error"]
    assert results[3]["ok"] is True


def test_batch_save_identities_rejects_empty_list(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    response = server.batch_save_identities_payload({"identities": []})
    assert response["ok"] is False
    assert "identities" in response["error"]


def test_send_as_payload_rejects_missing_account(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.account_send_as_peers_payload("does_not_exist")

    assert result["ok"] is False
    assert "账号" in result["error"]


def test_send_as_payload_rejects_when_no_target_chat(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "phone": "+100"}
    )
    # 全局默认 target_chat 已被预设(ensure_default_settings),
    # 要测试「真的没目标」分支,先把 settings 里的 target_chat 清空,
    # 同时这个 account 自己也没 target_chat。
    server._store.save_settings({"target_chat": ""})
    result = server.account_send_as_peers_payload("main")

    assert result["ok"] is False
    assert "target_chat" in result["error"] or "目标群" in result["error"]


def test_identity_limit_is_independent_from_account_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "MAX_ACCOUNTS", 1)
    monkeypatch.setattr(server_module, "MAX_IDENTITIES", 2)
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    server.save_identity_payload({"send_as_id": "1001", "account_local_id": "main"})
    server.save_identity_payload({"send_as_id": "1002", "account_local_id": "main"})

    try:
        server.save_identity_payload({"send_as_id": "1003", "account_local_id": "main"})
    except ValueError as exc:
        assert "身份数量已达上限 2 个" in str(exc)
    else:
        raise AssertionError("third identity should exceed identity limit")


def test_legacy_listener_start_is_disabled_for_account_pool_model(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    result = server.listener_start_payload()

    assert result["ok"] is False
    assert result["listener"]["status"] == "error"
    assert "账号池" in result["listener"]["message"]


def test_outbox_plan_resolves_identity_bound_account(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )
    server.save_identity_payload({"send_as_id": "8659059191", "account_local_id": "main", "label": "WA2000"})

    plan = server.outbox_plan_payload(
        {
            "command": ".自证 U9EX 13",
            "chat_id": -1001,
            "reply_to_msg_id": 8716381,
            "identity_id": 8659059191,
            "send_mode": "manual_confirm",
        }
    )

    assert plan["ok"] is True
    assert plan["resolved"] is True
    assert plan["can_send"] is False
    assert plan["account_local_id"] == "main"
    assert plan["send_as_id"] == 8659059191
    assert plan["reply_to_msg_id"] == 8716381


def test_outbox_plan_reports_missing_account_without_losing_reply_context(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    plan = server.outbox_plan_payload(
        {
            "command": ".加入副本 394",
            "chat_id": -1001,
            "reply_to_msg_id": 8716381,
        }
    )

    assert plan["ok"] is True
    assert plan["resolved"] is False
    assert plan["missing"] == ["account"]
    assert plan["reply_to_msg_id"] == 8716381


def test_outbox_plan_tolerates_missing_identity_for_manual_fallback(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    plan = server.outbox_plan_payload(
        {
            "command": ".加入副本 394",
            "chat_id": -1001,
            "reply_to_msg_id": 8716381,
            "identity_id": 8659059191,
        }
    )

    assert plan["ok"] is True
    assert plan["resolved"] is False
    assert plan["missing"] == ["identity", "account"]
    assert plan["identity_id"] == 8659059191
    assert plan["reply_to_msg_id"] == 8716381


def test_outbox_plan_uses_account_target_chat_when_action_has_no_chat(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )

    plan = server.outbox_plan_payload({"command": ".查看储物袋", "account_local_id": "main"})

    assert plan["ok"] is True
    assert plan["resolved"] is True
    assert plan["target_chat"] == "-1001"
    assert plan["chat_id"] is None


def test_outbox_draft_roundtrip_preserves_reply_context(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )

    created = server.create_outbox_draft_payload(
        {
            "command": ".加入副本 394",
            "reply_to_msg_id": 8716381,
            "account_local_id": "main",
            "source_message_id": "tg:-1001:8716381",
        }
    )
    payload = server.outbox_drafts_payload()

    assert created["ok"] is True
    assert created["draft"]["id"]
    assert created["draft"]["command"] == ".加入副本 394"
    assert created["draft"]["reply_to_msg_id"] == 8716381
    assert created["draft"]["source_message_id"] == "tg:-1001:8716381"
    assert payload["drafts"][0]["id"] == created["draft"]["id"]


def test_outbox_draft_delete(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )
    draft = server.create_outbox_draft_payload(
        {"command": ".查看储物袋", "account_local_id": "main"}
    )["draft"]

    deleted = server.delete_outbox_draft_payload({"id": draft["id"]})

    assert deleted == {"ok": True, "deleted": True}
    assert server.outbox_drafts_payload()["drafts"] == []


def test_telegram_dialogs_report_config_error_without_crashing(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    import asyncio

    result = asyncio.run(server.telegram_dialogs_payload())

    assert result["ok"] is False
    assert result["dialogs"] == []
    assert "API ID" in result["error"]


def test_telegram_topics_require_target_chat(tmp_path):
    """target_chat 现在有默认值(-1001680975844),要测试「真的没目标群」分支
    需要显式把 settings 里 target_chat 清空。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"target_chat": ""})  # 显式清空,绕过默认
    server = MiniWebServer(store=store)

    import asyncio

    result = asyncio.run(server.telegram_topics_payload(""))

    assert result["ok"] is False
    assert result["topics"] == []
    assert "目标群" in result["error"]


def test_api_auth_helper_accepts_header_or_bearer_token():
    assert is_authorized_api_headers({}, "") is True
    assert is_authorized_api_headers({"X-Miniweb-Token": "secret"}, "secret") is True
    assert is_authorized_api_headers({"Authorization": "Bearer secret"}, "secret") is True
    assert is_authorized_api_headers({"X-Miniweb-Token": "wrong"}, "secret") is False


def test_app_import_does_not_create_default_server():
    assert MiniWebHandler.app_server is None


def test_create_handler_injects_server_instance():
    server = MiniWebServer(store=SampleStore())
    handler = create_handler(server, access_token="test-token")

    assert handler.app_server is server
    assert handler.access_token == "test-token"


def test_telethon_proxy_config_matches_old_script_shape():
    proxy = build_telethon_proxy(
        {
            "proxy_type": "socks5",
            "proxy_host": "127.0.0.1:7890",
            "proxy_username": "user",
            "proxy_password": "pass",
        }
    )

    assert proxy == {
        "proxy_type": "socks5",
        "addr": "127.0.0.1",
        "port": 7890,
        "rdns": True,
        "username": "user",
        "password": "pass",
    }


def test_proxy_host_validation():
    assert split_host_port("localhost:1080") == ("localhost", 1080)

    try:
        split_host_port("localhost")
    except ValueError as exc:
        assert "host:port" in str(exc)
    else:
        raise AssertionError("invalid proxy host should fail")


def test_discovered_bots_filters_by_game_keyword_hits(tmp_path):
    """discovered bots 只列「真发过游戏 bot 风格消息」的 sender。
    频道号闲聊(没游戏关键词)不该被丢进来。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    # 一个 bot 用户发游戏卡片(应被发现)
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:1", chat_id=-1001, msg_id=1,
        text="📊 【天机阁 · 战力评估】\n⚔️ 综合战力: 333.8万",
        source="韩天尊", date="2026-05-16T01:00:00+00:00",
        sender_id=7900199668, sender_is_bot=True,
    ))
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:2", chat_id=-1001, msg_id=2,
        text="点卯成功,获得宗门贡献",
        source="韩天尊", date="2026-05-16T01:01:00+00:00",
        sender_id=7900199668, sender_is_bot=True,
    ))
    # 一个频道号闲聊(无游戏关键词,应被过滤)
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:3", chat_id=-1001, msg_id=3,
        text="今天天气真好啊,出去走走",
        source="玩家闲聊频道", date="2026-05-16T01:02:00+00:00",
        sender_id=-1009999999999, sender_is_bot=False,
    ))
    # 一个频道号发指令(`.` 开头,不算 bot 回复)
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:4", chat_id=-1001, msg_id=4,
        text=".签到 .点卯",
        source="另一玩家", date="2026-05-16T01:03:00+00:00",
        sender_id=-1008888888888, sender_is_bot=False,
    ))

    discovered = store.list_discovered_bots()
    sender_ids = {item["sender_id"] for item in discovered}
    assert 7900199668 in sender_ids, "命中关键词的 bot 应被发现"
    assert -1009999999999 not in sender_ids, "闲聊频道不该被丢进来"
    assert -1008888888888 not in sender_ids, "玩家发指令(. 开头)不该被当 bot"

    bot_item = next(item for item in discovered if item["sender_id"] == 7900199668)
    assert bot_item["hit_count"] >= 1
    assert bot_item["matched_families"]


def test_discovered_bots_keeps_manual_marked_even_without_messages(tmp_path):
    """game_bot_ids 里手动加的 sender,即使消息箱里没采到过,也要列出来让用户能取消。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [7900199668]})
    server = MiniWebServer(store=store)

    payload = server.discovered_bots_payload()

    assert any(
        item["sender_id"] == 7900199668 and item.get("manual_only") and item["is_game_bot"]
        for item in payload["discovered"]
    )


def test_schedule_presets_payload_lists_known_presets():
    """5 个预设(深度闭关 / 抚摸 / 温养 / 试炼 + 自定义)。"""
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as tmp:
        server = MiniWebServer(store=SQLiteStore(pathlib.Path(tmp) / "x.db"))
        payload = server.schedule_presets_payload()
    assert payload["ok"] is True
    keys = {p["key"] for p in payload["presets"]}
    assert keys >= {"deep_retreat", "pet_touch", "pet_warm", "pet_trial", "custom"}


def test_schedule_preview_deep_retreat_returns_plan_items(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.schedule_preview_payload({"preset_key": "deep_retreat", "horizon_days": 2})
    assert result["ok"] is True
    items = result["items"]
    assert items, "深度闭关 2 天应至少出 1 个 CD 周期"
    commands = [it["command"] for it in items]
    assert "查看闭关" in commands
    assert ".深度闭关" in commands


def test_schedule_preview_custom_uses_user_command(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.schedule_preview_payload(
        {"preset_key": "custom", "command": ".签到", "interval_sec": 3600, "count": 3}
    )
    assert result["ok"] is True
    assert len(result["items"]) == 3
    assert all(it["command"] == ".签到" for it in result["items"])


def test_schedule_create_dry_run_writes_batch_without_telegram(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    result = server.schedule_create_payload(
        {"send_as_id": 12345, "preset_key": "deep_retreat", "horizon_days": 1, "dry_run": True}
    )
    assert result["ok"] is True
    assert result["dry_run"] is True
    assert result["planned_count"] > 0
    assert result["created_official"] == 0

    listing = server.schedule_list_payload()
    assert len(listing["batches"]) == 1
    assert listing["batches"][0]["counts"]["planned"] > 0


def test_schedule_create_blocks_real_batch_when_identity_quota_is_full(tmp_path):
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [
            {"command": ".签到", "schedule_at": time.time() + i * 60, "status": "scheduled"}
            for i in range(100)
        ],
    )

    class FakeListeners:
        def get_listener(self, account_local_id):
            return object()

    server._listeners = FakeListeners()

    result = server.schedule_create_payload(
        {
            "send_as_id": 12345,
            "preset_key": "custom",
            "command": ".签到",
            "interval_sec": 60,
            "count": 1,
            "dry_run": False,
        }
    )

    assert result["ok"] is False
    assert result["status"] == "quota_blocked"
    assert result["manual_required"] is True
    assert result["scheduled_current"] == 100
    assert result["planned_count"] == 1
    assert len(store.list_schedule_batches(include_inactive=True)) == 1


def test_schedule_create_allows_real_batch_that_exactly_reaches_identity_quota(tmp_path):
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_settings_payload({"target_chat": "-1001680975844", "target_topic_id": ""})
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [
            {"command": ".签到", "schedule_at": time.time() + i * 60, "status": "scheduled"}
            for i in range(99)
        ],
    )

    class FakeListener:
        def submit_background(self, _callback):
            return None

    class FakeListeners:
        def get_listener(self, account_local_id):
            return FakeListener()

    server._listeners = FakeListeners()

    result = server.schedule_create_payload(
        {
            "send_as_id": 12345,
            "preset_key": "custom",
            "command": ".签到",
            "interval_sec": 60,
            "count": 1,
            "dry_run": False,
        }
    )

    assert result["ok"] is True
    assert result["status"] == "sending"
    assert result["planned_count"] == 1
    assert server._official_schedule_identity_usage(12345) == 100
    assert len(store.list_schedule_batches(include_inactive=True)) == 2


def test_schedule_create_without_target_chat_does_not_leave_active_batch(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_settings_payload({"target_chat": "", "target_topic_id": ""})
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    class FakeListeners:
        def get_listener(self, account_local_id):
            return object()

    server._listeners = FakeListeners()

    result = server.schedule_create_payload(
        {
            "send_as_id": 12345,
            "preset_key": "custom",
            "command": ".签到",
            "interval_sec": 60,
            "count": 1,
            "dry_run": False,
        }
    )

    assert result["ok"] is False
    assert "target_chat" in result["error"] or "目标群" in result["error"]
    assert store.list_schedule_batches(include_inactive=True) == []
    assert store.list_schedule_messages(send_as_id=12345, include_inactive=True) == []


def test_schedule_create_blocks_entire_batch_when_identity_quota_would_overflow(tmp_path):
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [
            {"command": ".签到", "schedule_at": time.time() + i * 60, "status": "scheduled"}
            for i in range(99)
        ],
    )

    class FakeListeners:
        def get_listener(self, account_local_id):
            return object()

    server._listeners = FakeListeners()

    result = server.schedule_create_payload(
        {
            "send_as_id": 12345,
            "preset_key": "custom",
            "command": ".签到",
            "interval_sec": 60,
            "count": 2,
            "dry_run": False,
        }
    )

    assert result["ok"] is False
    assert result["status"] == "quota_blocked"
    assert result["scheduled_current"] == 99
    assert result["planned_count"] == 2
    assert len(store.list_schedule_batches(include_inactive=True)) == 1


def test_schedule_create_dry_run_ignores_official_quota(tmp_path):
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [
            {"command": ".签到", "schedule_at": time.time() + i * 60, "status": "scheduled"}
            for i in range(100)
        ],
    )

    result = server.schedule_create_payload(
        {
            "send_as_id": 12345,
            "preset_key": "custom",
            "command": ".本地预演",
            "interval_sec": 60,
            "count": 2,
            "dry_run": True,
        }
    )

    assert result["ok"] is True
    assert result["dry_run"] is True
    assert result["planned_count"] == 2
    assert len(store.list_schedule_batches(include_inactive=True)) == 2


def test_schedule_delete_marks_batch_and_messages_deleted(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    created = server.schedule_create_payload(
        {"send_as_id": 12345, "preset_key": "deep_retreat", "horizon_days": 1, "dry_run": True}
    )
    deleted = server.schedule_delete_payload({"batch_id": created["batch_id"]})
    assert deleted["ok"] is True
    assert deleted["local"]["batch"] == 1
    assert server.schedule_list_payload()["batches"] == []


def test_schedule_templates_roundtrip(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)

    saved = server.schedule_template_save_payload({
        "name": "深闭三天",
        "payload": {
            "preset_key": "deep_retreat",
            "horizon_days": 3,
            "trigger_command": "查看闭关",
            "anchor_at": 1999999999,
        },
    })

    assert saved["ok"] is True
    template = saved["templates"][0]
    assert template["name"] == "深闭三天"
    assert template["payload"]["preset_key"] == "deep_retreat"
    assert "anchor_at" not in template["payload"]

    listed = server.schedule_templates_payload()
    assert listed["templates"][0]["id"] == template["id"]

    deleted = server.schedule_template_delete_payload({"id": template["id"]})
    assert deleted["ok"] is True
    assert deleted["templates"] == []


def test_schedule_routes_are_wired():
    from backend.app import GET_ROUTES, POST_ROUTES
    assert "/api/schedule/presets" in GET_ROUTES
    assert "/api/schedule/templates" in GET_ROUTES
    assert "/api/schedule" in GET_ROUTES
    assert "/api/schedule/sync" in GET_ROUTES
    assert "/api/schedule/preview" in POST_ROUTES
    assert "/api/schedule/create" in POST_ROUTES
    assert "/api/schedule/delete" in POST_ROUTES
    assert "/api/schedule/templates/save" in POST_ROUTES
    assert "/api/schedule/templates/delete" in POST_ROUTES


def test_outbox_logs_route_and_store_roundtrip(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    saved = store.append_send_log(
        {
            "kind": "manual_send",
            "status": "success",
            "account_local_id": "main",
            "identity_id": 12345,
            "send_as_id": 0,
            "chat_id": -1001680975844,
            "topic_id": 7310786,
            "reply_to_msg_id": 7000,
            "command": ".野外历练",
            "source_message_id": "tg:-1001680975844:6999",
            "tg_msg_id": 8000,
            "meta": {"skill_key": "wild_training"},
        }
    )

    payload = server.outbox_logs_payload(kind="manual_send", identity_id=12345)

    assert saved["id"] > 0
    assert payload["ok"] is True
    assert len(payload["logs"]) == 1
    assert payload["logs"][0]["command"] == ".野外历练"
    assert payload["logs"][0]["meta"]["skill_key"] == "wild_training"

    from backend.app import GET_ROUTES
    assert "/api/outbox/logs" in GET_ROUTES


def test_schedule_sync_without_listener_returns_error(tmp_path):
    """没有 listener 在跑就没 client 可拉 TG,这时 sync 应明确报错而不是默默挂掉。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    result = server.schedule_sync_payload(12345)

    assert result["ok"] is False
    assert "采集" in result["error"]


def test_schedule_sync_reconciles_with_local_records(tmp_path):
    """灌假 listener,模拟 TG 返回 3 条 scheduled,本地有 2 条(一条对得上、一条 TG 没了),
    sync 应正确分出 matched / orphans / lost。"""
    class FakeListenerManager:
        def status(self, local_id=None):
            return {"status": "running", "message": ""} if local_id else {
                "max_listeners": 1,
                "collector": "main",
                "running": {"main": {"status": "running", "message": "ok"}},
            }

        def stop(self, _local_id):
            return {"status": "stopped", "message": "fake"}

        def get_listener(self, local_id):
            if local_id != "main":
                return None
            outer = self

            class FakeListener:
                def is_running(self):
                    return True

                def submit(self, coro_factory, *, timeout=30.0):
                    # 直接返我们假造的 TG 列表,不真去 Telegram
                    return [
                        {"scheduled_msg_id": 100, "message": ".签到", "schedule_at": 0, "schedule_text": ""},
                        {"scheduled_msg_id": 101, "message": ".抚摸法宝", "schedule_at": 0, "schedule_text": ""},
                        {"scheduled_msg_id": 999, "message": "orphan from phone", "schedule_at": 0, "schedule_text": ""},
                    ]

            return FakeListener()

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    # 建一个 batch,人为标记两条已排:scheduled_msg_id=100(对得上 TG)+ scheduled_msg_id=555(TG 没有,会成为 lost)
    server.schedule_create_payload(
        {"send_as_id": 12345, "preset_key": "custom", "command": ".签到", "interval_sec": 60, "count": 2, "dry_run": True}
    )
    msgs = store.list_schedule_messages(send_as_id=12345)
    store.mark_schedule_message(msgs[0]["id"], scheduled_msg_id=100, status="scheduled")
    store.mark_schedule_message(msgs[1]["id"], scheduled_msg_id=555, status="scheduled")

    server._listeners = FakeListenerManager()

    result = server.schedule_sync_payload(12345)

    assert result["ok"] is True
    assert len(result["tg_messages"]) == 3
    assert len(result["matched"]) == 1
    assert result["matched"][0]["tg"]["scheduled_msg_id"] == 100
    assert any(o["scheduled_msg_id"] == 999 for o in result["orphans"]), "TG 多出来的应在 orphans"
    assert any(o["scheduled_msg_id"] == 101 for o in result["orphans"]), "TG 有但本地没的也算 orphans"
    assert any(l["scheduled_msg_id"] == 555 for l in result["lost"]), "本地标已排但 TG 没找到的应在 lost"



# ====================================================================
# Identity state machine framework (deep_retreat / pet_touch / pet_warm)
# ====================================================================

def test_parse_chinese_duration_handles_mixed_units():
    from backend.identity_state.duration import parse_chinese_duration
    assert parse_chinese_duration("8 小时") == 8 * 3600
    assert parse_chinese_duration("5小时57分钟31秒") == 5 * 3600 + 57 * 60 + 31
    assert parse_chinese_duration("9分钟") == 540
    assert parse_chinese_duration("1天2小时") == 86400 + 7200
    assert parse_chinese_duration("空") == 0
    assert parse_chinese_duration("") == 0


def test_classify_sender_buckets_correctly():
    from backend.identity_state import classify_sender
    assert classify_sender(12345, my_identities={12345}, game_bot_ids={}) == "self"
    assert classify_sender(-1003983937918, my_identities={}, game_bot_ids={-1003983937918}) == "bot"
    assert classify_sender(8388633812, my_identities={}, game_bot_ids={8388633812}) == "bot"
    assert classify_sender(-100200300, my_identities={}, game_bot_ids={}) == "channel"
    assert classify_sender(99999, my_identities={}, game_bot_ids={}) == "player"
    assert classify_sender(None, my_identities={}, game_bot_ids={}) == "player"


def _fake_ctx(*, parent, sender_kind, now=1_700_000_000.0):
    from backend.identity_state import ObserveContext
    return ObserveContext(
        parent=parent,
        sender_kind=sender_kind,
        my_identities=frozenset({12345}),
        game_bot_ids=frozenset({-1003983937918}),
        settings={},
        now=now,
    )


def _evt(**kw):
    from backend.domain.models import RawMessageEvent
    base = dict(id="x", chat_id=-1001680975844, msg_id=0, text="",
                source="", date="", sender_id=None, reply_to_msg_id=None)
    base.update(kw)
    return RawMessageEvent(**base)


def test_deep_retreat_module_captures_entry_and_cooldown():
    from backend.identity_state.deep_retreat import DeepRetreatModule, DEEP_RETREAT_DEFAULT_CD
    module = DeepRetreatModule()
    parent = _evt(id="p", msg_id=100, text=".深度闭关", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=101,
        text="你已进入深度闭关状态，神魂将自行吐纳 8 小时。\n期间你将无法进行大部分操作。下次发言时将自动结算本次闭关的收获。",
        sender_id=-1003983937918,
        reply_to_msg_id=100,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state is not None
    assert state["phase"] == "running"
    assert state["entered_at"] == ctx.now
    assert state["cooldown_until"] == ctx.now + DEEP_RETREAT_DEFAULT_CD
    assert module.compute_anchor(state, now=ctx.now) == state["cooldown_until"]
    summary = module.status_summary(state, now=ctx.now)
    assert "剩" in summary["text"]
    assert summary["ready"] is False


def test_deep_retreat_module_ignores_player_messages():
    from backend.identity_state.deep_retreat import DeepRetreatModule
    module = DeepRetreatModule()
    parent = _evt(id="p", msg_id=100, text=".深度闭关", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=101,
        text="你已进入深度闭关状态，神魂将自行吐纳 8 小时。",
        sender_id=99999,  # 玩家
        reply_to_msg_id=100,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="player")
    # resolve_target 要求 sender_kind=='bot',player 不会被处理
    assert module.resolve_target(event, ctx) is None


def test_pet_touch_module_records_pet_name_from_parent_command():
    from backend.identity_state.pet_touch import PetTouchModule, PET_TOUCH_DEFAULT_CD
    module = PetTouchModule()
    parent = _evt(id="p", msg_id=200, text=".抚摸法宝 玄天斩灵剑", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=201,
        text="你抚摸了玄天斩灵剑，与法宝心意相通。(默契+1, 经验+5)",
        sender_id=-1003983937918,
        reply_to_msg_id=200,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["pet_name"] == "玄天斩灵剑"
    assert state["cooldown_until"] == ctx.now + PET_TOUCH_DEFAULT_CD


def test_pet_warm_module_respects_cd_reply_wait():
    from backend.identity_state.pet_warm import PetWarmModule
    module = PetWarmModule()
    parent = _evt(id="p", msg_id=300, text=".温养器灵 青竹蜂云剑（庚金版）", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=301,
        text="器灵方才吞纳过灵机，请在 5小时57分钟31秒 后再行温养。",
        sender_id=-1003983937918,
        reply_to_msg_id=300,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["pet_name"] == "青竹蜂云剑（庚金版）"
    assert state["cooldown_until"] == ctx.now + 5 * 3600 + 57 * 60 + 31


def test_generic_cooldown_module_records_pet_trial_cd():
    from backend.identity_state.cooldown import DEFAULT_COOLDOWN_SPECS, CooldownModule
    spec = next(item for item in DEFAULT_COOLDOWN_SPECS if item.key == "pet_trial")
    module = CooldownModule(spec)
    parent = _evt(id="p", msg_id=310, text=".器灵试炼 青竹蜂云剑", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=311,
        text="【器灵试炼·灵潮】\n器灵试炼归来，法宝灵光更盛。",
        sender_id=-1003983937918,
        reply_to_msg_id=310,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["pet_name"] == "青竹蜂云剑"
    assert state["cooldown_until"] == ctx.now + 8 * 3600
    assert state["last_status"] == "success"


def test_generic_cooldown_module_records_shallow_retreat_wait():
    from backend.identity_state.cooldown import DEFAULT_COOLDOWN_SPECS, CooldownModule
    spec = next(item for item in DEFAULT_COOLDOWN_SPECS if item.key == "retreat_shallow")
    module = CooldownModule(spec)
    parent = _evt(id="p", msg_id=315, text=".闭关修炼", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=316,
        text="【闭关成功】\n本次闭关，你的修为最终增加了 972 点。\n你感到一阵疲惫，需要打坐调息 11 分钟方可再次闭关。",
        sender_id=-1003983937918,
        reply_to_msg_id=315,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["cooldown_until"] == ctx.now + 11 * 60
    assert state["last_status"] == "cooldown"


def test_generic_cooldown_module_uses_real_wait_text():
    from backend.identity_state.cooldown import DEFAULT_COOLDOWN_SPECS, CooldownModule
    spec = next(item for item in DEFAULT_COOLDOWN_SPECS if item.key == "taiyi_cycle")
    module = CooldownModule(spec)
    parent = _evt(id="p", msg_id=320, text=".搜寻节点", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=321,
        text="你的神识尚在恢复中，请在 11小时59分钟32秒 后再行搜寻。",
        sender_id=-1003983937918,
        reply_to_msg_id=320,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["cooldown_until"] == ctx.now + 11 * 3600 + 59 * 60 + 32
    assert state["last_status"] == "cooldown"


def test_second_soul_cooldown_module_marks_ready_from_panel():
    from backend.identity_state.cooldown import DEFAULT_COOLDOWN_SPECS, CooldownModule
    spec = next(item for item in DEFAULT_COOLDOWN_SPECS if item.key == "second_soul")
    module = CooldownModule(spec)
    parent = _evt(id="p", msg_id=330, text=".第二元神", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=331,
        text="【你的第二元神：玄微】\n状态：窍中温养",
        sender_id=-1003983937918,
        reply_to_msg_id=330,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["cooldown_until"] == ctx.now
    assert module.status_summary(state, now=ctx.now)["ready"] is True


def test_second_soul_cooldown_module_uses_short_recheck_when_no_remaining_time():
    from backend.identity_state.cooldown import DEFAULT_COOLDOWN_SPECS, CooldownModule
    spec = next(item for item in DEFAULT_COOLDOWN_SPECS if item.key == "second_soul")
    module = CooldownModule(spec)
    parent = _evt(id="p", msg_id=340, text=".元神修炼", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=341,
        text="你的第二元神尚无法分心修炼（修炼中）。",
        sender_id=-1003983937918,
        reply_to_msg_id=340,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["cooldown_until"] == ctx.now + 3600


def test_weakness_module_records_weakness_until_without_blocking_send_logic():
    from backend.identity_state.weakness import WeaknessModule
    module = WeaknessModule()
    parent = _evt(id="p", msg_id=350, text=".抚摸法宝 玄天斩灵剑", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=351,
        text="🚫 虚弱状态\n暂时无法运转灵力，请在洞府中静养 29分钟。",
        sender_id=-1003983937918,
        reply_to_msg_id=350,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot", now=1000.0)
    assert module.resolve_target(event, ctx) == 12345
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["source"] == "weakness"
    assert state["blocked_until"] > ctx.now + 29 * 60
    summary = module.status_summary(state, now=ctx.now)
    assert summary["ready"] is False
    assert "虚弱中" in summary["text"]


def test_weakness_module_records_and_clears_jingsi_state():
    from backend.identity_state.weakness import WeaknessModule
    module = WeaknessModule()
    parent = _evt(id="p", msg_id=360, text=".静思崖", sender_id=12345)
    busy = _evt(
        id="e1",
        msg_id=361,
        text="你消耗了 100 灵石与 2000 修为，来到静思崖面壁悟道。\n此过程需 4小时，期间你将无法进行大部分操作。",
        sender_id=-1003983937918,
        reply_to_msg_id=360,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot", now=2000.0)
    state = module.observe(busy, ctx, dict(module.default_state))
    assert state["source"] == "jingsi"
    assert state["blocked_until"] >= ctx.now + 4 * 3600
    assert "静思中" in module.status_summary(state, now=ctx.now)["text"]

    interrupt = _evt(
        id="e2",
        msg_id=362,
        text="【心乱如麻】你终究无法忍受面壁的枯燥，强行中断了感悟，离开了静思崖。",
        sender_id=-1003983937918,
        reply_to_msg_id=360,
    )
    cleared = module.observe(interrupt, ctx, state)
    assert cleared["blocked_until"] == 0
    assert cleared["source"] == ""
    assert module.status_summary(cleared, now=ctx.now)["ready"] is True


def test_small_world_module_records_panel_and_wait():
    from backend.identity_state.small_world import SmallWorldModule
    module = SmallWorldModule()
    parent = _evt(id="p", msg_id=370, text=".小世界", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=371,
        text=(
            "【吕洛的小世界】\n"
            "🙏 信仰: 100 / 100\n"
            "☁️ 待收香火: 3189.33\n"
            "🏺 香火库存: 3\n"
            "暂无祈愿，凡间风调雨顺。\n"
            "(下一次祈愿感应需等待: 7小时53分钟50秒)"
        ),
        sender_id=-1003983937918,
        reply_to_msg_id=370,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot", now=3000.0)
    assert module.resolve_target(event, ctx) == 12345
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["owner"] == "吕洛"
    assert state["faith"] == 100
    assert state["pending_incense"] == 3189.33
    assert state["incense_stock"] == 3
    assert state["prayer_wait_until"] > ctx.now + 7 * 3600
    summary = module.status_summary(state, now=ctx.now)
    assert summary["ready"] is False
    assert "信仰 100/100" in summary["text"]


def test_small_world_module_updates_harvest_refine_and_shortage():
    from backend.identity_state.small_world import SmallWorldModule
    module = SmallWorldModule()
    parent = _evt(id="p", msg_id=380, text=".收割香火", sender_id=12345)
    ctx = _fake_ctx(parent=parent, sender_kind="bot", now=4000.0)
    state = module.observe(
        _evt(
            id="e1",
            msg_id=381,
            text="收割完成，当前香火库存: 27",
            sender_id=-1003983937918,
            reply_to_msg_id=380,
        ),
        ctx,
        {"pending_incense": 10, "incense_stock": 2},
    )
    assert state["incense_stock"] == 27
    assert state["pending_incense"] == 0
    refined = module.observe(
        _evt(
            id="e2",
            msg_id=382,
            text="你燃烧了 20 点香火，神识得到淬炼。",
            sender_id=-1003983937918,
            reply_to_msg_id=380,
        ),
        ctx,
        state,
    )
    assert refined["incense_stock"] == 7
    blocked = module.observe(
        _evt(
            id="e3",
            msg_id=383,
            text="香火库存不足（拥有: 7）",
            sender_id=-1003983937918,
            reply_to_msg_id=380,
        ),
        ctx,
        refined,
    )
    assert blocked["last_status"] == "blocked"
    assert "香火库存不足" in blocked["last_error"]


def test_module_registry_observe_only_writes_when_state_changes():
    from backend.identity_state import build_default_registry
    reg = build_default_registry()
    parent = _evt(id="p", msg_id=200, text=".抚摸法宝 玄天斩灵剑", sender_id=12345)
    unrelated = _evt(id="e", msg_id=201, text="今天天气真好。", sender_id=-1003983937918, reply_to_msg_id=200)
    storage: dict = {}
    def _get(sid, key):
        return {"state": storage.get((sid, key))} if (sid, key) in storage else None
    def _save(sid, key, state, src):
        storage[(sid, key)] = state
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    results = reg.observe_all(unrelated, ctx, get_state=_get, save_state=_save)
    assert results == []

    assert reg.get("weakness") is not None
    assert reg.get("small_world") is not None
    assert storage == {}


def test_sqlite_store_persists_module_state_via_pipeline(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-1003983937918]})
    store.save_identity({"send_as_id": 12345, "label": "me"})

    parent = RawMessageEvent(
        id="p1", chat_id=-1001680975844, msg_id=100,
        text=".深度闭关", source="", date="", sender_id=12345,
    )
    store.ingest_event(parent)
    bot_reply = RawMessageEvent(
        id="e1", chat_id=-1001680975844, msg_id=101,
        text="你已进入深度闭关状态，神魂将自行吐纳 8 小时。",
        source="", date="", sender_id=-1003983937918, reply_to_msg_id=100,
    )
    store.ingest_event(bot_reply)

    record = store.get_module_state(12345, "deep_retreat")
    assert record is not None
    assert record["state"]["phase"] == "running"
    assert record["state"]["cooldown_until"] > record["state"]["entered_at"]


def test_identity_state_payload_groups_by_send_as(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-1003983937918]})
    store.save_identity({"send_as_id": 12345, "label": "me"})
    store.ingest_event(RawMessageEvent(
        id="p1", chat_id=-1001680975844, msg_id=100,
        text=".抚摸法宝 玄天斩灵剑", source="", date="", sender_id=12345,
    ))
    store.ingest_event(RawMessageEvent(
        id="e1", chat_id=-1001680975844, msg_id=101,
        text="你抚摸了玄天斩灵剑(默契+1, 经验+5)", source="", date="",
        sender_id=-1003983937918, reply_to_msg_id=100,
    ))
    server = MiniWebServer(store=store)
    payload = server.identity_state_payload("")
    assert payload["ok"] is True
    module_keys = {m["key"] for m in payload["modules"]}
    assert {"deep_retreat", "pet_touch", "pet_warm"} <= module_keys
    assert {"wild_training", "tianti_climb", "taiyi_cycle"} <= module_keys
    by_identity = payload["by_identity"]
    assert any(entry["send_as_id"] == 12345 for entry in by_identity)
    me_items = next(entry for entry in by_identity if entry["send_as_id"] == 12345)["items"]
    pet_item = next(i for i in me_items if i["module_key"] == "pet_touch")
    assert pet_item["state"]["pet_name"] == "玄天斩灵剑"
    assert "剩" in pet_item["summary"]["text"] or pet_item["summary"]["ready"]


def test_schedule_build_plan_uses_auto_anchor_resolver(tmp_path):
    from backend.outbox.schedule import build_plan
    import time
    now = time.time()
    later = now + 5 * 3600  # 5h 后才可用
    resolver_calls: list[tuple[int, str]] = []
    def resolver(sid: int, key: str) -> float | None:
        resolver_calls.append((sid, key))
        return later
    plan = build_plan(
        {
            "preset_key": "deep_retreat",
            "anchor_at": now,
            "horizon_days": 1,
            "auto_anchor": True,
            "auto_anchor_module": "deep_retreat",
            "send_as_id": 12345,
        },
        anchor_resolver=resolver,
    )
    assert plan["auto_anchor_used"] is True
    assert plan["anchor_at"] == later
    assert resolver_calls == [(12345, "deep_retreat")]
    # 没有 auto_anchor 时,resolver 不应被调
    resolver_calls.clear()
    plan2 = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 1}, anchor_resolver=resolver)
    assert plan2["auto_anchor_used"] is False
    assert resolver_calls == []


def test_identity_state_route_is_wired():
    routes_get = create_handler(MiniWebServer())
    assert "/api/identity-state" in routes_get.__dict__.get("__module__", "") or True
    # The above is a soft check; rely on the imports route table directly:
    from backend.app import GET_ROUTES
    assert "/api/identity-state" in GET_ROUTES


def test_backfill_module_states_replays_existing_raw_messages(tmp_path):
    """模拟"老库":raw_messages 已经有数据,但 identity_module_state 是空的。
    backfill_module_states_if_empty 应该重新跑 pipeline,把 module state 填好。"""
    import json as _json, time as _time
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-1003983937918]})
    store.save_identity({"send_as_id": 12345, "label": "me"})

    # 绕过 ingest_event,直接 SQL 写两条 raw_messages,模拟"老 pipeline 跑过但 module 表为空"
    with store._connect() as conn:
        for (mid, sid, reply_to, text) in [
            (100, 12345, None, ".深度闭关"),
            (101, -1003983937918, 100, "你已进入深度闭关状态，神魂将自行吐纳 8 小时。"),
        ]:
            conn.execute(
                """
                INSERT INTO raw_messages(id, chat_id, msg_id, text, source, date,
                    sender_id, reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (f"raw-{mid}", -1001680975844, mid, text, "", "2026-05-15T00:00:00Z",
                 sid, reply_to, None, _json.dumps([]), int(sid < 0)),
            )

    assert store.list_module_states() == []
    processed = store.backfill_module_states_if_empty()
    assert processed == 2
    record = store.get_module_state(12345, "deep_retreat")
    assert record is not None
    assert record["state"]["phase"] == "running"
    assert record["state"]["cooldown_until"] > record["state"]["entered_at"]


def test_backfill_module_states_noop_when_table_nonempty(tmp_path):
    """已经有 state 就不再重放,避免重启时反复扫表。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_module_state(12345, "deep_retreat", {"phase": "running"}, source_message_id="sentinel")
    assert store.backfill_module_states_if_empty() == 0


def test_schedule_build_plan_auto_anchor_first_due_lands_on_cooldown_until():
    """auto_anchor 推算的下次可用时间是 cooldown_until。
    第一条 plan(trigger 词)应该落在 cooldown_until + 触发偏移(60-120s + jitter),
    而不是再加一整个 CD。"""
    from backend.outbox.schedule import build_plan, DEEP_RETREAT_CD, DEFAULT_TRIGGER_DELAY_SEC, JITTER_MAX_SEC
    import time
    now = time.time()
    cooldown_until = now + 3 * 3600 + 35 * 60  # 状态机说"还剩 3:35"
    def resolver(sid: int, key: str) -> float | None:
        return cooldown_until
    plan = build_plan(
        {
            "preset_key": "deep_retreat",
            "anchor_at": now,
            "horizon_days": 1,
            "auto_anchor": True,
            "auto_anchor_module": "deep_retreat",
            "send_as_id": 12345,
        },
        anchor_resolver=resolver,
    )
    assert plan["auto_anchor_used"] is True
    assert plan["anchor_at"] == cooldown_until  # 显示锚点保持 cooldown_until
    assert plan["items"], "应该至少有一条 item"
    first_due = plan["items"][0]["schedule_at"]
    # 第一条 = anchor + 触发偏移(默认 60s)+ jitter[0, JITTER_MAX_SEC]
    # 区间:cooldown_until + 60 ~ cooldown_until + 60 + JITTER_MAX
    lo = cooldown_until + DEFAULT_TRIGGER_DELAY_SEC
    hi = cooldown_until + DEFAULT_TRIGGER_DELAY_SEC + JITTER_MAX_SEC + 5
    assert lo <= first_due <= hi, f"first_due={first_due}, expected in [{lo}, {hi}]"
    assert plan["first_due_at"] == first_due
    # horizon 不缩水:1 天的窗口里至少能塞下 1 个 CD(8h)的下一对
    last_due = plan["items"][-1]["schedule_at"]
    assert last_due > cooldown_until + DEEP_RETREAT_CD, "1 天 horizon 至少跨过一次 CD"


def test_estimate_send_seconds_scales_with_count():
    """估算函数随条数线性增长,21 天 60 条应该落在 30-50 分钟区间。"""
    from backend.server import _estimate_send_seconds
    assert _estimate_send_seconds(0) == 0
    assert _estimate_send_seconds(1) == 1
    six = _estimate_send_seconds(6)
    assert 100 < six < 250
    sixty = _estimate_send_seconds(60)
    assert 30 * 60 < sixty < 50 * 60


def test_schedule_create_returns_immediately_with_sending_status(tmp_path):
    """real send 模式下,schedule_create_payload 应该立刻返,不阻塞等待发送完成。
    submit_background 被调用一次,batch.status 标 sending。"""
    submitted: list = []
    background_ran = []

    class FakeListener:
        def is_running(self):
            return True

        def submit_background(self, coro_factory):
            submitted.append(coro_factory)

            class FakeFuture:
                def cancel(self): pass

            return FakeFuture()

        def submit(self, coro_factory, *, timeout=30.0):
            return None

    class FakeListenerManager:
        def get_listener(self, *_args, **_kwargs):
            return FakeListener()

    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"target_chat": "-1001680975844", "target_topic_id": 7310786})
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    server._listeners = FakeListenerManager()

    result = server.schedule_create_payload({
        "send_as_id": 12345,
        "preset_key": "custom",
        "command": ".签到",
        "interval_sec": 60,
        "count": 3,
        "dry_run": False,
    })
    assert result["ok"] is True, result
    assert result["status"] == "sending"
    assert result["estimate_seconds"] > 0
    # submit_background 应该恰好被调一次
    assert len(submitted) == 1
    # batch 状态在 store 里应该是 sending
    batches = store.list_schedule_batches(include_inactive=True)
    assert any(b["id"] == result["batch_id"] and b["status"] == "sending" for b in batches)


def test_schedule_cancel_marks_batch_cancelled(tmp_path):
    """cancel API 把 sending 批次标 cancelled,后台 loop 看到就早退。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    server.schedule_create_payload({
        "send_as_id": 12345,
        "preset_key": "custom",
        "command": ".签到",
        "interval_sec": 60,
        "count": 2,
        "dry_run": True,
    })
    batch_id = store.list_schedule_batches(include_inactive=True)[0]["id"]
    # dry_run 不会进 sending,先手动标
    store.set_schedule_batch_status(batch_id, "sending")

    result = server.schedule_cancel_payload({"batch_id": batch_id})
    assert result["ok"] is True
    assert result["status"] == "cancelled"
    refreshed = store.list_schedule_batches(include_inactive=True)
    assert any(b["id"] == batch_id and b["status"] == "cancelled" for b in refreshed)


def test_schedule_cancel_route_is_wired():
    from backend.app import POST_ROUTES
    assert "/api/schedule/cancel" in POST_ROUTES


def test_messages_solo_mode_filters_to_me_and_bot_replies(tmp_path):
    """solo 模式 SQL 过滤:只返我发的消息 + bot 回我的消息。
    与窗口大小无关 — 这是修「200 条窗口里没我自己的消息,solo 一片空白」的关键。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-100]})
    store.save_identity({"send_as_id": 12345, "label": "me"})

    # 灌一堆杂讯(其他玩家 + bot 回别人) + 一条我的指令 + 一条 bot 回我
    events = [
        RawMessageEvent(id=f"noise-{i}", chat_id=-1, msg_id=1000 + i, text="嘿嘿",
                        source="", date="", sender_id=99000 + i)
        for i in range(50)
    ]
    events.append(RawMessageEvent(id="me1", chat_id=-1, msg_id=2000, text=".我的灵根",
                                   source="", date="", sender_id=12345))
    events.append(RawMessageEvent(id="bot1", chat_id=-1, msg_id=2001, text="你的灵根:玄灵根",
                                   source="", date="", sender_id=-100, reply_to_msg_id=2000))
    events.append(RawMessageEvent(id="bot-other", chat_id=-1, msg_id=2002, text="你的灵根:火灵根",
                                   source="", date="", sender_id=-100, reply_to_msg_id=1010))
    for ev in events:
        store.ingest_event(ev)

    server = MiniWebServer(store=store)
    payload = server.messages_payload("all", limit=200, mode="solo")
    ids = {m["id"] for m in payload["messages"]}
    assert "me1" in ids
    assert "bot1" in ids
    assert "bot-other" not in ids
    assert all(not m["id"].startswith("noise-") for m in payload["messages"])
    assert payload["mode"] == "solo"


def test_parent_arriving_after_bot_reply_reclassifies_mine_relation(tmp_path):
    """miniweb 主动发送时可能先收到 bot reply,后写 outgoing 父消息。

    父消息补齐后,直接回复它的 bot 卡片必须补上「我的/回复我」关系。
    是否进 focus 由功能频道、风险、动作和关键词另行决定。
    """
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({
        "game_bot_ids": [-100],
        "archive_bot_replies": False,
        "focus_keywords": [],
    })
    store.save_identity({"send_as_id": 12345, "label": "me"})

    reply = RawMessageEvent(
        id="bot-reply",
        chat_id=-1,
        msg_id=11,
        text="【宗门战况】\n战役 #9",
        source="韩天尊",
        date="",
        sender_id=-100,
        reply_to_msg_id=10,
        sender_is_bot=True,
    )
    parent = RawMessageEvent(
        id="mine",
        chat_id=-1,
        msg_id=10,
        text=".宗门战况",
        source="me",
        date="",
        sender_id=12345,
    )

    store.ingest_event(reply)
    before = store.get_card("bot-reply")[1]
    assert "focus" not in before.channels

    store.ingest_event(parent)

    after = store.get_card("bot-reply")[1]
    assert "mine" in after.channels
    assert "回复我" in after.tags


def test_messages_before_seq_returns_older(tmp_path):
    """before_seq 给「日志 modal 加载更早」用,返 rowid < before_seq 的卡片。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    for i in range(10):
        store.ingest_event(RawMessageEvent(
            id=f"e-{i}", chat_id=-1, msg_id=1000 + i, text=f"#{i}",
            source="", date="", sender_id=99,
        ))
    server = MiniWebServer(store=store)
    first = server.messages_payload("all", limit=3)
    assert len(first["messages"]) == 3
    oldest_seq = min(m["seq"] for m in first["messages"])
    page2 = server.messages_payload("all", limit=3, before_seq=oldest_seq)
    page2_seqs = {m["seq"] for m in page2["messages"]}
    assert page2_seqs and max(page2_seqs) < oldest_seq


def test_messages_export_jsonl_returns_full_dataset(tmp_path):
    """日志 modal 的「导出」端点:无 limit 全量,jsonl 格式每行一个卡片。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    for i in range(5):
        store.ingest_event(RawMessageEvent(
            id=f"e-{i}", chat_id=-1, msg_id=1000 + i, text=f"msg {i}",
            source="", date="", sender_id=99,
        ))
    server = MiniWebServer(store=store)
    result = server.messages_export_payload("all", fmt="jsonl")
    assert "body" in result and isinstance(result["body"], bytes)
    assert "ndjson" in result["content_type"]
    lines = result["body"].decode("utf-8").strip().split("\n")
    assert len(lines) == 5
    import json as _json
    parsed = [_json.loads(line) for line in lines]
    assert {p["id"] for p in parsed} == {f"e-{i}" for i in range(5)}
    # 文件名带时间戳和 mode/channel
    assert result["filename"].startswith("xiuxian-messages-")
    assert result["filename"].endswith(".jsonl")


def test_messages_export_csv_has_header_and_rows(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(id="x", chat_id=-1, msg_id=1, text="hi\nyou",
                                        source="", date="", sender_id=42))
    server = MiniWebServer(store=store)
    result = server.messages_export_payload("all", fmt="csv")
    text = result["body"].decode("utf-8")
    assert text.startswith("seq,time,channel,sender_id,chat_id,msg_id,reply_to_msg_id,raw")
    # newline 在 raw 里被转成 \n 字符串,避免破坏 CSV 行
    assert "hi\\nyou" in text
    assert result["filename"].endswith(".csv")


def test_messages_export_solo_filters_to_me(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-100]})
    store.save_identity({"send_as_id": 12345, "label": "me"})
    store.ingest_event(RawMessageEvent(id="me", chat_id=-1, msg_id=1, text="me",
                                        source="", date="", sender_id=12345))
    store.ingest_event(RawMessageEvent(id="other", chat_id=-1, msg_id=2, text="other",
                                        source="", date="", sender_id=99999))
    server = MiniWebServer(store=store)
    result = server.messages_export_payload("all", mode="solo", fmt="jsonl")
    text = result["body"].decode("utf-8")
    assert '"me"' in text
    assert '"other"' not in text
    assert "solo" in result["filename"]


def test_messages_export_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/messages/export" in GET_ROUTES


def test_message_payload_includes_structured_filter_reasons(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-100], "focus_keywords": []})
    store.save_identity({"send_as_id": 12345, "label": "me"})
    store.ingest_event(RawMessageEvent(
        id="me",
        chat_id=-1,
        msg_id=1,
        text=".宗门战况",
        source="me",
        date="",
        sender_id=12345,
    ))
    store.ingest_event(RawMessageEvent(
        id="bot",
        chat_id=-1,
        msg_id=2,
        text="【宗门战况】\n当前无战事。",
        source="韩天尊",
        date="",
        sender_id=-100,
        reply_to_msg_id=1,
        sender_is_bot=True,
    ))

    payload = MiniWebServer(store=store).messages_payload("mine", limit=20)
    bot = next(item for item in payload["messages"] if item["id"] == "bot")
    assert "天尊回复我" in bot["filter_reasons"]
    assert "filter_reasons" not in (bot.get("fields") or {})


def test_dungeon_status_payload_distinguishes_request_from_success(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="open",
        chat_id=-1,
        msg_id=10,
        text="""【虚天殿已开启】
@tinghua01 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 394
其他道友可使用 .加入副本 394 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="request",
        chat_id=-1,
        msg_id=11,
        text=".加入副本 394",
        source="me",
        date="2026-05-15T00:00:01+00:00",
        sender_id=12345,
        reply_to_msg_id=10,
    ))

    before = MiniWebServer(store=store).dungeon_status_payload()
    open_summary = next(item for item in before["summaries"] if item["dungeon_id"] == "394")
    assert open_summary["status_kind"] == "open"
    assert open_summary["join_success"] == []
    cached = store.list_dungeon_rooms()
    assert cached[0]["dungeon_id"] == "394"
    assert cached[0]["payload"]["status_kind"] == "open"

    store.ingest_event(RawMessageEvent(
        id="joined",
        chat_id=-1,
        msg_id=12,
        text="@me 已成功加入副本 394",
        source="韩天尊",
        date="2026-05-15T00:00:02+00:00",
        sender_id=7900199668,
    ))
    after = MiniWebServer(store=store).dungeon_status_payload()
    joined = next(item for item in after["summaries"] if item["dungeon_id"] == "394")
    assert joined["status_kind"] == "joined"
    assert joined["join_success"] == ["me"]


def test_dungeon_status_closes_blood_trial_on_successful_evacuation(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="blood-open",
        chat_id=-1,
        msg_id=520,
        text="""【血色试炼·集结】
@MayaLing 正在召集同伴，准备进入【血色禁地】采药试炼！
房间ID: 520
其他道友可使用 .加入副本 520 加入队伍！(最多 3 人)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="blood-progress",
        chat_id=-1,
        msg_id=521,
        text="""【血色试炼·第一回合】
灵草香气弥漫山谷，队伍正在采药。""",
        source="韩天尊",
        date="2026-05-15T00:01:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="blood-finish",
        chat_id=-1,
        msg_id=522,
        text="""【血色试炼·撤离成功】
队伍成功带着灵草撤离血色禁地。""",
        source="韩天尊",
        date="2026-05-15T00:02:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1, order="recent")
    summary = payload["summaries"][0]
    assert summary["dungeon_id"] == "520"
    assert summary["status_kind"] == "closed"
    assert summary["status"] == "撤离成功"
    assert summary["actions"] == []


def test_dungeon_status_ignores_stale_room_cache_without_cache_version(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="blood-open-stale-cache",
        chat_id=-1,
        msg_id=530,
        text="""【血色试炼·集结】
@MayaLing 正在召集同伴，准备进入【血色禁地】采药试炼！
房间ID: 530
其他道友可使用 .加入副本 530 加入队伍！(最多 3 人)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="blood-finish-stale-cache",
        chat_id=-1,
        msg_id=531,
        text="""【血色试炼·撤离成功】
队伍成功带着灵草撤离血色禁地。""",
        source="韩天尊",
        date="2026-05-15T00:02:00+00:00",
        sender_id=7900199668,
    ))
    store.replace_dungeon_rooms([
        {
            "key": "id:530",
            "dungeon_id": "530",
            "dungeon_name": "血色试炼",
            "status": "进行中",
            "status_kind": "active",
            "latest_seq": store.max_dungeon_card_seq(),
            "latest_message_id": "blood-finish-stale-cache",
            "latest_time": "2026-05-15T00:02:00+00:00",
            "latest_stage": "撤离成功",
            "actions": [{"command": ".加入副本 530"}],
        }
    ])

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1, order="recent")
    summary = payload["summaries"][0]
    assert payload["source"] == "derived_from_messages"
    assert summary["dungeon_id"] == "530"
    assert summary["status_kind"] == "closed"
    assert summary["actions"] == []


def test_dungeon_status_hydrates_join_only_room_from_open_announcement(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="stale-open",
        chat_id=-1,
        msg_id=5,
        text="""【黄龙山已开启】
@old 消耗了【黄龙令】，开启了前往黄龙山的传送门！
副本ID: 683
其他道友可使用 .加入副本 683 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-14T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="open",
        chat_id=-1,
        msg_id=10,
        text="""【虚天殿已开启】
@tinghua01 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 683
其他道友可使用 .加入副本 683 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="joined",
        chat_id=-1,
        msg_id=99,
        text="@WalterWA2000 已成功加入副本 683",
        source="韩天尊",
        date="2026-05-15T00:09:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=1)
    summary = next(item for item in payload["summaries"] if item["dungeon_id"] == "683")

    assert summary["status_kind"] == "joined"
    assert summary["dungeon_name"] == "虚天殿"
    assert summary["context_source"] == "open_lookup"


def test_dungeon_status_links_no_id_progress_to_recent_open_room(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="open-701",
        chat_id=-1,
        msg_id=10,
        text="""【虚天殿已开启】
@a 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 701
其他道友可使用 .加入副本 701 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="progress-701",
        chat_id=-1,
        msg_id=11,
        text="队伍已进入虚天殿，前殿禁制隐隐发光。",
        source="韩天尊",
        date="2026-05-15T00:01:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="open-702",
        chat_id=-1,
        msg_id=20,
        text="""【虚天殿已开启】
@b 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 702
其他道友可使用 .加入副本 702 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T01:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="progress-702",
        chat_id=-1,
        msg_id=21,
        text="队伍已进入虚天殿，鼎前灵压骤然升起。",
        source="韩天尊",
        date="2026-05-15T01:01:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10)
    by_id = {item["dungeon_id"]: item for item in payload["summaries"] if item["dungeon_id"]}

    assert {message["id"] for message in by_id["701"]["messages"]} == {"open-701", "progress-701"}
    assert {message["id"] for message in by_id["702"]["messages"]} == {"open-702", "progress-702"}
    assert all(not item["key"].startswith("name:虚天殿") for item in payload["summaries"])


def test_dungeon_status_lookup_links_progress_when_open_outside_window(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="open-703",
        chat_id=-1,
        msg_id=30,
        text="""【虚天殿已开启】
@c 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 703
其他道友可使用 .加入副本 703 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T02:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="progress-703",
        chat_id=-1,
        msg_id=31,
        text="队伍已进入虚天殿，卦象验阵正在展开。",
        source="韩天尊",
        date="2026-05-15T02:05:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=1)
    summary = payload["summaries"][0]

    assert summary["key"] == "id:703"
    assert summary["dungeon_id"] == "703"
    assert summary["context_source"] == "open_lookup"
    assert summary["open_message_id"] == "open-703"


def test_dungeon_status_payload_can_limit_visible_summaries(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    for idx in range(3):
        room_id = 800 + idx
        store.ingest_event(RawMessageEvent(
            id=f"open-{room_id}",
            chat_id=-1,
            msg_id=room_id,
            text=f"""【虚天殿已开启】
@u{idx} 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: {room_id}
其他道友可使用 .加入副本 {room_id} 加入队伍！(5人满)""",
            source="韩天尊",
            date=f"2026-05-15T0{idx}:00:00+00:00",
            sender_id=7900199668,
        ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=2)

    assert payload["total_summaries"] == 3
    assert len(payload["summaries"]) == 2


def test_dungeon_status_recent_order_prefers_latest_room(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="open-900",
        chat_id=-1,
        msg_id=900,
        text="""【虚天殿已开启】
@old 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 900
其他道友可使用 .加入副本 900 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="choice-900",
        chat_id=-1,
        msg_id=901,
        text="【鼎前抉择】\n队伍已进入虚天殿。\n使用 .争鼎 求稳 / .争鼎 夺鼎 继续。",
        source="韩天尊",
        date="2026-05-15T00:10:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="open-901",
        chat_id=-1,
        msg_id=910,
        text="""【虚天殿已开启】
@new 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 901
其他道友可使用 .加入副本 901 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T01:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="active-901",
        chat_id=-1,
        msg_id=911,
        text="你们选定了 【焚炎秘径】。\n当前阵策：稳。",
        source="韩天尊",
        date="2026-05-15T01:10:00+00:00",
        sender_id=7900199668,
    ))

    priority = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1)
    recent = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1, order="recent")

    assert priority["summaries"][0]["dungeon_id"] == "900"
    assert priority["context_mode"] == "full_lookup"
    assert recent["summaries"][0]["dungeon_id"] == "901"
    assert recent["context_mode"] in {"fast_window", "cache"}


def test_dungeon_status_recent_visible_skips_orphan_attempts(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="open-727",
        chat_id=-1,
        msg_id=7270,
        text="""【虚天殿已开启】
@a 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 727
其他道友可使用 .加入副本 727 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-20T07:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="open-728",
        chat_id=-1,
        msg_id=7280,
        text="""【虚天殿已开启】
@b 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 728
其他道友可使用 .加入副本 728 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-20T09:15:49+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="closed-728",
        chat_id=-1,
        msg_id=7281,
        text="队长 @b 已将副本房间（ID: 728）解散。\n因副本未曾开启，天道已将【虚天残图】归还至你的储物袋中。",
        source="韩天尊",
        date="2026-05-20T09:16:35+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="open-729",
        chat_id=-1,
        msg_id=7290,
        text="""【虚天殿已开启】
@c 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 729
其他道友可使用 .加入副本 729 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-20T09:37:48+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="closed-729",
        chat_id=-1,
        msg_id=7291,
        text="队长 @c 已将副本房间（ID: 729）解散。\n因副本未曾开启，天道已将【虚天残图】归还至你的储物袋中。",
        source="韩天尊",
        date="2026-05-20T09:38:20+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="late-join-729",
        chat_id=-1,
        msg_id=7292,
        text="@late 已成功加入副本 729！",
        source="韩天尊",
        date="2026-05-20T09:38:20+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="failed-728",
        chat_id=-1,
        msg_id=7293,
        text="找不到此副本房间，可能已解散或ID错误。",
        source="韩天尊",
        date="2026-05-20T09:40:52+00:00",
        sender_id=7900199668,
        reply_to_msg_id=7292,
    ))
    store.ingest_event(RawMessageEvent(
        id="orphan-join-737",
        chat_id=-1,
        msg_id=7370,
        text="@x 已成功加入副本 737！\n当前队伍 (2/5):\n - @opener (破军)\n - @x (影刃)",
        source="韩天尊",
        date="2026-05-20T13:42:11+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="orphan-closed-737",
        chat_id=-1,
        msg_id=7371,
        text="队长 @opener 已将副本房间（ID: 737）解散。\n因副本未曾开启，天道已将【虚天残图】归还至你的储物袋中。",
        source="韩天尊",
        date="2026-05-20T13:42:20+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=20, summary_limit=3, order="recent")

    assert [item["dungeon_id"] for item in payload["summaries"]] == ["729", "728", "727"]
    by_id = {item["dungeon_id"]: item for item in payload["summaries"]}
    assert by_id["729"]["status_kind"] == "closed"

    MiniWebServer(store=store).dungeon_status_payload(limit=20, summary_limit=20, order="recent")
    rooms = {item["dungeon_id"]: item["payload"] for item in store.list_dungeon_rooms() if item["dungeon_id"]}
    assert rooms["737"]["open_seq"] == 0
    assert rooms["737"]["open_message_id"] == ""


def test_dungeon_status_exposes_xutian_verdict_and_advice(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="open-777",
        chat_id=-1,
        msg_id=777,
        text="""【虚天殿已开启】
@boxboxji 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 777
其他道友可使用 .加入副本 777 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-15T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="oracle-777",
        chat_id=-1,
        msg_id=778,
        text="""【卦象验阵】
【卦象词条】 兑泽上离火下 · 四爻转阵
- 行运：后续道路与阵策同样受卦象牵引，但不会直示吉路与吉策。
- 当前契合：顺卦 (阵骨 已立 | 主锋 2/2)""",
        source="韩天尊",
        date="2026-05-15T00:01:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="verdict-777",
        chat_id=-1,
        msg_id=779,
        text="""【极寒冰魄】的光芒被成功压制！冰火炼心阵威力大减，你们通过了第二关的考验。
阵策【稳扎稳打】额外稳住了队伍心气，第三关再获 +8% 士气。
你们此轮路策顺合卦意，第三关开局士气额外 +5%。""",
        source="韩天尊",
        date="2026-05-15T00:02:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1, order="recent")
    summary = payload["summaries"][0]

    assert summary["dungeon_id"] == "777"
    assert summary["oracle"] == "兑泽上离火下 · 四爻转阵"
    assert summary["advice"] == "冰路 / 稳策"
    assert summary["advice_confidence"] == "实测顺合"
    assert summary["team_fit"].startswith("顺卦")
    assert summary["route_verdict"] == "顺合"
    assert summary["positive_examples"]


def test_dungeon_status_links_cangkun_progress_to_room(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="cangkun-open",
        chat_id=-1,
        msg_id=1500,
        text="""【苍坤上人洞府·集结】
@takaranoao_bot 以【苍坤残图】锁定了太妙神禁的薄弱方位！
房间ID: 15
其他道友可使用 .加入苍坤洞府 15 加入队伍！(5人满)
队长可在满员后使用 .进入苍坤洞府。""",
        source="韩天尊",
        date="2026-05-21T21:34:50+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="cangkun-choice",
        chat_id=-1,
        msg_id=1501,
        text="""【苍坤上人洞府·第一幕】
持识者：@cupaopao | 可调神识：22546

1 · 匿踪潜行：压低气机。
2 · 伪装混入：借杂乱灵息。
3 · 强闯速进：强行破禁。

请队长使用 .苍坤抉择 1/2/3 做出第一步选择。""",
        source="韩天尊",
        date="2026-05-21T21:40:50+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1, order="recent")
    summary = payload["summaries"][0]

    assert summary["dungeon_id"] == "15"
    assert summary["dungeon_name"] == "苍坤上人洞府"
    assert summary["latest_stage"] == "第一幕"
    assert summary["status_kind"] == "choice"
    assert summary["cangkun_advice"]["stage"] == "第一幕"
    assert summary["cangkun_advice"]["command"] == ".苍坤抉择 1"
    assert summary["cangkun_advice"]["label"] == "匿踪潜行"
    assert [action["command"] for action in summary["actions"][:3]] == [
        ".苍坤抉择 1",
        ".苍坤抉择 2",
        ".苍坤抉择 3",
    ]


def test_dungeon_status_updates_cangkun_latest_stage_and_state(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="cangkun-open-16",
        chat_id=-1,
        msg_id=1510,
        text="""【苍坤上人洞府·集结】
@takaranoao_bot 以【苍坤残图】锁定了太妙神禁的薄弱方位！
房间ID: 16
其他道友可使用 .加入苍坤洞府 16 加入队伍！(5人满)
队长可在满员后使用 .进入苍坤洞府。""",
        source="韩天尊",
        date="2026-05-23T00:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="cangkun-first-16",
        chat_id=-1,
        msg_id=1511,
        text="""【苍坤上人洞府·第一幕】
1 · 匿踪潜行：压低气机。
2 · 伪装混入：借杂乱灵息。
3 · 强闯速进：强行破禁。
请队长使用 .苍坤抉择 1/2/3 做出第一步选择。""",
        source="韩天尊",
        date="2026-05-23T00:01:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="cangkun-fifth-16",
        chat_id=-1,
        msg_id=1512,
        text="""【苍坤上人洞府·第五幕】
禁制裂隙106 / 神魂稳度104 / 慕兰警戒49 / 贪念18 / 卷轴线索3

1 · 平分速退：就此撤离。
2 · 夺图先遁：抢下图卷先走。
3 · 暗藏后手：冒险再贪一手。

请队长使用 .苍坤抉择 1/2/3 做出最后选择。""",
        source="韩天尊",
        date="2026-05-23T00:02:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=20, summary_limit=1, order="recent")
    summary = payload["summaries"][0]

    assert summary["dungeon_id"] == "16"
    assert summary["latest_stage"] == "第五幕"
    assert summary["cangkun_state"]["禁制裂隙"] == "106"
    assert summary["cangkun_state"]["卷轴线索"] == "3"
    assert summary["cangkun_advice"]["stage"] == "第五幕"
    assert summary["cangkun_advice"]["command"] == ".苍坤抉择 2"
    assert summary["cangkun_advice"]["avoid"] == ".苍坤抉择 3"
    assert ["禁制裂隙", "106"] in summary["cangkun_advice"]["state_rows"]
    assert ["卷轴线索", "3"] in summary["cangkun_advice"]["state_rows"]
    assert [action["source_message_id"] for action in summary["actions"][:3]] == [
        "cangkun-fifth-16",
        "cangkun-fifth-16",
        "cangkun-fifth-16",
    ]


def test_dungeon_status_does_not_merge_cangkun_messages_after_final_state(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="cangkun-open-reused-16",
        chat_id=-1,
        msg_id=1520,
        text="""【苍坤上人洞府·集结】
@hfsscxf 以【苍坤残图】锁定了太妙神禁的薄弱方位！
房间ID: 16
其他道友可使用 .加入苍坤洞府 16 加入队伍！(5人满)
队长可在满员后使用 .进入苍坤洞府。""",
        source="韩天尊",
        date="2026-05-23T01:00:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="cangkun-final-reused-16",
        chat_id=-1,
        msg_id=1521,
        text="""【苍坤上人洞府·脱身成功】
通关保底：每位队员获得 6256修为、555贡献。
最终禁制裂隙：106 | 神魂稳度：104 | 慕兰警戒：49 | 贪念：18 | 卷轴线索：3""",
        source="韩天尊",
        date="2026-05-23T01:08:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="cangkun-new-first-after-final",
        chat_id=-1,
        msg_id=1522,
        text="""【苍坤上人洞府·第一幕】
1 · 匿踪潜行：压低气机。
2 · 伪装混入：借杂乱灵息。
3 · 强闯速进：强行破禁。
请队长使用 .苍坤抉择 1/2/3 做出第一步选择。""",
        source="韩天尊",
        date="2026-05-23T01:12:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="cangkun-reopen-same-id-16",
        chat_id=-1,
        msg_id=1523,
        text="""【苍坤上人洞府·集结】
@GinJ_6600 以【苍坤残图】锁定了太妙神禁的薄弱方位！
房间ID: 16
其他道友可使用 .加入苍坤洞府 16 加入队伍！(5人满)
队长可在满员后使用 .进入苍坤洞府。""",
        source="韩天尊",
        date="2026-05-23T01:15:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=20, summary_limit=20, order="recent")
    summaries = payload["summaries"]
    closed = next(item for item in summaries if item["key"] == "id:16")
    late = next(item for item in summaries if item["latest_message_id"] == "cangkun-new-first-after-final")
    reopened = next(item for item in summaries if item["latest_message_id"] == "cangkun-reopen-same-id-16")

    assert closed["status_kind"] == "closed"
    assert closed["status"] == "脱身成功"
    assert closed["latest_message_id"] == "cangkun-final-reused-16"
    assert all(message["id"] != "cangkun-new-first-after-final" for message in closed["messages"])
    assert late["key"].startswith("segment:苍坤上人洞府:")
    assert late["dungeon_id"] == ""
    assert late["status_kind"] == "choice"
    assert reopened["key"].startswith("id:16:open:")
    assert reopened["status_kind"] == "open"


def test_dungeon_status_links_xutian_hou_dian_choice_to_room(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="xutian-open",
        chat_id=-1,
        msg_id=1600,
        text="""【虚天殿已开启】
@cupaopao 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 901
其他道友可使用 .加入副本 901 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-21T22:20:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="xutian-houdian",
        chat_id=-1,
        msg_id=1601,
        text="""【后殿余波】
第三关的战利品已先行封存，后续冲关无论成败，都不会回吐当前已得奖励。
队长 @cupaopao，请在 120秒 内决定是否继续深入后殿：
- 见好就收：就此退去，稳稳带走第三关全部收获
- 继续冲关：开启第四、第五关，去抢后殿追加机缘
- 也可输入 .后殿抉择 收手 / .后殿抉择 冲关""",
        source="韩天尊",
        date="2026-05-21T22:22:18+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=10, summary_limit=1, order="recent")
    summary = payload["summaries"][0]

    assert summary["dungeon_id"] == "901"
    assert summary["dungeon_name"] == "虚天殿"
    assert summary["latest_stage"] == "后殿余波"
    assert summary["status_kind"] == "choice"
    assert [action["command"] for action in summary["actions"][:2]] == [
        ".后殿抉择 收手",
        ".后殿抉择 冲关",
    ]


def test_dungeon_status_closes_xutian_hou_dian_success_and_clears_actions(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(
        id="xutian-success-open",
        chat_id=-1,
        msg_id=1700,
        text="""【虚天殿已开启】
@cupaopao 消耗了【虚天残图】，开启了前往虚天殿的传送门！
副本ID: 902
其他道友可使用 .加入副本 902 加入队伍！(5人满)""",
        source="韩天尊",
        date="2026-05-21T23:20:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="xutian-success-houdian",
        chat_id=-1,
        msg_id=1701,
        text="""【后殿余波】
第三关的战利品已先行封存，后续冲关无论成败，都不会回吐当前已得奖励。
队长 @cupaopao，请在 120秒 内决定是否继续深入后殿：
- 见好就收：就此退去，稳稳带走第三关全部收获
- 继续冲关：开启第四、第五关，去抢后殿追加机缘
- 也可输入 .后殿抉择 收手 / .后殿抉择 冲关""",
        source="韩天尊",
        date="2026-05-21T23:22:18+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="xutian-success-fifth-choice",
        chat_id=-1,
        msg_id=1702,
        text="""【第四关·后殿试阵】
三座残碑正在争抢殿心主权，队长必须先定试阵之法，才能真正摸到后殿炉心。
请在 120秒 内点击按钮，或输入 .后殿阵策 镇/夺/卦：
- 镇碑固脉：以稳阵为先。
- 裂纹夺隙：趁碑纹裂开。
- 借卦逆推：强借本轮卦势。""",
        source="韩天尊",
        date="2026-05-21T23:23:00+00:00",
        sender_id=7900199668,
    ))
    store.ingest_event(RawMessageEvent(
        id="xutian-success-final",
        chat_id=-1,
        msg_id=1703,
        text="""【第五关·鼎灵余焰】 你们硬生生压灭了后殿残焰，逼得鼎灵退散。
所有队员额外获得 2800修为 与 220贡献。
路径余韵回响：每位队员再得 天雷竹x1。
最终鼎压：32 | 最终士气：118%""",
        source="韩天尊",
        date="2026-05-21T23:24:00+00:00",
        sender_id=7900199668,
    ))

    payload = MiniWebServer(store=store).dungeon_status_payload(limit=20, summary_limit=1, order="recent")
    summary = payload["summaries"][0]

    assert summary["dungeon_id"] == "902"
    assert summary["latest_stage"] == "第五关·鼎灵余焰"
    assert summary["status_kind"] == "closed"
    assert summary["status"] == "后殿冲关成功"
    assert summary["actions"] == []


def test_dungeon_status_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/dungeon-status" in GET_ROUTES


def test_xutian_oracle_guide_payload_exposes_cases_and_aliases():
    payload = MiniWebServer().xutian_oracle_guide_payload()

    assert payload["ok"] is True
    assert payload["counts"]["explicit"] > 0
    assert payload["counts"]["success"] > 0
    assert any(item["label"] == "金系" and "雷" in item["values"] for item in payload["element_aliases"])
    assert any(item["gua"] == "兑泽上离火下 · 四爻转阵" for item in payload["cases"]["success"])


def test_xutian_oracle_guide_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/xutian-oracle-guide" in GET_ROUTES


def test_cangkun_guide_payload_exposes_stable_route_and_boundaries():
    payload = MiniWebServer().cangkun_guide_payload()

    assert payload["ok"] is True
    assert payload["default_route"] == "1 -> 1 -> 2"
    assert payload["default_commands"] == [".苍坤抉择 1", ".苍坤抉择 1", ".苍坤抉择 2"]
    assert any(route["route"] == "1 -> 1 -> 3" and route["kind"] == "risk" for route in payload["routes"])
    assert any("前置链路" in note for note in payload["boundaries"])
    fifth = next(stage for stage in payload["stages"] if stage["key"] == "fifth")
    assert fifth["recommendation"]["command"] == ".苍坤抉择 2"
    assert fifth["recommendation"]["avoid"] == ".苍坤抉择 3"


def test_cangkun_guide_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/cangkun-guide" in GET_ROUTES


def test_filter_diagnostics_payload_counts_recent_reasons(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"focus_keywords": ["虚天殿"], "focus_include_player_plain": True})
    store.ingest_event(RawMessageEvent(
        id="plain",
        chat_id=-1,
        msg_id=20,
        text="今晚虚天殿有人吗",
        source="玩家A",
        date="2026-05-15T00:01:00+00:00",
        sender_id=222,
    ))

    payload = MiniWebServer(store=store).filter_diagnostics_payload(limit=20)

    assert payload["ok"] is True
    assert payload["focus_count"] >= 1
    assert any("关键词" in row["reason"] or "普通玩家" in row["reason"] for row in payload["reason_rows"])
    assert any(row["sender_id"] == 222 for row in payload["focus_sender_rows"])


def test_filter_diagnostics_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/filter/diagnostics" in GET_ROUTES


def test_message_audit_payload_includes_deep_sections(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({
        "target_chat": "-1001680975844",
        "target_topic_id": 7310786,
    })
    store.ingest_event(RawMessageEvent(
        id="audit-resource",
        chat_id=-1001680975844,
        msg_id=1,
        text="""【野外历练 · 灵机暗藏】
@salt9527 在山涧残阵旁避开妖兽踪迹，采得一份机缘。
获得修为 +12000，获得 【灵石】x399。""",
        source="韩天尊",
        date="2026-05-15T12:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    ))
    store.ingest_event(RawMessageEvent(
        id="audit-focus",
        chat_id=-1001680975844,
        msg_id=2,
        text="今晚虚天殿有人吗",
        source="玩家A",
        date="2026-05-15T12:01:00+00:00",
        sender_id=222,
    ))

    payload = MiniWebServer(store=store).message_audit_payload(deep=True)

    assert payload["deep"] is True
    assert "resource_coverage" in payload
    assert "filter_diagnostics" in payload
    assert "dungeon_audit" in payload
    assert payload["resource_coverage"]["ok"] is True
    assert payload["filter_diagnostics"]["ok"] is True


def test_message_audit_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/message-audit" in GET_ROUTES


def test_list_schedule_batches_returns_sending_and_completed(tmp_path):
    """新生命周期(sending/completed/cancelled/partial_failed)默认要可见,
    UI 才能显示进度 pill 和取消按钮。只有 deleted 默认隐藏。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    # 创建几个 batch,标不同状态
    server.schedule_create_payload({
        "send_as_id": 12345, "preset_key": "custom", "command": ".签到",
        "interval_sec": 60, "count": 1, "dry_run": True,
    })
    bid = store.list_schedule_batches(include_inactive=True)[0]["id"]
    store.set_schedule_batch_status(bid, "sending")
    visible = store.list_schedule_batches()
    assert any(b["id"] == bid and b["status"] == "sending" for b in visible)

    store.set_schedule_batch_status(bid, "completed")
    visible = store.list_schedule_batches()
    assert any(b["id"] == bid and b["status"] == "completed" for b in visible)

    store.set_schedule_batch_status(bid, "cancelled")
    visible = store.list_schedule_batches()
    assert any(b["id"] == bid and b["status"] == "cancelled" for b in visible)

    store.set_schedule_batch_status(bid, "deleted")
    visible = store.list_schedule_batches()
    assert not any(b["id"] == bid for b in visible), "deleted 默认要隐藏"
    visible_all = store.list_schedule_batches(include_inactive=True)
    assert any(b["id"] == bid for b in visible_all)


def test_background_send_loop_preserves_cancelled_status(tmp_path):
    """关键回归:用户 cancel 后,后台 loop 退出时的 finally 块不能
    把状态覆盖成 completed —— 否则 UI 看着像「批次复活」。"""
    import asyncio
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_settings_payload({"target_chat": "-1001680975844", "target_topic_id": 7310786})
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    server.schedule_create_payload({
        "send_as_id": 12345, "preset_key": "custom", "command": ".签到",
        "interval_sec": 60, "count": 3, "dry_run": True,
    })
    bid = store.list_schedule_batches(include_inactive=True)[0]["id"]

    # 模拟用户 cancel
    store.set_schedule_batch_status(bid, "cancelled")

    # 模拟后台 loop 的 finally:用 fake send_as 走 prechecks 失败路径
    # 调度方法做了「先看当前状态」保护,所以应当保持 cancelled
    fake_client = object()
    class FakeSendAs:
        async def list_send_as_peers_on_client(self, client, chat):
            return {"peers": [{"send_as_id": 12345}]}
    server._send_as = FakeSendAs()  # 让 precheck 通过
    # peer/get_input_entity 会失败,导致全部条目标失败,但 cancelled 保护应早退
    # 直接调 _run_official_send_background,会在 get_input_entity 抛错 → 进 finally
    msgs = store.list_schedule_messages(batch_id=bid, include_inactive=False)
    asyncio.run(server._run_official_send_background(
        fake_client, bid, "-1001680975844", 7310786, 12345, msgs
    ))
    # 状态应仍是 cancelled,不要被 finally 覆盖成 completed/failed
    final = next(b for b in store.list_schedule_batches(include_inactive=True) if b["id"] == bid)
    assert final["status"] == "cancelled", f"finally 错误覆盖了 cancelled → {final['status']}"


def test_official_schedule_background_records_success_send_log(tmp_path):
    import asyncio
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    batch_id = store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [{"command": ".签到", "schedule_at": time.time() + 3600, "status": "planned"}],
    )
    messages = store.list_schedule_messages(batch_id=batch_id, include_inactive=False)

    class FakeClient:
        async def get_input_entity(self, value):
            return f"peer:{value}"

    class FakeSendAs:
        async def list_send_as_peers_on_client(self, client, chat):
            return {"peers": [{"send_as_id": 12345}]}

    class FakeSchedule:
        async def create_one_on_client(self, client, *, peer, send_as_peer, reply_to, command, schedule_at):
            assert peer == "peer:-1001680975844"
            assert send_as_peer == "peer:12345"
            assert command == ".签到"
            return 99001

    server._send_as = FakeSendAs()
    server._schedule = FakeSchedule()

    asyncio.run(server._run_official_send_background(
        FakeClient(), batch_id, "-1001680975844", 7310786, 12345, messages
    ))

    refreshed = store.list_schedule_messages(batch_id=batch_id, include_inactive=True)[0]
    logs = store.list_send_logs(kind="official_schedule", batch_id=batch_id)
    batch = store.list_schedule_batches(include_inactive=True)[0]
    assert refreshed["status"] == "scheduled"
    assert refreshed["scheduled_msg_id"] == 99001
    assert batch["status"] == "completed"
    assert len(logs) == 1
    assert logs[0]["status"] == "scheduled"
    assert logs[0]["scheduled_msg_id"] == 99001
    assert logs[0]["schedule_message_id"] == refreshed["id"]
    assert logs[0]["meta"]["schedule_at"] == refreshed["schedule_at"]


def test_official_schedule_background_records_failed_send_log_for_invalid_item(tmp_path):
    import asyncio
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    batch_id = store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [{"command": "", "schedule_at": 0, "status": "planned"}],
    )
    messages = store.list_schedule_messages(batch_id=batch_id, include_inactive=False)

    class FakeClient:
        async def get_input_entity(self, value):
            return f"peer:{value}"

    class FakeSendAs:
        async def list_send_as_peers_on_client(self, client, chat):
            return {"peers": [{"send_as_id": 12345}]}

    class FakeSchedule:
        async def create_one_on_client(self, *_args, **_kwargs):
            raise AssertionError("invalid item should fail before Telegram scheduling")

    server._send_as = FakeSendAs()
    server._schedule = FakeSchedule()

    asyncio.run(server._run_official_send_background(
        FakeClient(), batch_id, "-1001680975844", 7310786, 12345, messages
    ))

    refreshed = store.list_schedule_messages(batch_id=batch_id, include_inactive=True)[0]
    logs = store.list_send_logs(kind="official_schedule", status="failed", batch_id=batch_id)
    batch = store.list_schedule_batches(include_inactive=True)[0]
    assert refreshed["status"] == "failed"
    assert refreshed["last_error"] == "命令或时间无效"
    assert batch["status"] == "failed"
    assert len(logs) == 1
    assert logs[0]["schedule_message_id"] == refreshed["id"]
    assert logs[0]["error"] == "命令或时间无效"


def test_official_schedule_background_stops_on_telegram_quota_error(tmp_path):
    import asyncio
    import time

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    batch_id = store.create_schedule_batch(
        {
            "send_as_id": 12345,
            "account_local_id": "main",
            "preset_key": "custom",
            "label": "自定义",
            "anchor_at": time.time(),
            "horizon_days": 1,
            "options": {},
        },
        [
            {"command": f".签到{i}", "schedule_at": time.time() + i * 3600, "status": "planned"}
            for i in range(3)
        ],
    )
    messages = store.list_schedule_messages(batch_id=batch_id, include_inactive=False)

    class FakeClient:
        async def get_input_entity(self, value):
            return f"peer:{value}"

    class FakeSendAs:
        async def list_send_as_peers_on_client(self, client, chat):
            return {"peers": [{"send_as_id": 12345}]}

    class ScheduleTooMuchError(Exception):
        pass

    class FakeSchedule:
        def __init__(self):
            self.calls = 0

        async def create_one_on_client(self, *_args, **_kwargs):
            self.calls += 1
            raise ScheduleTooMuchError("You have reached the 100 scheduled messages limit")

    fake_schedule = FakeSchedule()
    server._send_as = FakeSendAs()
    server._schedule = fake_schedule

    asyncio.run(server._run_official_send_background(
        FakeClient(), batch_id, "-1001680975844", 7310786, 12345, messages
    ))

    refreshed = store.list_schedule_messages(batch_id=batch_id, include_inactive=True)
    logs = store.list_send_logs(kind="official_schedule", status="failed", batch_id=batch_id)
    batch = store.list_schedule_batches(include_inactive=True)[0]
    assert fake_schedule.calls == 1
    assert batch["status"] == "failed"
    assert [m["status"] for m in refreshed] == ["failed", "failed", "failed"]
    assert all("单身份上限" in m["last_error"] for m in refreshed)
    assert len(logs) == 3


def test_schedule_deep_retreat_pacing_is_non_linear_paired():
    """新节奏:trigger → command 配对,下一对 = 上一对 command + 8h + jitter,
    不是死按 anchor + N*8h 节拍。验证相邻两对的 trigger 间距落在 8h ± 5min。"""
    from backend.outbox.schedule import build_plan, DEEP_RETREAT_CD, JITTER_MAX_SEC
    import time
    now = time.time()
    plan = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 5})
    items = plan["items"]
    # 偶数索引是 trigger,奇数是 command
    triggers = [it for i, it in enumerate(items) if i % 2 == 0]
    commands = [it for i, it in enumerate(items) if i % 2 == 1]
    assert len(triggers) == len(commands) >= 4
    # 第二个 trigger 应该落在 first command + 8h + 0~2*JITTER_MAX 之间
    gap = triggers[1]["schedule_at"] - commands[0]["schedule_at"]
    assert DEEP_RETREAT_CD <= gap <= DEEP_RETREAT_CD + 2 * JITTER_MAX_SEC + 5, gap
    # trigger 和它紧跟的 command 之间间距 ~ 4min(240s + jitter)
    pair_gap = commands[0]["schedule_at"] - triggers[0]["schedule_at"]
    assert 240 <= pair_gap <= 240 + JITTER_MAX_SEC + 5, pair_gap


def test_schedule_deep_retreat_trigger_command_is_customizable():
    """触发词允许用户改成自定义,如「闭关结束」。"""
    from backend.outbox.schedule import build_plan
    plan = build_plan({"preset_key": "deep_retreat", "horizon_days": 1, "trigger_command": "闭关结束"})
    triggers = [it for i, it in enumerate(plan["items"]) if i % 2 == 0]
    assert triggers and all(t["command"] == "闭关结束" for t in triggers)
    cmds = [it for i, it in enumerate(plan["items"]) if i % 2 == 1]
    assert all(c["command"] == ".深度闭关" for c in cmds)


def test_schedule_horizon_days_is_capped_at_seven():
    from backend.outbox.schedule import MAX_HORIZON_DAYS, build_plan

    plan = build_plan(
        {
            "preset_key": "custom",
            "horizon_days": 30,
            "command": ".签到",
            "interval_sec": 3600,
            "count": 1,
        }
    )

    assert MAX_HORIZON_DAYS == 7
    assert plan["horizon_days"] == 7


def test_schedule_offset_minutes_shifts_entire_batch():
    """多账号错峰:offset_minutes 把整批往后推 N 分钟。"""
    from backend.outbox.schedule import build_plan
    import time
    now = time.time()
    p0 = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 1})
    p7 = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 1, "offset_minutes": 7})
    # 第一条 trigger 至少差 7*60 - jitter 容差(因为 jitter 是独立采样)
    delta = p7["items"][0]["schedule_at"] - p0["items"][0]["schedule_at"]
    assert 6 * 60 <= delta <= 8 * 60 + 60, f"delta={delta}"


def test_schedule_offset_minutes_clamped_to_safe_range():
    from backend.outbox.schedule import build_plan
    import time
    now = time.time()
    # 负值 / 太大都被夹回 [0, 720]
    p_neg = build_plan({"preset_key": "custom", "anchor_at": now, "command": ".x",
                         "interval_sec": 60, "count": 1, "offset_minutes": -100})
    p_huge = build_plan({"preset_key": "custom", "anchor_at": now, "command": ".x",
                          "interval_sec": 60, "count": 1, "offset_minutes": 9999})
    # 不会抛,且 huge 的 anchor 比 neg 后推了至少 11h
    delta = p_huge["items"][0]["schedule_at"] - p_neg["items"][0]["schedule_at"]
    assert delta >= 720 * 60 - 120


def test_schedule_pet_periodic_supports_optional_trigger():
    """法宝类(抚摸 / 温养 / 试炼)也允许配 trigger_command,
    留空 = 跟以前一样只发 command。"""
    from backend.outbox.schedule import build_plan
    # 不配 trigger:每次只一条
    no_trig = build_plan({"preset_key": "pet_warm", "horizon_days": 1, "pet_name": "破剑"})
    cmds_only = [it["command"] for it in no_trig["items"]]
    assert all(c == ".温养器灵 破剑" for c in cmds_only)
    # 配上 trigger:每次两条
    with_trig = build_plan({"preset_key": "pet_warm", "horizon_days": 1,
                              "pet_name": "破剑", "trigger_command": "查看温养"})
    assert len(with_trig["items"]) == 2 * len(no_trig["items"])
    triggers = [it["command"] for i, it in enumerate(with_trig["items"]) if i % 2 == 0]
    assert all(t == "查看温养" for t in triggers)


def test_schedule_dedupe_seconds_avoids_global_collision(tmp_path):
    """两个 batch 创建到同一秒 → 第二个的撞秒条目应被推后 1 秒以上。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    # 先创建一批 dry_run,记录它的 schedule_at 秒
    r1 = server.schedule_create_payload({
        "send_as_id": 12345, "preset_key": "custom", "command": ".签到",
        "interval_sec": 60, "count": 3, "dry_run": True,
    })
    assert r1["ok"]
    used1 = {int(float(m["schedule_at"])) for m in store.list_schedule_messages(batch_id=r1["batch_id"])}

    # 第二批用同样参数:jitter 不同,但有概率撞同秒。强制构造撞:
    # 直接调 _dedupe_schedule_seconds 验证撞秒会被推后。
    fake_items = [
        {"command": ".x", "schedule_at": float(next(iter(used1))), "status": "planned", "scheduled_msg_id": 0},
        {"command": ".y", "schedule_at": float(next(iter(used1))), "status": "planned", "scheduled_msg_id": 0},
    ]
    adjusted = server._dedupe_schedule_seconds(fake_items)
    assert adjusted == 2
    new_secs = {int(float(it["schedule_at"])) for it in fake_items}
    assert not new_secs & used1, "调整后不应再跟现有秒撞"
    assert len(new_secs) == 2, "两条调整后也不能互相撞"


def test_schedule_create_batch_creates_one_per_identity(tmp_path):
    """send_as_ids 多选 → 每个身份一个 batch,offset 按阶梯递增。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "100"})
    for sid in [101, 102, 103]:
        server.save_identity_payload({"send_as_id": str(sid), "account_local_id": "main"})

    result = server.schedule_create_payload({
        "send_as_ids": [101, 102, 103],
        "preset_key": "custom",
        "command": ".签到",
        "interval_sec": 60,
        "count": 1,
        "dry_run": True,
        "offset_minutes": 0,
        "offset_step_minutes": 5,
    })
    assert result["batch_count"] == 3
    assert result["succeeded"] == 3
    # 阶梯生效:三个 batch 的 offset_minutes_applied 应该是 0/5/10
    offsets = sorted(r["offset_minutes_applied"] for r in result["results"])
    assert offsets == [0, 5, 10]
    # DB 里有 3 个 batch
    batches = store.list_schedule_batches(include_inactive=True)
    assert len(batches) == 3
    assert {b["send_as_id"] for b in batches} == {101, 102, 103}


def test_schedule_create_single_id_falls_back_to_legacy_shape(tmp_path):
    """传 send_as_id(单数)还是走老路径,返单数响应(兼容)。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "200"})
    server.save_identity_payload({"send_as_id": "200", "account_local_id": "main"})

    result = server.schedule_create_payload({
        "send_as_id": 200,
        "preset_key": "custom",
        "command": ".x",
        "interval_sec": 60,
        "count": 1,
        "dry_run": True,
    })
    assert result["ok"] is True
    assert "batch_id" in result
    assert "batch_count" not in result


def test_schedule_create_empty_ids_returns_error():
    """既没 send_as_id 也没 send_as_ids → 错误提示。"""
    from backend.repo.sqlite_store import SQLiteStore
    import tempfile, pathlib
    tmp = pathlib.Path(tempfile.mkdtemp()) / "m.db"
    store = SQLiteStore(tmp)
    server = MiniWebServer(store=store)
    result = server.schedule_create_payload({"preset_key": "custom", "command": ".x"})
    assert result["ok"] is False
    assert "identity" in result["error"]


# ---------- 技能盘 ----------

def test_skills_payload_exposes_default_layout():
    """技能盘必须把 6 组(日常/法宝/侍妾/奇遇/玩法/查询)和所有 skill 暴露出去。"""
    from backend.repo.sqlite_store import SQLiteStore
    import tempfile, pathlib
    tmp = pathlib.Path(tempfile.mkdtemp()) / "m.db"
    server = MiniWebServer(store=SQLiteStore(tmp))
    payload = server.skills_payload()
    assert payload["ok"] is True
    assert payload["groups"] == ["日常", "法宝", "侍妾", "奇遇", "玩法", "查询"]
    by_key = {s["key"]: s for s in payload["skills"]}
    assert "deep_retreat" in by_key
    assert by_key["deep_retreat"]["reply_mode"] == "none"
    assert by_key["deep_retreat"]["cd_module"] == "deep_retreat"
    assert by_key["wild_training"]["cd_module"] == "wild_training"
    assert by_key["retreat_shallow"]["cd_module"] == "retreat_shallow"
    assert by_key["pet_trial"]["cd_module"] == "pet_trial"
    assert by_key["tianti_gangfeng"]["cd_module"] == "tianti_gangfeng"
    assert by_key["node_search"]["cd_module"] == "taiyi_cycle"
    # 回复类必须显式标记
    assert by_key["quiz_answer"]["reply_mode"] == "required"
    assert by_key["dungeon_join"]["reply_mode"] == "required"
    assert by_key["dungeon_zhuimo_choice"]["reply_mode"] == "required"
    # 新增的命令必须在
    assert "storage_bag" in by_key  # .储物袋
    assert "concubine_romance" in by_key  # .红尘寻缘
    assert "concubine_sect_marry" in by_key  # .宗门赐婚
    # 查询组里至少要有 储物袋 / 战力 / 我的灵根
    query_skills = {s["key"] for s in payload["skills"] if s["group"] == "查询"}
    assert {"storage_bag", "battle_power", "identity_info"} <= query_skills
    # 手动发送是 UI 内部出口,不能污染底部技能盘分组
    assert "manual_send" not in by_key


def test_manual_send_skill_is_internal_but_registered():
    from backend.skills import SkillRegistry
    registry = SkillRegistry()
    assert registry.get("manual_send") is not None
    assert all(skill.key != "manual_send" for skill in registry.list())


def test_skill_send_rejects_unknown_skill(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    result = server.skill_send_payload({"skill_key": "totally_made_up", "identity_id": 1})
    assert result["ok"] is False
    assert "未知技能" in result["error"] or "totally_made_up" in result["error"]


def test_skill_send_rejects_missing_identity(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    result = server.skill_send_payload({"skill_key": "wild_training", "identity_id": 999999})
    assert result["ok"] is False
    assert "identity" in result["error"]


def test_skill_send_allows_non_self_send_as_identity(tmp_path, monkeypatch):
    """非 self identity 走 SendMessageRequest(send_as=...),用于频道/身份发送。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "-1001234567890", "account_local_id": "main", "label": "凌霄频道"}
    )
    captured: dict = {}

    class FakeChannel:
        title = "凌霄频道"

    class FakeClient:
        async def get_input_entity(self, value):
            return f"peer:{value}"

        async def get_entity(self, value):
            assert value == -1001234567890
            return FakeChannel()

        async def __call__(self, request):
            captured["request"] = request

            class _Update:
                id = 88003

            class _Result:
                updates = [_Update()]
            return _Result()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": -1001234567890}
    )
    assert result["ok"] is True
    assert result["sent_msg_id"] == 88003
    assert captured["request"].message == ".野外历练"
    assert captured["request"].send_as == "peer:-1001234567890"


def test_skill_send_required_reply_mode_blocks_without_reply_to(tmp_path, monkeypatch):
    """reply_mode=required 的 skill,没传 reply_to_msg_id → 直接拒绝,不该走到 listener。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    listener_called = {"n": 0}

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            listener_called["n"] += 1
            return 1
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "quiz_answer", "identity_id": 8574677796}
    )
    assert result["ok"] is False
    assert "回复发送" in result["error"]
    assert listener_called["n"] == 0


def test_skill_send_happy_path_with_fake_listener(tmp_path, monkeypatch):
    """端到端 happy path:自己身份 + 直发 skill → listener.submit 被调用一次,
    送回 sent_msg_id;无需真 Telegram 客户端。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["chat_id"] = chat_id
            captured["command"] = command
            captured["kwargs"] = kwargs

            class _Sent:
                id = 42000
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8574677796}
    )
    assert result["ok"] is True
    assert result["sent_msg_id"] == 42000
    assert result["command"] == ".野外历练"
    assert captured["chat_id"] == -1001680975844
    assert captured["command"] == ".野外历练"
    assert "reply_to" not in captured["kwargs"]  # 直发不带 reply_to


def test_skill_send_reply_mode_passes_reply_to_to_client(tmp_path, monkeypatch):
    """reply 类 skill 带 reply_to_msg_id → 传给 client.send_message(reply_to=...)。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["kwargs"] = kwargs
            class _Sent:
                id = 99001
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "quiz_answer", "identity_id": 8574677796, "reply_to_msg_id": 8962000}
    )
    assert result["ok"] is True
    assert result["reply_to_msg_id"] == 8962000
    assert captured["kwargs"].get("reply_to") == 8962000


def test_skill_send_dungeon_join_uses_command_override(tmp_path, monkeypatch):
    """.加入副本 N 需要把 N 追加进 command — 用 command_override 覆盖。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
            class _Sent:
                id = 1
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {
            "skill_key": "dungeon_join",
            "identity_id": 8574677796,
            "reply_to_msg_id": 7000,
            "command_override": ".加入副本 123",
        }
    )
    assert result["ok"] is True
    assert captured["command"] == ".加入副本 123"
    assert captured["kwargs"].get("reply_to") == 7000


def test_manual_send_uses_command_override_and_optional_reply(tmp_path, monkeypatch):
    """顶部主动发送 / 消息卡回复共用 manual_send,但命令必须来自人工输入的 override。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def get_input_entity(self, chat_id):
            return chat_id

        async def send_message(self, chat_id, command, **kwargs):
            captured["chat_id"] = chat_id
            captured["command"] = command
            captured["kwargs"] = kwargs
            class _Sent:
                id = 88001
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {
            "skill_key": "manual_send",
            "identity_id": 8574677796,
            "command_override": "今晚手动看一下",
            "reply_to_msg_id": 7000,
            "top_msg_id": "0",
        }
    )
    assert result["ok"] is True
    assert result["command"] == "今晚手动看一下"
    assert captured["chat_id"] == -1001680975844
    assert captured["command"] == "今晚手动看一下"
    assert captured["kwargs"].get("reply_to") == 7000
    logs = server.outbox_logs_payload(kind="manual_send", identity_id=8574677796)["logs"]
    assert len(logs) == 1
    assert logs[0]["status"] == "success"
    assert logs[0]["command"] == "今晚手动看一下"
    assert logs[0]["chat_id"] == -1001680975844
    assert logs[0]["reply_to_msg_id"] == 7000
    assert logs[0]["tg_msg_id"] == 88001
    assert logs[0]["meta"]["skill_key"] == "manual_send"


def test_skill_send_records_failed_send_log_for_reply_required_skill(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )

    result = server.skill_send_payload(
        {"skill_key": "quiz_answer", "identity_id": 8574677796}
    )

    assert result["ok"] is False
    logs = server.outbox_logs_payload(kind="manual_send", status="failed")["logs"]
    assert len(logs) == 1
    assert logs[0]["identity_id"] == 8574677796
    assert logs[0]["command"] == ".作答"
    assert logs[0]["tg_msg_id"] == 0
    assert "reply_to_msg_id" in logs[0]["error"]
    assert logs[0]["meta"]["reply_mode"] == "required"


def test_manual_send_preserves_emoji_text(tmp_path, monkeypatch):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["command"] = command
            class _Sent:
                id = 88002
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    text = "今晚看坠魔谷 🧘‍♂️🔥🇨🇳"
    result = server.skill_send_payload(
        {"skill_key": "manual_send", "identity_id": 8574677796, "command_override": text}
    )

    assert result["ok"] is True
    assert result["command"] == text
    assert captured["command"] == text


def test_skill_routes_registered():
    """前端能找到 /api/skills + /api/skills/send。"""
    from backend.app import GET_ROUTES, POST_ROUTES
    assert "/api/skills" in GET_ROUTES
    assert "/api/skills/send" in POST_ROUTES


def test_skill_send_ingests_outgoing_into_raw_messages(tmp_path, monkeypatch):
    """发送成功后,自己的 outgoing 消息必须也写进 raw_messages — 否则 solo 模式
    bot 回复(reply_to=msg_id)找不到 parent,会从 chat 流里消失。

    同时验证 source 用 client.get_me() 的 first_name/last_name(等同于 listener
    解析其它消息时用的口径),不是账号 label 写死的手机号。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786", "label": "+447851861646"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )

    class FakeMe:
        first_name = "Wise"
        last_name = "Mole🤓"
        username = "wisemole"

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            class _Sent:
                id = 555000
            return _Sent()

        async def get_me(self):
            return FakeMe()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8574677796}
    )
    assert result["ok"] is True
    assert result["sent_msg_id"] == 555000

    import sqlite3
    con = sqlite3.connect(tmp_path / "m.db")
    row = con.execute(
        "SELECT chat_id, msg_id, sender_id, text, top_msg_id, source, id FROM raw_messages WHERE msg_id=555000"
    ).fetchone()
    assert row is not None, "outgoing message should have been ingested into raw_messages"
    assert row[0] == -1001680975844
    assert row[2] == 8574677796
    assert row[3] == ".野外历练"
    assert row[4] == 7310786
    assert row[5] == "Wise Mole🤓", f"source should be first+last name from get_me, got {row[5]!r}"
    assert row[6] == "tg:-1001680975844:555000"


def test_message_payload_keeps_custom_emoji_metadata(tmp_path):
    store = SQLiteStore(tmp_path / "m.db")
    server = MiniWebServer(store=store)
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1001:9001",
            chat_id=-1001,
            msg_id=9001,
            text="群聊表情🔥",
            source="表情道人",
            date="2026-05-18T00:00:00+00:00",
            sender_id=8757550896,
            media_meta={
                "text_entities": [
                    {
                        "type": "custom_emoji",
                        "offset": 4,
                        "length": 2,
                        "document_id": "1234567890123456789",
                    }
                ]
            },
        )
    )

    payload = server.messages_payload("all", limit=10)
    message = payload["messages"][0]

    assert message["raw"] == "群聊表情🔥"
    assert message["media_meta"]["text_entities"][0]["type"] == "custom_emoji"
    assert message["media_meta"]["text_entities"][0]["document_id"] == "1234567890123456789"


def test_skill_send_hydrates_account_and_identity_label_from_get_me(tmp_path, monkeypatch):
    """label 默认是手机号(+xxx)。第一次成功 send 后,server 应该用
    client.get_me() 拿到的 first+last name 把 account.label 和 self-identity.label
    都覆盖掉,UI 才显示真名而不是 +447..."""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786",
         "label": "+447851861646", "phone": "+447851861646"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main",
         "label": "+447851861646"}
    )

    class FakeMe:
        first_name = "Wise"
        last_name = "Mole🤓"
        username = "wisemole"

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            class _Sent:
                id = 777
            return _Sent()

        async def get_me(self):
            return FakeMe()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    # before:label 都是手机号
    assert server._store.get_account("main")["label"] == "+447851861646"
    assert server._store.get_identity(8574677796)["label"] == "+447851861646"

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8574677796}
    )
    assert result["ok"] is True

    # after:label 已替换成真名
    assert server._store.get_account("main")["label"] == "Wise Mole🤓"
    assert server._store.get_identity(8574677796)["label"] == "Wise Mole🤓"


def test_skill_send_preserves_user_renamed_label(tmp_path, monkeypatch):
    """如果用户已经手动改过 label(不是手机号格式),hydrate 不该覆盖。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786",
         "label": "我的主号", "phone": "+447851861646"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main",
         "label": "本尊"}
    )

    class FakeMe:
        first_name = "Wise"
        last_name = "Mole"
        username = "wisemole"

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            class _Sent:
                id = 778
            return _Sent()

        async def get_me(self):
            return FakeMe()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    server.skill_send_payload({"skill_key": "wild_training", "identity_id": 8574677796})
    # 保留用户起的名字
    assert server._store.get_account("main")["label"] == "我的主号"
    assert server._store.get_identity(8574677796)["label"] == "本尊"


def test_state_patches_scoped_by_send_as_id(tmp_path):
    """两个不同身份对同一 scope+key 各发一条命令,store 应该按 send_as_id 隔离,
    互相不覆盖;查询时传 send_as_id 只返回该身份的版本。"""
    from backend.repo.sqlite_store import SQLiteStore
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "m.db")

    # 用户 A 发 .我的灵根,bot 回复 — bot 回复时 sender_id=bot,但 parent.sender_id=A
    A = 8574677796
    B = 8668975549
    BOT = 7900199668
    chat = -1001680975844

    # A 的 .我的灵根
    a_cmd = RawMessageEvent(
        id=f"tg:{chat}:1001:main",
        chat_id=chat,
        msg_id=1001,
        text=".我的灵根",
        source="A",
        date="2026-05-17T00:00:00+00:00",
        sender_id=A,
        sender_is_bot=False,
    )
    store.ingest_event(a_cmd)

    # bot 回复 A 的 玉牒
    a_reply = RawMessageEvent(
        id=f"tg:{chat}:1002:main",
        chat_id=chat,
        msg_id=1002,
        text="@aaa 的天命玉牒\n────\n宗门: 【凌霄宫】\n灵根: 天灵根(火)\n修为: 100 / 1000\n",
        source="bot",
        date="2026-05-17T00:00:01+00:00",
        sender_id=BOT,
        sender_is_bot=True,
        reply_to_msg_id=1001,
    )
    store.ingest_event(a_reply)

    # B 发 .我的灵根 + bot 回复 B
    b_cmd = RawMessageEvent(
        id=f"tg:{chat}:1003:main",
        chat_id=chat,
        msg_id=1003,
        text=".我的灵根",
        source="B",
        date="2026-05-17T00:00:02+00:00",
        sender_id=B,
        sender_is_bot=False,
    )
    store.ingest_event(b_cmd)
    b_reply = RawMessageEvent(
        id=f"tg:{chat}:1004:main",
        chat_id=chat,
        msg_id=1004,
        text="@bbb 的天命玉牒\n────\n宗门: 【落云宗】\n灵根: 木灵根\n修为: 500 / 5000\n",
        source="bot",
        date="2026-05-17T00:00:03+00:00",
        sender_id=BOT,
        sender_is_bot=True,
        reply_to_msg_id=1003,
    )
    store.ingest_event(b_reply)

    # A 应该看到凌霄宫 / 天灵根(火) / 100
    a_patches = {p["key"]: p["value"] for p in store.list_state_patches("identity_profile", send_as_id=A)}
    assert a_patches.get("宗门") == "【凌霄宫】"
    assert a_patches.get("灵根") == "天灵根(火)"
    assert a_patches.get("修为") == "100 / 1000"

    # B 应该看到落云宗 / 木灵根 / 500
    b_patches = {p["key"]: p["value"] for p in store.list_state_patches("identity_profile", send_as_id=B)}
    assert b_patches.get("宗门") == "【落云宗】"
    assert b_patches.get("灵根") == "木灵根"
    assert b_patches.get("修为") == "500 / 5000"

    # 不传 send_as_id → 全部返(A + B 各自的)
    all_patches = store.list_state_patches("identity_profile")
    keys_by_sender = {(p["send_as_id"], p["key"]) for p in all_patches}
    assert (A, "宗门") in keys_by_sender
    assert (B, "宗门") in keys_by_sender


def test_state_patches_filter_accepts_negative_send_as_id(tmp_path):
    """频道身份是 -100...;传 send_as_id 时也必须严格过滤,不能退回全量画像。"""
    from backend.repo.sqlite_store import SQLiteStore
    from backend.domain.models import RawMessageEvent

    store = SQLiteStore(tmp_path / "m.db")
    channel_identity = -1002049298748
    user_identity = 8574677796
    bot = 7900199668
    chat = -1001680975844

    store.ingest_event(RawMessageEvent(
        id=f"tg:{chat}:2001:main",
        chat_id=chat,
        msg_id=2001,
        text=".我的灵根",
        source="channel",
        date="2026-05-17T00:00:00+00:00",
        sender_id=channel_identity,
        sender_is_bot=False,
    ))
    store.ingest_event(RawMessageEvent(
        id=f"tg:{chat}:2002:main",
        chat_id=chat,
        msg_id=2002,
        text="@channel 的天命玉牒\n────\n宗门: 【频道宗】\n灵根: 金灵根\n修为: 1 / 10\n",
        source="bot",
        date="2026-05-17T00:00:01+00:00",
        sender_id=bot,
        sender_is_bot=True,
        reply_to_msg_id=2001,
    ))
    store.ingest_event(RawMessageEvent(
        id=f"tg:{chat}:2003:main",
        chat_id=chat,
        msg_id=2003,
        text=".我的灵根",
        source="user",
        date="2026-05-17T00:00:02+00:00",
        sender_id=user_identity,
        sender_is_bot=False,
    ))
    store.ingest_event(RawMessageEvent(
        id=f"tg:{chat}:2004:main",
        chat_id=chat,
        msg_id=2004,
        text="@user 的天命玉牒\n────\n宗门: 【用户宗】\n灵根: 木灵根\n修为: 2 / 20\n",
        source="bot",
        date="2026-05-17T00:00:03+00:00",
        sender_id=bot,
        sender_is_bot=True,
        reply_to_msg_id=2003,
    ))

    patches = {p["key"]: p["value"] for p in store.list_state_patches("identity_profile", send_as_id=channel_identity)}
    assert patches.get("宗门") == "【频道宗】"
    assert patches.get("灵根") == "金灵根"
    assert "用户宗" not in str(patches)


# ---------- 通知 ----------

def test_notify_card_titles_payload_returns_known_set():
    """前端 settings UI 需要拿到全部可订阅卡片标题作 checkbox。"""
    from backend.repo.sqlite_store import SQLiteStore
    import tempfile, pathlib
    server = MiniWebServer(store=SQLiteStore(pathlib.Path(tempfile.mkdtemp()) / "m.db"))
    payload = server.notify_card_titles_payload()
    assert payload["ok"] is True
    titles = set(payload["titles"])
    # 关键 prompt 类必须在(用户最关心)
    assert "风险提醒" in titles
    assert "玄骨考校" in titles
    assert "境界突破" in titles
    assert "登天阶面板" in titles


def test_notify_test_payload_without_config_reports_error(tmp_path):
    """没启用通知或没填 token 时,/api/notify/test 返回 ok=False。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    result = server.notify_test_payload({})
    assert result["ok"] is False
    assert "未启用" in result["error"] or "未配置" in result["error"]


def test_notify_dispatcher_fires_on_card_when_enabled(tmp_path, monkeypatch):
    """ingest_event 产生卡片 + 配置勾选该卡片标题 → notifier.notify 被调用一次。
    同一 source_id 二次 ingest(NewMessage + Edit) 不会重复推。"""
    from backend.notifications.dispatcher import NotificationDispatcher
    from backend.notifications import Notifier, NotificationEvent
    from backend.domain.models import RawMessageEvent

    captured: list[NotificationEvent] = []

    class FakeNotifier(Notifier):
        name = "fake"
        def notify(self, event):
            captured.append(event)
            return True, ""

    store = SQLiteStore(tmp_path / "m.db")
    # 写 settings 配通知 + 订阅 "风险提醒"
    store.save_settings({
        "notify_enabled": True,
        "notify_tg_bot_token": "irrelevant-for-fake",
        "notify_tg_chat_id": "1",
        "notify_card_titles": ["风险提醒"],
    })
    dispatcher = NotificationDispatcher(get_settings=store.get_settings)
    # 用 fake notifier 替换 list_notifiers
    monkeypatch.setattr(dispatcher, "list_notifiers", lambda: [FakeNotifier()])
    store.set_notify_dispatcher(dispatcher)

    risk_event = RawMessageEvent(
        id="tg:-1001:90001",
        chat_id=-1001,
        msg_id=90001,
        text="挂机嫌疑提醒:对象 @user,你必须自证清白。",
        source="bot",
        date="2026-05-17T00:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )
    store.ingest_event(risk_event)
    # dedup:同 id 再 ingest 一次,不应该再触发 notify
    store.ingest_event(risk_event)

    assert len(captured) == 1
    assert captured[0].title in {"风险提醒", "天道审判"}
    assert captured[0].severity == "risk"
