// MINIWEB-BUILD: chat-client-shell 2026-05-21T04:42

const { state } = window.MiniwebState;
const {
  ACCOUNT_POLL_INTERVAL_MS,
  BOT_DISCOVERY_POLL_INTERVAL_MS,
  CHANNEL_SUMMARY_LIMIT,
  EMOJI_PALETTE,
  HEALTH_POLL_INTERVAL_MS,
  IDENTITY_STATE_POLL_INTERVAL_MS,
  MESSAGE_PREVIEW_CHAR_LIMIT,
  MESSAGE_PREVIEW_LINE_LIMIT,
  NUMERIC_SOURCE_RE,
  POLL_INTERVAL_MS,
  WORLD_SNAPSHOT_POLL_INTERVAL_MS,
} = window.MiniwebConstants;
const { apiFetch, fetchJson, postJson } = window.MiniwebApi;
const { closeModal, openModal } = window.MiniwebModal;
const {
  clipGraphemes,
  countGraphemes,
  escapeAttr,
  escapeHtml,
  firstGrapheme,
  formatNumber,
} = window.MiniwebFormat;

const channelFilters = document.querySelector("#channelFilters");
const quickFilters = document.querySelector("#quickFilters");
const selectAllChannels = document.querySelector("#selectAllChannels");
const messageList = document.querySelector("#messageList");
const messageCount = document.querySelector("#messageCount");
const messageSearchInput = document.querySelector("#messageSearchInput");
const activeChannelText = document.querySelector("#activeChannelText");
const streamActiveChannelText = document.querySelector("#streamActiveChannelText");
const layoutGrid = document.querySelector(".layout-grid");
const detailBackdrop = document.querySelector("#detailBackdrop");
const detailPanel = document.querySelector("#detailPanel");
const detailState = document.querySelector("#detailState");
const closeDetailButton = document.querySelector("#closeDetailButton");
const identitySnapshot = document.querySelector("#identitySnapshot");
const refreshButton = document.querySelector("#refreshButton");
const healthButton = document.querySelector("#healthButton");
const directSendComposer = document.querySelector("#directSendComposer");
const directSendIdentityLine = document.querySelector("#directSendIdentityLine");
const directSendIdentitySelect = document.querySelector("#directSendIdentitySelect");
const directSendInput = document.querySelector("#directSendInput");
const directSendSubmit = document.querySelector("#directSendSubmit");
const directSendStatus = document.querySelector("#directSendStatus");
const directSendReplyContext = document.querySelector("#directSendReplyContext");
const directSendSelectionContext = document.querySelector("#directSendSelectionContext");
const directSendActionHints = document.querySelector("#directSendActionHints");
const emojiPickerButton = document.querySelector("#emojiPickerButton");
const directSendEmojiPalette = document.querySelector("#directSendEmojiPalette");
const directSendSkillPanel = document.querySelector("#directSendSkillPanel");
const openSkillMenuButton = document.querySelector("#openSkillMenuButton");
const openCultivationButton = document.querySelector("#openCultivationButton");
const outboxButton = document.querySelector("#outboxButton");
const scheduleButton = document.querySelector("#scheduleButton");
const scheduleRail = document.querySelector("#scheduleRail");
const scheduleRailRefreshButton = document.querySelector("#scheduleRailRefreshButton");
const logsButton = document.querySelector("#logsButton");
const dungeonStatusButton = document.querySelector("#dungeonStatusButton");
const resourceStatsButton = document.querySelector("#resourceStatsButton");
const inventoryButton = document.querySelector("#inventoryButton");
const settingsButton = document.querySelector("#settingsButton");
const loginAccountButton = document.querySelector("#loginAccountButton");
const addIdentityButton = document.querySelector("#addIdentityButton");
const logoutAccountButton = document.querySelector("#logoutAccountButton");
const skillBarTabs = document.querySelector("#skillBarTabs");
const skillBarChips = document.querySelector("#skillBarChips");
const skillBarIdentity = document.querySelector("#skillBarIdentity");
const gameCockpit = document.querySelector("#gameCockpit");
const cockpitIdentity = document.querySelector("#cockpitIdentity");
const cockpitModules = document.querySelector("#cockpitModules");
const cockpitInbox = document.querySelector("#cockpitInbox");
const gameHud = document.querySelector("#gameHud");
const hudIdentity = document.querySelector("#hudIdentity");
const hudModules = document.querySelector("#hudModules");
const hudInbox = document.querySelector("#hudInbox");
const gamePrimaryStrip = document.querySelector("#gamePrimaryStrip");
const liveSituationBoard = document.querySelector("#liveSituationBoard");
const worldEventStrip = document.querySelector("#worldEventStrip");
const gameSceneBoard = document.querySelector("#gameSceneBoard");
const questTracker = document.querySelector("#questTracker");
const gameActionDock = document.querySelector("#gameActionDock");
const quickActionHotbar = document.querySelector("#quickActionHotbar");
const sidebarIdentityList = document.querySelector("#identityList");
const currentAccountLine = document.querySelector("#currentAccountLine");
const gameBotsButton = document.querySelector("#gameBotsButton");
const notifySettingsButton = document.querySelector("#notifySettingsButton");
const filterSettingsButton = document.querySelector("#filterSettingsButton");
const globalBanner = document.querySelector("#globalBanner");
const viewModeAllButton = null;
const viewModeSoloButton = null;
const jumpToLatestButton = document.querySelector("#jumpToLatest");
const modalRoot = document.querySelector("#modalRoot");

function messageTimeValue(message) {
  const parsed = Date.parse(String(message?.time || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericMessageField(message, key) {
  const value = Number(message?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function compareMessagesByRecency(a, b) {
  const timeDiff = messageTimeValue(b) - messageTimeValue(a);
  if (timeDiff) return timeDiff;
  const msgDiff = numericMessageField(b, "msg_id") - numericMessageField(a, "msg_id");
  if (msgDiff) return msgDiff;
  return numericMessageField(b, "seq") - numericMessageField(a, "seq");
}

function compareRankThenRecency(rankFn) {
  return (a, b) => rankFn(a) - rankFn(b) || compareMessagesByRecency(a, b);
}

function sortMessagesByRecency(messages) {
  return [...(messages || [])].sort(compareMessagesByRecency);
}

function mergeMessagesById(existing, incoming) {
  const byId = new Map((existing || []).map((message) => [message.id, message]));
  for (const message of incoming || []) {
    if (message?.id) byId.set(message.id, message);
  }
  return sortMessagesByRecency(Array.from(byId.values()));
}

function compareDungeonSummariesByRecency(a, b) {
  const aLatest = a?.latestMessage || {};
  const bLatest = b?.latestMessage || {};
  const timeDiff = messageTimeValue(bLatest) - messageTimeValue(aLatest);
  if (timeDiff) return timeDiff;
  const msgDiff = numericMessageField(bLatest, "msg_id") - numericMessageField(aLatest, "msg_id");
  if (msgDiff) return msgDiff;
  return Number(b?.latestSeq || bLatest.seq || 0) - Number(a?.latestSeq || aLatest.seq || 0);
}

async function loadMessageAudit({ silent = false, deep = false } = {}) {
  void silent;
  const params = new URLSearchParams({
    since_hours: "24",
    min_gap_seconds: "300",
    limit: "12",
  });
  if (deep) params.set("deep", "1");
  const payload = await fetchJson(`/api/message-audit?${params.toString()}`);
  state.messageAudit = payload;
  renderGameCockpit();
  updateGlobalBanner();
  return payload;
}

async function loadWorldSnapshot({ silent = false } = {}) {
  if (state.worldSnapshotLoading) {
    return state.worldSnapshot || {};
  }
  state.worldSnapshotLoading = true;
  try {
    const [dungeon, resource, leader, priority] = await Promise.all([
      fetchJson("/api/dungeon-status?limit=90&summary_limit=3&order=recent"),
      fetchJson("/api/resource-stats?period=day&source_type=all&limit=120"),
      fetchJson("/api/messages?channel=leader&limit=6"),
      fetchJson("/api/messages?channels=risk,focus&limit=16&compact=1"),
    ]);
    state.worldSnapshot = {
      loadedAt: new Date().toISOString(),
      dungeon,
      resource,
      leader,
      priority,
    };
    renderLiveSituationBoard();
    renderWorldEventStrip();
    renderGameSceneBoard();
    renderQuestTracker();
    renderGameActionDock();
    return state.worldSnapshot;
  } catch (err) {
    if (!silent) {
      throw err;
    }
    console.warn("[mini-web] world snapshot refresh failed:", err);
    return state.worldSnapshot || {};
  } finally {
    state.worldSnapshotLoading = false;
  }
}

async function loadChannels() {
  const payload = await fetchJson("/api/channels");
  state.channels = payload.channels;
  state.selectedChannels = state.channels.some((channel) => channel.key === "focus")
    ? new Set(["focus"])
    : new Set(state.channels.map((channel) => channel.key));
  renderChannelFilters();
  renderQuickFilters();
  renderGameCockpit();
  renderWorldEventStrip();
  renderGameSceneBoard();
  renderQuestTracker();
}

async function loadChannelSummary({ incremental = false } = {}) {
  if (!state.channels.length) return { changed: false, count: 0 };
  const params = new URLSearchParams({ channel: "all", compact: "1" });
  if (incremental && state.channelSummarySeq > 0) {
    params.set("since_seq", String(state.channelSummarySeq));
  } else {
    params.set("limit", String(CHANNEL_SUMMARY_LIMIT));
  }
  const payload = await fetchJson(`/api/messages?${params.toString()}`);
  const incoming = payload.messages || [];
  const serverMax = Number(payload.max_seq || 0);
  if (incremental && incoming.length === 0) {
    state.channelSummarySeq = Math.max(state.channelSummarySeq, serverMax);
    return { changed: false, count: 0 };
  }
  const byId = new Map((incremental ? state.channelSummaryMessages : []).map((m) => [m.id, m]));
  for (const card of incoming) {
    byId.set(card.id, card);
  }
  state.channelSummaryMessages = Array.from(byId.values())
    .sort(compareMessagesByRecency)
    .slice(0, CHANNEL_SUMMARY_LIMIT);
  state.channelSummarySeq = incremental ? Math.max(state.channelSummarySeq, serverMax) : serverMax;
  renderChannelFilters();
  renderLiveSituationBoard();
  renderWorldEventStrip();
  renderGameSceneBoard();
  renderQuestTracker();
  renderGameActionDock();
  return { changed: incoming.length > 0, count: incoming.length };
}

async function refreshChatViewport({ incremental = false } = {}) {
  const [summaryResult, messageResult] = await Promise.all([
    loadChannelSummary({ incremental }).catch((err) => {
      console.warn("[mini-web] channel summary refresh failed:", err);
      return { changed: false, count: 0 };
    }),
    loadMessages({ incremental }),
  ]);
  return {
    changed: Boolean(summaryResult?.changed || messageResult?.changed),
    count: Number(summaryResult?.count || 0) + Number(messageResult?.count || 0),
  };
}

async function loadMessages({ incremental = false } = {}) {
  // 增量:轮询用,只拉 rowid > lastSeq 的新卡片(可能 0 条)
  // 初始化:首次/手动刷新用,拉最近 200 条
  // channel/channels:默认 focus(重点流);多频道组合由后端 OR 过滤;日志按钮单独走全量 modal
  if (state.channels.length > 0 && selectedChannelKeys().length === 0) {
    if (!incremental) {
      state.lastMessageSeq = 0;
      state.messages = [];
      state.selectedMessageId = null;
      renderChannelFilters();
      renderQuickFilters();
      renderGameCockpit();
      renderMessages();
      renderDirectSendComposer();
      if (state.detailMode === "message") {
        setWorkspacePanelOpen(false);
        renderDetail();
      }
    }
    return { changed: false, count: 0 };
  }
  const params = messageQueryParamsForCurrentView();
  const mode = state.viewMode === "solo" ? "solo" : "";
  if (mode) params.set("mode", mode);
  if (incremental && state.lastMessageSeq > 0) {
    params.set("since_seq", String(state.lastMessageSeq));
  } else {
    params.set("limit", "200");
  }
  if (!selectedChannelKeys().includes("focus")) {
    params.set("compact", "1");
  }
  const payload = await fetchJson(`/api/messages?${params.toString()}`);
  const incoming = payload.messages || [];
  const serverMax = Number(payload.max_seq || 0);

  // 游标跑过头检测:服务端 max_seq 突然小于本地 lastSeq → DB 重置 / parsed_cards 重建,
  // 这时不能按 max 取(永远走不到),要把本地游标重置并重新初始化。
  if (incremental && serverMax > 0 && state.lastMessageSeq > serverMax + 5) {
    console.warn("[poll] seq reset detected: local", state.lastMessageSeq, "> server max", serverMax, "→ re-init");
    state.lastMessageSeq = 0;
    state.messages = [];
    return loadMessages({ incremental: false });
  }

  if (incremental) {
    // merge 进现有 state.messages,按 id 去重
    if (incoming.length === 0) {
      state.lastMessageSeq = Math.max(state.lastMessageSeq, serverMax);
      return { changed: false, count: 0 };
    }
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    for (const card of incoming) {
      byId.set(card.id, card);  // 同 id 的会被新版本覆盖(支持 edit)
    }
    state.messages = sortMessagesByRecency(Array.from(byId.values()));
  } else {
    // 初始化:直接替换
    state.messages = sortMessagesByRecency(incoming);
  }
  state.lastMessageSeq = incremental ? Math.max(state.lastMessageSeq, serverMax) : serverMax;

  if (state.selectedMessageId && !visibleMessages().some((message) => message.id === state.selectedMessageId)) {
    state.selectedMessageId = null;
    if (state.detailMode === "message") {
      setWorkspacePanelOpen(false);
    }
  }
  renderChannelFilters();
  renderQuickFilters();
  renderGameCockpit();
  renderMessages();
  renderDirectSendComposer();
  // 轮询走的增量更新不要碰右侧详情面板 — 用户可能正在看某条消息的详情,
  // 重渲会让按钮和滚动闪一下。初始化 / 手动刷新才重渲详情。
  if (!incremental && state.detailMode === "message") {
    renderDetail();
  }
  return { changed: incoming.length > 0, count: incoming.length };
}

async function loadOutboxDrafts() {
  const payload = await fetchJson("/api/outbox/drafts?status=draft");
  state.outboxDrafts = payload.drafts || [];
  return state.outboxDrafts;
}

async function loadSettings() {
  const payload = await fetchJson("/api/settings");
  state.settings = payload.settings;
  updateGlobalBanner();
  return state.settings;
}

async function loadAccounts() {
  const payload = await fetchJson("/api/accounts");
  state.accounts = payload.accounts || [];
  state.accountLimit = payload.max_accounts || 0;
  state.listenerSummary = payload.listener || null;
  renderSidebarIdentityList();
  renderDirectSendComposer();
  renderGameCockpit();
  updateCurrentAccountLine();
  updateAccountActionGuards();
  return payload;
}

async function loadIdentities() {
  const payload = await fetchJson("/api/identities");
  state.identities = payload.identities || [];
  state.identityLimit = payload.max_identities || 0;
  const previousActiveId = Number(state.activeIdentityId || 0) || null;
  ensureActiveIdentity();
  const activeChanged = previousActiveId !== (Number(state.activeIdentityId || 0) || null);
  renderSidebarIdentityList();
  renderSkillViews();
  renderDirectSendComposer();
  renderGameCockpit();
  if (activeChanged && previousActiveId !== null) {
    loadIdentityPatches({ reset: true }).catch((err) => console.warn("[mini-web] reload patches after identity refresh failed:", err));
  }
  // 身份状态机摘要(深度闭关 / 抚摸 / 温养 / 常用 CD)直接跟随身份刷新。
  // 失败不阻塞身份列表,但成功时能让快捷指令和修炼状态首屏就是当前态。
  await loadIdentityModuleStates();
  return payload;
}

async function loadIdentityModuleStates() {
  try {
    const payload = await fetchJson("/api/identity-state");
    const map = new Map();
    for (const entry of payload.by_identity || []) {
      map.set(Number(entry.send_as_id), entry.items || []);
    }
    state.identityModuleStates = map;
    renderSidebarIdentityList();
    renderCultivationModules();
    renderDirectSendComposer();
    renderSkillViews();
    renderGameCockpit();
  } catch (err) {
    console.warn("[mini-web] loadIdentityModuleStates:", err);
  }
}

function activeIdentityPatches() {
  const activeId = Number(state.activeIdentityId || 0) || null;
  if (!activeId || Number(state.identityPatchesOwnerId || 0) !== activeId) {
    return [];
  }
  return state.identityPatches || [];
}

function renderIdentityProfileViews() {
  renderIdentitySnapshot();
  renderGameCockpit();
  renderSkillViews();
  renderDirectSendComposer();
  renderSidebarIdentityList();  // profile chips 也跟着重画
}

function clearIdentityPatchesForActive() {
  const activeId = Number(state.activeIdentityId || 0) || null;
  state.identityPatches = [];
  state.identityPatchesOwnerId = activeId;
  state.identityPatchesLoading = Boolean(activeId);
  state.identityPatchesRequestSeq += 1;
  renderIdentityProfileViews();
}

async function loadIdentityPatches(options = {}) {
  const activeId = Number(state.activeIdentityId || 0) || null;
  const requestSeq = ++state.identityPatchesRequestSeq;
  if (!activeId) {
    state.identityPatches = [];
    state.identityPatchesOwnerId = null;
    state.identityPatchesLoading = false;
    renderIdentityProfileViews();
    return state.identityPatches;
  }

  const ownerChanged = Number(state.identityPatchesOwnerId || 0) !== activeId;
  if (options.reset || ownerChanged) {
    state.identityPatches = [];
    state.identityPatchesOwnerId = activeId;
    state.identityPatchesLoading = true;
    renderIdentityProfileViews();
  } else {
    state.identityPatchesLoading = true;
  }

  const url = `/api/state-patches?scope=identity_profile&send_as_id=${encodeURIComponent(activeId)}`;
  let payload;
  try {
    payload = await fetchJson(url);
  } catch (err) {
    if (requestSeq === state.identityPatchesRequestSeq && Number(state.activeIdentityId || 0) === activeId) {
      state.identityPatchesLoading = false;
      renderIdentityProfileViews();
    }
    throw err;
  }
  if (requestSeq !== state.identityPatchesRequestSeq || Number(state.activeIdentityId || 0) !== activeId) {
    return state.identityPatches;
  }
  state.identityPatches = payload.state || [];
  state.identityPatchesOwnerId = activeId;
  state.identityPatchesLoading = false;
  renderIdentityProfileViews();
  return state.identityPatches;
}

async function loadDiscoveredBots() {
  try {
    const payload = await fetchJson("/api/discovered-bots");
    state.discoveredBots = payload.discovered || [];
    updateGlobalBanner();
  } catch (error) {
    console.warn("[mini-web] loadDiscoveredBots failed:", error);
  }
}

function currentGameBotIds() {
  return new Set(((state.settings && state.settings.game_bot_ids) || []).map((x) => Number(x)));
}

function updateGlobalBanner() {
  if (!globalBanner) return;
  const ids = currentGameBotIds();
  const audit = state.messageAudit || {};
  if (audit.status && audit.status !== "ok") {
    const gapText = audit.gap_count ? `发现 ${audit.gap_count} 段近期断层` : "监听状态异常";
    globalBanner.hidden = false;
    globalBanner.innerHTML = `
      <span><strong>消息箱需要留意</strong> — ${escapeHtml(gapText)}，资源/副本统计可能受影响。</span>
      <button type="button" id="bannerOpenHealth">查看健康</button>
    `;
    globalBanner.querySelector("#bannerOpenHealth")?.addEventListener("click", () => openHealthModal());
    return;
  }
  if (ids.size === 0) {
    globalBanner.hidden = false;
    globalBanner.innerHTML = `
      <span><strong>未设置游戏 Bot</strong> — 现在系统消息(韩天尊)和玩家消息会混在一起,无法区分。</span>
      <button type="button" id="bannerOpenGameBots">去设置</button>
    `;
    globalBanner.querySelector("#bannerOpenGameBots")?.addEventListener("click", () => openGameBotsModal());
  } else {
    globalBanner.hidden = true;
    globalBanner.innerHTML = "";
  }
}

function gameCockpitDeps() {
  return {
    state,
    gameCockpit,
    gameHud,
    gameActionDock,
    gamePrimaryStrip,
    cockpitIdentity,
    hudIdentity,
    cockpitModules,
    hudModules,
    cockpitInbox,
    hudInbox,
    compareRankThenRecency,
    healthStatusLabel,
    collectorLiveStatus,
    worldEventMeta,
    liveMessagePreview,
    displaySource,
    formatChatTime,
    summarySignalMessages,
    isPersonalSignal,
    messageKind,
    actionableDungeonSnapshot,
    currentDungeonSnapshot,
    visibleDungeonActions,
    dungeonSummaryDisplayLabel,
    identityById,
    activeIdentityPatches,
    overviewModuleRows,
    accountForIdentity,
    identityProfileSourceRows,
    identityCanSend,
    sourceInitial,
    setActiveIdentity,
    showSkillToast,
    auditTimeLabel,
    findOrFetchMessage,
    jumpToMessage,
    openIdentityStatusModal,
    moduleStartTs,
    fmtCountdown,
    listenerStatusText,
    channelMessageCounts,
    questTrackerItems,
    liveResourceSnapshot,
    formatResourceAmount,
    renderLiveSituationBoard,
    renderGameSceneBoard,
    renderQuestTracker,
    showError,
    openOverviewDetailPanel,
    openDungeonStatusModal,
    openHealthModal,
    openWorldReportModal,
    openLeaderIntelModal,
    openXutianOracleGuideModal,
    openResourceStatsModal,
    openInventoryModal,
    loadAccounts,
    loadIdentities,
    openScheduleModal,
    openLogsModal,
  };
}

function gameCockpitView() {
  return window.MiniwebViews.gameCockpit;
}

function renderGameCockpit() {
  return gameCockpitView().renderGameCockpit(gameCockpitDeps());
}

function renderGamePrimaryStrip() {
  return gameCockpitView().renderGamePrimaryStrip(gameCockpitDeps());
}

function primaryFocusStripModel() {
  return gameCockpitView().primaryFocusStripModel(gameCockpitDeps());
}

function primaryFocusMessage() {
  return gameCockpitView().primaryFocusMessage(gameCockpitDeps());
}

function primaryFocusRank(message) {
  return gameCockpitView().primaryFocusRank(gameCockpitDeps(), message);
}

function primaryDungeonStripModel() {
  return gameCockpitView().primaryDungeonStripModel(gameCockpitDeps());
}

function primaryStatusStripModel() {
  return gameCockpitView().primaryStatusStripModel(gameCockpitDeps());
}

async function handlePrimaryStripAction(action) {
  return gameCockpitView().handlePrimaryStripAction(gameCockpitDeps(), action);
}

function openSecondaryGamePanel() {
  return gameCockpitView().openSecondaryGamePanel(gameCockpitDeps());
}

function renderCockpitIdentity() {
  return gameCockpitView().renderCockpitIdentity(gameCockpitDeps());
}

function renderHudIdentitySelect(activeId) {
  return gameCockpitView().renderHudIdentitySelect(gameCockpitDeps(), activeId);
}

function bindHudIdentitySelect() {
  return gameCockpitView().bindHudIdentitySelect(gameCockpitDeps());
}

function renderHudProfileSource(rows) {
  return gameCockpitView().renderHudProfileSource(gameCockpitDeps(), rows);
}

function bindHudSourceButtons() {
  return gameCockpitView().bindHudSourceButtons(gameCockpitDeps());
}

function cockpitMetric(label, value) {
  return gameCockpitView().cockpitMetric(label, value);
}

function renderCockpitModules() {
  return gameCockpitView().renderCockpitModules(gameCockpitDeps());
}

function cockpitModuleChip(args) {
  return gameCockpitView().cockpitModuleChip(args);
}

function renderCockpitInbox() {
  return gameCockpitView().renderCockpitInbox(gameCockpitDeps());
}

function renderGameActionDock() {
  return gameCockpitView().renderGameActionDock(gameCockpitDeps());
}

async function handleGameDockAction(action) {
  return gameCockpitView().handleGameDockAction(gameCockpitDeps(), action);
}

function worldReportDeps() {
  return {
    state,
    renderLiveSituationBoard,
    renderWorldEventStrip,
    renderGameSceneBoard,
    renderQuestTracker,
    renderGameActionDock,
    normalizeDungeonStatusSummary,
    pickCurrentDungeonSummary,
    latestResourcePeriod,
    filterResourceRowsByPeriod,
    aggregateRareResourceRows,
    questTrackerItems,
    renderCurrentDungeonPanel,
    formatResourceAmount,
    renderLeaderIntelCard,
    questTrackerItemKey,
    questItemKind,
    displaySource,
    formatChatTime,
    quickActionLabel,
    auditTimeLabel,
    bindDungeonStatusCards,
    findOrFetchMessage,
    jumpToMessage,
    openDungeonStatusModal,
    openResourceStatsModal,
    openLeaderIntelModal,
    openOverviewDetailPanel,
    openQuestTrackerItem,
    fillQuestTrackerAction,
  };
}

async function openWorldReportModal() {
  return window.MiniwebViews.worldReport.openWorldReportModal(worldReportDeps());
}

function renderWorldReport(payload) {
  return window.MiniwebViews.worldReport.renderWorldReport(worldReportDeps(), payload);
}

function renderWorldReportQuestCard(message) {
  return window.MiniwebViews.worldReport.renderWorldReportQuestCard(worldReportDeps(), message);
}

function renderWorldReportWildCards(periodEvents) {
  return window.MiniwebViews.worldReport.renderWorldReportWildCards(periodEvents);
}

function worldReportListenerLabel(health) {
  return window.MiniwebViews.worldReport.worldReportListenerLabel(health);
}

function worldReportLatestMessageLabel(health) {
  return window.MiniwebViews.worldReport.worldReportLatestMessageLabel(worldReportDeps(), health);
}

function bindWorldReport(dialog, payload) {
  return window.MiniwebViews.worldReport.bindWorldReport(worldReportDeps(), dialog, payload);
}

async function openLeaderIntelModal() {
  await window.MiniwebViews.leaderIntel.openLeaderIntelModal({
    applyChannelSelection,
    displaySource,
    findOrFetchMessage,
    formatChatTime,
    jumpToMessage,
  });
}

function renderLeaderIntelCard(message) {
  return window.MiniwebViews.leaderIntel.renderLeaderIntelCard(message, {
    displaySource,
    formatChatTime,
  });
}

function identityStatusDeps() {
  return {
    state,
    modalRoot,
    identityById,
    activeIdentityPatches,
    cockpitMetric,
    auditTimeLabel,
    formatFieldValue,
    skillIsUnlocked,
    moduleStartTs,
    fmtCountdown,
    loadIdentityModuleStates,
    loadIdentityPatches,
    renderGameCockpit,
    renderSkillViews,
    fillSkillIntoComposer,
    findOrFetchMessage,
    jumpToMessage,
    showSkillToast,
  };
}

function identityStatusView() {
  return window.MiniwebViews.identityStatus;
}

const IDENTITY_STATUS_GROUPS = identityStatusView().IDENTITY_STATUS_GROUPS;

function openIdentityStatusModal() {
  return identityStatusView().openIdentityStatusModal(identityStatusDeps());
}

function renderIdentityStatusBody() {
  return identityStatusView().renderIdentityStatusBody(identityStatusDeps());
}

function identityProfileSourceRows(patches) {
  return identityStatusView().identityProfileSourceRows(patches);
}

function renderIdentityProfileSources(rows) {
  return identityStatusView().renderIdentityProfileSources(identityStatusDeps(), rows);
}

function renderIdentityStatusGroup(group, byKey) {
  return identityStatusView().renderIdentityStatusGroup(identityStatusDeps(), group, byKey);
}

function renderIdentityStatusCard(spec, item) {
  return identityStatusView().renderIdentityStatusCard(identityStatusDeps(), spec, item);
}

function identityModuleView(spec, item) {
  return identityStatusView().identityModuleView(identityStatusDeps(), spec, item);
}

function moduleTimingView(args) {
  return identityStatusView().moduleTimingView(identityStatusDeps(), args);
}

function identityStatusActions(spec) {
  return identityStatusView().identityStatusActions(identityStatusDeps(), spec);
}

function skillByKey(skillKey) {
  return identityStatusView().skillByKey(identityStatusDeps(), skillKey);
}

function bindIdentityStatusModal(dialog) {
  return identityStatusView().bindIdentityStatusModal(identityStatusDeps(), dialog);
}

function bindIdentityStatusBody(dialog) {
  return identityStatusView().bindIdentityStatusBody(identityStatusDeps(), dialog);
}

function directComposerDeps() {
  return {
    state,
    elements: {
      directSendComposer,
      directSendIdentityLine,
      directSendIdentitySelect,
      directSendInput,
      directSendSubmit,
      directSendStatus,
      directSendReplyContext,
      directSendSelectionContext,
      directSendActionHints,
      emojiPickerButton,
      directSendEmojiPalette,
      directSendSkillPanel,
      openSkillMenuButton,
      openCultivationButton,
      quickActionHotbar,
      skillBarTabs,
      skillBarChips,
      skillBarIdentity,
    },
    modalRoot,
    selectedVisibleMessage,
    channelLabel,
    messageKind,
    displaySource,
    formatChatTime,
    quickActionLabel,
    quickActionNeedsManualReview,
    copyCommandToClipboard,
    setWorkspacePanelOpen,
    renderMessages,
    showSkillToast,
    identityById,
    identityCanSend,
    identityOptionLabel,
    skillIsUnlocked,
    currentIdentitySect,
    fmtCountdown,
    openModal,
    showError,
    loadAccounts,
    loadIdentities,
    loadSkills,
    openCultivationModal,
    sendComposerMessage: sendDirectComposerMessage,
  };
}

function directComposerView() {
  return window.MiniwebViews.directComposer;
}

function manualMessagePreview(message) {
  return directComposerView().manualMessagePreview(directComposerDeps(), message);
}

function directReplyContextFromMessage(message) {
  return directComposerView().directReplyContextFromMessage(directComposerDeps(), message);
}

function directReplyContextFromAction(action, fallbackMessage = null) {
  return directComposerView().directReplyContextFromAction(directComposerDeps(), action, fallbackMessage);
}

function setDirectSendReply(replyContext) {
  return directComposerView().setDirectSendReply(directComposerDeps(), replyContext);
}

function clearDirectSendReply() {
  return directComposerView().clearDirectSendReply(directComposerDeps());
}

function renderDirectSendReplyContext() {
  return directComposerView().renderDirectSendReplyContext(directComposerDeps());
}

function setWorkspaceSelectedMessage(message, { rerenderList = true } = {}) {
  if (!message) return;
  state.detailMode = "message";
  state.selectedMessageId = message.id;
  setWorkspacePanelOpen(true);
  if (rerenderList) renderMessages();
  renderDirectSendComposer();
  renderDetail().catch((error) => console.warn("[mini-web] render selected detail failed:", error));
}

function selectMessageForComposer(message, { rerenderList = true } = {}) {
  if (!message) return;
  state.detailMode = "message";
  state.selectedMessageId = message.id;
  if (rerenderList) renderMessages();
  renderDirectSendComposer();
  if (layoutGrid?.classList.contains("detail-open")) {
    renderDetail().catch((error) => console.warn("[mini-web] refresh open detail failed:", error));
  }
}

function selectedVisibleMessage() {
  const id = state.selectedMessageId;
  if (!id) return null;
  const message = state.messages.find((item) => item.id === id) || null;
  if (!message) return null;
  return visibleMessages().some((item) => item.id === id) ? message : null;
}

function setWorkspacePanelOpen(open) {
  if (!layoutGrid) return;
  layoutGrid.classList.toggle("detail-open", Boolean(open));
  layoutGrid.classList.toggle("detail-closed", !open);
  if (detailBackdrop) {
    detailBackdrop.hidden = !open;
  }
}

function closeWorkspacePanel({ rerenderList = true, clearSelection = true } = {}) {
  if (clearSelection) {
    state.selectedMessageId = null;
  }
  state.detailMode = "message";
  setWorkspacePanelOpen(false);
  if (rerenderList) renderMessages();
  renderDirectSendComposer();
  renderDetail().catch((error) => console.warn("[mini-web] close detail failed:", error));
}

function openOverviewDetailPanel() {
  state.detailMode = "overview";
  state.selectedMessageId = null;
  setWorkspacePanelOpen(true);
  renderMessages();
  renderDirectSendComposer();
  renderDetail().catch((error) => console.warn("[mini-web] render overview detail failed:", error));
}

function renderDirectSendSelectionContext() {
  return directComposerView().renderDirectSendSelectionContext(directComposerDeps());
}

function renderDirectSendActionHints() {
  return directComposerView().renderDirectSendActionHints(directComposerDeps());
}

function fillDirectSendComposer(command, opts = {}) {
  return directComposerView().fillDirectSendComposer(directComposerDeps(), command, opts);
}

function resizeDirectSendInput() {
  return directComposerView().resizeDirectSendInput(directComposerDeps());
}

function focusDirectSendInput() {
  return directComposerView().focusDirectSendInput(directComposerDeps());
}

function setDirectSendReplyFromMessage(message) {
  return directComposerView().setDirectSendReplyFromMessage(directComposerDeps(), message);
}

function healthStatusLabel(status) {
  if (status === "error") return "采集异常";
  if (status === "warn") return "需要关注";
  return "采集正常";
}

function listenerStatusText(listener, runningCount) {
  const running = listener?.running || {};
  const first = Object.values(running)[0] || {};
  if (first.message) return first.message;
  if (runningCount) return `${runningCount} 个监听运行中`;
  return "没有运行中的监听";
}

function auditTimeLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.replace("T", " ").replace(/\+.+$/, "");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

async function openHealthModal() {
  await window.MiniwebViews.health.openHealthModal({
    auditTimeLabel,
    formatChatTime,
    getInitialAudit: () => state.messageAudit,
    healthStatusLabel,
    listenerStatusText,
    loadMessageAudit,
    renderResourceCoverage,
    updateGlobalBanner,
  });
}

function openGameBotsModal() {
  window.MiniwebViews.gameBots.openGameBotsModal({
    discoveredBots: state.discoveredBots || [],
    loadDiscoveredBots,
    saveGameBotIds: async (gameBotIds) => {
      const settings = state.settings || (await loadSettings());
      await postJson("/api/settings", {
        ...settings,
        api_hash: "",
        proxy_password: "",
        game_bot_ids: gameBotIds,
      });
      state.settings = await loadSettings();
      updateGlobalBanner();
    },
    settings: state.settings || {},
  });
}

function openFilterSettingsModal() {
  window.MiniwebViews.filterSettings.openFilterSettingsModal({
    fetchMessageById,
    findMessageById: (id) => state.messages.find((message) => message.id === id),
    jumpToMessage,
    muteFocusSenderId,
    renderFocusArchivePreview: (preview) => window.MiniwebViews.focusArchive.renderFocusArchivePreview(preview, { formatChatTime }),
    saveFilterSettings: async (payload) => {
      const saved = await postJson("/api/settings", payload);
      state.settings = saved.settings || state.settings;
      await loadSettings();
      state.lastMessageSeq = 0;
      state.messages = [];
      await loadMessages({ incremental: false });
      renderQuickFilters();
      renderMessages();
      renderDetail();
      return saved;
    },
    settings: state.settings || {},
  });
}

// ---------- 资源统计 ----------

function resourceStatsDeps() {
  return { state };
}

function resourceStatsView() {
  return window.MiniwebViews.resourceStats;
}

async function openResourceStatsModal() {
  return resourceStatsView().openResourceStatsModal(resourceStatsDeps());
}

function bindResourceStatsModal(dialog) {
  return resourceStatsView().bindResourceStatsModal(resourceStatsDeps(), dialog);
}

async function reparseResourceCoverage(dialog) {
  return resourceStatsView().reparseResourceCoverage(resourceStatsDeps(), dialog);
}

async function refreshResourceCoverage(dialog) {
  return resourceStatsView().refreshResourceCoverage(resourceStatsDeps(), dialog);
}

async function refreshResourceStats(dialog) {
  return resourceStatsView().refreshResourceStats(resourceStatsDeps(), dialog);
}

function resetResourceStatsPlaceholder(dialog) {
  return resourceStatsView().resetResourceStatsPlaceholder(dialog);
}

function setResourceStatsStatus(dialog, kind, text) {
  return resourceStatsView().setResourceStatsStatus(dialog, kind, text);
}

function renderResourceStats(dialog, payload) {
  return resourceStatsView().renderResourceStats(resourceStatsDeps(), dialog, payload);
}

function renderResourceDashboard(payload) {
  return resourceStatsView().renderResourceDashboard(resourceStatsDeps(), payload);
}

function renderWildTrainingDashboardPanel(rows, eventSummary, latestPeriod) {
  return resourceStatsView().renderWildTrainingDashboardPanel(rows, eventSummary, latestPeriod);
}

function renderWildStrategyCard(item) {
  return resourceStatsView().renderWildStrategyCard(item);
}

function renderRareResourceDashboardPanel(rows, latestPeriod) {
  return resourceStatsView().renderRareResourceDashboardPanel(rows, latestPeriod);
}

function renderEventOutcomeDashboardPanel(eventSummary, latestPeriod, sourceType) {
  return resourceStatsView().renderEventOutcomeDashboardPanel(eventSummary, latestPeriod, sourceType);
}

function renderOutcomeCard(item) {
  return resourceStatsView().renderOutcomeCard(item);
}

function outcomeSourceRank(sourceType) {
  return resourceStatsView().outcomeSourceRank(sourceType);
}

function renderResourceDiagnostics(diagnostics) {
  return resourceStatsView().renderResourceDiagnostics(diagnostics);
}

function renderResourceTrustCards(payload) {
  return resourceStatsView().renderResourceTrustCards(resourceStatsDeps(), payload);
}

function resourceStatsScopeLabel(payload) {
  return resourceStatsView().resourceStatsScopeLabel(payload);
}

function renderResourceCoverage(payload) {
  return resourceStatsView().renderResourceCoverage(payload);
}

function renderResourceEventTable(summaryRows) {
  return resourceStatsView().renderResourceEventTable(summaryRows);
}

function renderResourceDeltaTable(rows) {
  return resourceStatsView().renderResourceDeltaTable(rows);
}

function renderResourceDeltaAggregateTable(rows) {
  return resourceStatsView().renderResourceDeltaAggregateTable(rows);
}

function aggregateResourceRows(rows) {
  return resourceStatsView().aggregateResourceRows(rows);
}

function renderResourceDeltaSubTable(title, rows, label) {
  return resourceStatsView().renderResourceDeltaSubTable(title, rows, label);
}

function sortResourceDeltaRowsForDisplay(rows, title) {
  return resourceStatsView().sortResourceDeltaRowsForDisplay(rows, title);
}

function groupResourceRowsBySource(rows) {
  return resourceStatsView().groupResourceRowsBySource(rows);
}

function renderResourceStatsSummary(rows, eventSummary, payload = {}) {
  return resourceStatsView().renderResourceStatsSummary(rows, eventSummary, payload);
}

function renderWildTrainingStatsSummary(rows, eventSummary) {
  return resourceStatsView().renderWildTrainingStatsSummary(rows, eventSummary);
}

function aggregateWildRareRows(rows) {
  return resourceStatsView().aggregateWildRareRows(rows);
}

function aggregateRareResourceRows(rows) {
  return resourceStatsView().aggregateRareResourceRows(rows);
}

function filterResourceRowsByPeriod(rows, period) {
  return resourceStatsView().filterResourceRowsByPeriod(rows, period);
}

function wildStrategyFromSourceName(sourceName) {
  return resourceStatsView().wildStrategyFromSourceName(sourceName);
}

function isYinNingResource(resourceName) {
  return resourceStatsView().isYinNingResource(resourceName);
}

function latestResourcePeriod(rows, eventSummary) {
  return resourceStatsView().latestResourcePeriod(rows, eventSummary);
}

function resourceSourceLabel(sourceType, sourceName) {
  return resourceStatsView().resourceSourceLabel(sourceType, sourceName);
}

function parseResourceStatsSource(value) {
  return resourceStatsView().parseResourceStatsSource(value);
}

function resourceBasisLabel(value) {
  return resourceStatsView().resourceBasisLabel(value);
}

function formatSuccessRate(value) {
  return resourceStatsView().formatSuccessRate(value);
}

function formatResourceAmount(value, unit) {
  return resourceStatsView().formatResourceAmount(value, unit);
}
// ---------- 副本状态 ----------

async function openDungeonStatusModal() {
  return window.MiniwebViews.dungeonStatus.openDungeonStatusModal(dungeonStatusDeps());
}

function dungeonStatusDeps() {
  return {
    formatChatTime,
    fillDungeonCommand: (command) => fillDirectSendComposer(command, {
      statusText: "已填入副本命令，请确认后发送。",
      statusKind: "info",
    }),
    fillCangkunCommand: (command) => fillDirectSendComposer(command, {
      statusText: "已填入苍坤洞府命令，请确认后发送。",
      statusKind: "info",
    }),
    openXutianOracleGuideModal,
    openCangkunGuideModal,
    showError,
    copyCommandToClipboard,
    findMessageById: async (id) => findOrFetchMessage(id),
    jumpToMessage,
  };
}

function normalizeDungeonStatusSummary(item) {
  return window.MiniwebViews.dungeonStatus.normalizeDungeonStatusSummary(item);
}

function renderDungeonStatusModal(dialog, summaries, rawCount, totalCount = summaries.length, contextMode = "") {
  return window.MiniwebViews.dungeonStatus.renderDungeonStatusModal(
    dialog,
    summaries,
    rawCount,
    totalCount,
    contextMode,
    dungeonStatusDeps()
  );
}

function pickCurrentDungeonSummary(summaries) {
  return window.MiniwebViews.dungeonStatus.pickCurrentDungeonSummary(summaries);
}

function visibleDungeonActions(summary) {
  return window.MiniwebViews.dungeonStatus.visibleDungeonActions(summary);
}

function compareActionableDungeonSummary(a, b) {
  return window.MiniwebViews.dungeonStatus.compareActionableDungeonSummary(a, b);
}

function renderDungeonPlaybookPanels(summaries, guides = {}) {
  return window.MiniwebViews.dungeonPlaybook.renderDungeonPlaybookPanels(summaries, guides, {
    formatChatTime,
  });
}

function bindDungeonPlaybookPanels(root) {
  window.MiniwebViews.dungeonPlaybook.bindDungeonPlaybookPanels(root, {
    fillCommand: (command) => {
      fillDirectSendComposer(command, {
        statusText: "已填入副本命令，请确认后发送。",
        statusKind: "info",
      });
    },
    openXutianGuide: openXutianOracleGuideModal,
    openCangkunGuide: openCangkunGuideModal,
    findMessageById: async (id) => {
      let target = state.messages.find((message) => message.id === id);
      if (!target) target = await fetchMessageById(id);
      return target;
    },
    jumpToMessage,
  });
}

function renderCurrentDungeonPanel(summary) {
  return window.MiniwebViews.dungeonStatus.renderCurrentDungeonPanel(summary, dungeonStatusDeps());
}

function bindDungeonStatusCards(root, summaries) {
  return window.MiniwebViews.dungeonStatus.bindDungeonStatusCards(root, summaries, dungeonStatusDeps());
}

async function openXutianOracleGuideModal() {
  await window.MiniwebViews.xutianGuide.openXutianOracleGuideModal({
    fillCommand: (command) => fillDirectSendComposer(command, {
      statusText: "已填入虚天殿命令，请确认后发送。",
      statusKind: "info",
    }),
  });
}

async function openCangkunGuideModal() {
  await window.MiniwebViews.cangkunGuide.openCangkunGuideModal({
    fillCommand: (command) => fillDirectSendComposer(command, {
      statusText: "已填入苍坤洞府命令，请确认后发送。",
      statusKind: "info",
    }),
  });
}

function dungeonContextLabel(source) {
  return window.MiniwebViews.dungeonStatus.dungeonContextLabel(source);
}

function dungeonStatusPillClass(kind) {
  return window.MiniwebViews.dungeonStatus.dungeonStatusPillClass(kind);
}

function setDungeonStatusLine(dialog, kind, text) {
  return window.MiniwebViews.dungeonStatus.setDungeonStatusLine(dialog, kind, text);
}

function cleanText(value) {
  return window.MiniwebViews.dungeonStatus.cleanText(value);
}

// ---------- 储物袋 / 批量转移 ----------

async function openInventoryModal() {
  await window.MiniwebViews.inventory.openInventoryModal({
    copyCommandToClipboard,
  });
}

// ---------- 通知设置 modal ----------

async function openNotifySettingsModal() {
  await window.MiniwebViews.notify.openNotifySettingsModal({
    loadSettings,
  });
}

async function loadListenerStatus() {
  const payload = await fetchJson("/api/listener/status");
  return payload.listener;
}

async function loadTelegramDialogs() {
  const payload = await fetchJson("/api/telegram/dialogs");
  if (!payload.ok) {
    throw new Error(payload.error || "读取群 / 频道失败");
  }
  state.telegramDialogs = payload.dialogs || [];
  return state.telegramDialogs;
}

async function loadTelegramTopics(chat) {
  const payload = await fetchJson(`/api/telegram/topics?chat=${encodeURIComponent(chat || "")}`);
  if (!payload.ok) {
    throw new Error(payload.error || "读取话题失败");
  }
  state.telegramTopics = payload.topics || [];
  return state.telegramTopics;
}

async function saveSettings(payload) {
  const response = await apiFetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`保存失败：${response.status}`);
  }
  const data = await response.json();
  state.settings = data.settings;
  return data.settings;
}

async function saveAccount(payload) {
  const data = await postJson("/api/accounts", payload);
  if (!data.ok) {
    throw new Error(data.error || "保存账号失败");
  }
  await loadAccounts();
  return data.account;
}

async function saveIdentity(payload) {
  const data = await postJson("/api/identities", payload);
  if (!data.ok) {
    throw new Error(data.error || "保存身份失败");
  }
  await loadIdentities();
  return data.identity;
}

async function planOutboxAction(action) {
  const data = await postJson("/api/outbox/plan", { action });
  state.outboxPlan = data;
  return data;
}

async function planOutboxAutomation(action) {
  return postJson("/api/outbox/auto-plan", { action });
}

async function dispatchOutboxAutomation(action) {
  return postJson("/api/outbox/auto-dispatch", { action });
}

async function queueOutboxAutomation(action) {
  return postJson("/api/outbox/auto-queue", { action });
}

function chatStreamDeps() {
  return {
    state,
    channelFilters,
    quickFilters,
    selectAllChannels,
    messageList,
    messageCount,
    activeChannelText,
    streamActiveChannelText,
    jumpToLatestButton,
    collectorLiveStatus,
    renderLiveSituationBoard,
    renderWorldEventStrip,
    renderGameActionDock,
    emptyMessageHint,
    formatFieldValue,
    isPersonalSignal,
    renderTelegramTextHtml,
    selectMessageForComposer,
    setWorkspaceSelectedMessage,
    setDirectSendReplyFromMessage,
    fetchMessageById,
    jumpToMessage,
    applyChannelSelection,
    summarySignalMessages,
    fillDirectSendComposer,
    directReplyContextFromAction,
    showSkillToast,
  };
}

function chatStreamView() {
  return window.MiniwebViews.chatStream;
}

function visibleMessages() {
  return chatStreamView().visibleMessages(chatStreamDeps());
}

function messageMatchesSearch(message) {
  return chatStreamView().messageMatchesSearch(chatStreamDeps(), message);
}

function myIdSet() {
  const set = new Set();
  for (const identity of state.identities || []) {
    const id = Number(identity.send_as_id || 0);
    if (id) set.add(id);
  }
  for (const account of state.accounts || []) {
    const id = Number(account.account_id || 0);
    if (id) set.add(id);
  }
  return set;
}

function botIdSet() {
  const ids = ((state.settings || {}).game_bot_ids) || [];
  return new Set(ids.map((id) => Number(id)).filter(Boolean));
}

function serverChannelForCurrentView() {
  if (state.selectedChannels.size === 1) {
    return Array.from(state.selectedChannels)[0] || "all";
  }
  return "all";
}

function selectedChannelKeys() {
  const known = new Set(state.channels.map((channel) => channel.key));
  return [...state.selectedChannels].filter((key) => known.has(key));
}

function messageQueryParamsForCurrentView() {
  const keys = selectedChannelKeys();
  const allSelected = state.channels.length > 0 && keys.length === state.channels.length;
  const params = new URLSearchParams({ channel: allSelected ? "all" : serverChannelForCurrentView() });
  if (!allSelected && keys.length > 1) {
    params.set("channel", "all");
    params.set("channels", keys.join(","));
  }
  return params;
}

function isDungeonJoinRequest(skillKey, command) {
  return skillKey === "dungeon_join" || /^\s*\.加入副本(?:\s|$)/.test(String(command || ""));
}

function sentStatusText(result, { skillKey = "", command = "", replySeparator = "，回复 #" } = {}) {
  const sentId = result?.sent_msg_id || "?";
  const replyId = result?.reply_to_msg_id || "";
  const replyText = replyId ? `${replySeparator}${replyId}` : "";
  const sentCommand = result?.command || command || "";
  if (isDungeonJoinRequest(skillKey, sentCommand)) {
    return `加入副本请求已发送 #${sentId}，等待天尊返回结果${replyText}`;
  }
  return `已发送 #${sentId}${replyText}`;
}

function sentToastText(result, { skillKey = "", command = "" } = {}) {
  const replyText = result?.reply_to_msg_id ? ` (回复 #${result.reply_to_msg_id})` : "";
  const sentCommand = result?.command || command || "";
  if (isDungeonJoinRequest(skillKey, sentCommand)) {
    return `✅ 加入副本请求已发送，等待天尊返回结果${replyText}`;
  }
  return `✅ 已发: ${sentCommand}${replyText}`;
}

async function applyChannelSelection(nextChannels) {
  const known = new Set(state.channels.map((channel) => channel.key));
  const filtered = [...(nextChannels || [])].filter((key) => known.has(key));
  state.selectedChannels = new Set(filtered);
  state.lastMessageSeq = 0;
  state.messages = [];
  state.selectedMessageId = null;
  state.detailMode = "message";
  setWorkspacePanelOpen(false);
  renderQuickFilters();
  renderChannelFilters();
  renderMessages();
  renderDirectSendComposer();
  renderDetail();
  if (filtered.length === 0) {
    return { changed: false, count: 0 };
  }
  await refreshChatViewport({ incremental: false });
}

function parentMessageOf(card) {
  return chatStreamView().parentMessageOf(chatStreamDeps(), card);
}

function jumpToMessage(target) {
  if (!target) return;
  state.detailMode = "message";
  state.selectedMessageId = target.id;

  // 如果父消息在当前频道/模式过滤下隐藏了,放开过滤让它能露出来,
  // 否则点完没反应,用户以为跳转坏了。
  let needsRerender = false;
  const channels = target.channels || [target.channel];
  const channelInSelection = channels.some((ch) => state.selectedChannels.has(ch));
  if (!channelInSelection) {
    channels.forEach((ch) => state.selectedChannels.add(ch));
    renderChannelFilters();
    renderQuickFilters();
    needsRerender = true;
  }
  if (state.viewMode === "solo") {
    // 跳转目标在 solo(server 端 SQL 过滤)里没有 → 提示用户去日志找。
    // 不再 silently 切「全部」,因为主界面只有 solo,没有「全部」按钮可以反映状态。
    const visibleAfter = visibleMessages().some((m) => m.id === target.id);
    if (!visibleAfter) {
      console.info("[mini-web] target not in solo view, open 日志 modal to see full chat");
      needsRerender = true;
    }
  }

  renderMessages();
  renderDirectSendComposer();
  if (layoutGrid?.classList.contains("detail-open")) {
    renderDetail();
  }

  // DOM 重建完才去找节点;requestAnimationFrame 一下确保浏览器 layout 完
  window.requestAnimationFrame(() => {
    const node = messageList.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    // 闪一下让用户看见跳到哪了
    node.classList.add("highlight-jump");
    window.setTimeout(() => node.classList.remove("highlight-jump"), 1700);
  });
}

function renderReplyContext(message) {
  return chatStreamView().renderReplyContext(chatStreamDeps(), message);
}

async function fetchMessageById(id) {
  try {
    const params = new URLSearchParams({ id });
    const payload = await fetchJson(`/api/messages?${params.toString()}`);
    const card = (payload.messages || [])[0];
    if (!card) return null;
    // merge 进 state,后续重渲能看见
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    byId.set(card.id, card);
    state.messages = sortMessagesByRecency(Array.from(byId.values()));
    return card;
  } catch (error) {
    console.warn("[mini-web] fetchMessageById failed:", error);
    return null;
  }
}

async function ensureFullMessage(message) {
  if (!message || !message.compact) return message;
  return fetchMessageById(message.id);
}

function renderChannelFilters() {
  return chatStreamView().renderChannelFilters(chatStreamDeps());
}

function orderedChannelsForConversationList(latestByChannel = null) {
  return chatStreamView().orderedChannelsForConversationList(chatStreamDeps(), latestByChannel);
}

function channelTooltip(channel, latest) {
  return chatStreamView().channelTooltip(chatStreamDeps(), channel, latest);
}

function latestMessagesByChannel() {
  return chatStreamView().latestMessagesByChannel(chatStreamDeps());
}

function latestMessageForChannel(channelKey) {
  return chatStreamView().latestMessageForChannel(chatStreamDeps(), channelKey);
}

function channelPreviewText(message, channel) {
  return chatStreamView().channelPreviewText(channel, message);
}

function channelIcon(key, label) {
  return chatStreamView().channelIcon(key, label);
}

function quickFilterIsAll() {
  return chatStreamView().quickFilterIsAll(chatStreamDeps());
}

function quickFilterActiveKey() {
  return chatStreamView().quickFilterActiveKey(chatStreamDeps());
}

function renderQuickFilters() {
  return chatStreamView().renderQuickFilters(chatStreamDeps());
}

async function applyQuickFilter(key) {
  return chatStreamView().applyQuickFilter(chatStreamDeps(), key);
}

function activeQuickFilterKeyForSelection() {
  return chatStreamView().activeQuickFilterKeyForSelection(chatStreamDeps());
}

function quickFilterKnownChannels(preset) {
  return chatStreamView().quickFilterKnownChannels(chatStreamDeps(), preset);
}

function quickFilterCount(preset, counts) {
  return chatStreamView().quickFilterCount(chatStreamDeps(), preset, counts);
}

function channelMessageCounts() {
  return chatStreamView().channelMessageCounts(chatStreamDeps());
}

function renderIdentitySnapshot() {
  if (!identitySnapshot) {
    return;
  }
  const map = new Map(activeIdentityPatches().map((item) => [item.key, item]));
  const activeId = Number(state.activeIdentityId || 0) || null;
  if (!activeId) {
    identitySnapshot.innerHTML = `
      <button class="role-button active" type="button">
        <span>未选择身份</span>
        <strong>请选择左侧身份</strong>
      </button>
      <div class="snapshot-grid">
        <p class="empty inline">选中身份后,这里显示对应角色状态。</p>
      </div>
    `;
    return;
  }
  if (state.identityPatchesLoading && map.size === 0) {
    identitySnapshot.innerHTML = `
      <button class="role-button active" type="button">
        <span>正在加载</span>
        <strong>角色状态</strong>
      </button>
      <div class="snapshot-grid">
        <p class="empty inline">正在读取当前身份的角色状态...</p>
      </div>
    `;
    return;
  }
  const primaryTitle =
    map.get("境界")?.value ||
    map.get("灵根")?.value ||
    "未识别角色";
  const rows = ["境界", "宗门", "灵根", "综合战力"]
    .filter((key) => map.has(key))
    .map((key) => {
      const item = map.get(key);
      return `
        <div>
          <span>${escapeHtml(key)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `;
    })
    .join("");
  const updatedAt = [...map.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]?.updated_at || "";
  identitySnapshot.innerHTML = `
    <button class="role-button active" type="button">
      <span>${escapeHtml(updatedAt ? `更新 ${updatedAt}` : "等待消息箱投影")}</span>
      <strong>${escapeHtml(primaryTitle)}</strong>
    </button>
    <div class="snapshot-grid">
      ${rows || '<p class="empty inline">暂无角色状态。发送或监听“我的灵根 / 战力”后会更新。</p>'}
    </div>
  `;
}

function copyToClipboardSilent(text) {
  if (!text) return;
  try {
    navigator.clipboard.writeText(text);
  } catch (_e) { /* noop */ }
}

function emojiPaletteHtml() {
  return directComposerView().emojiPaletteHtml();
}

function bindEmojiPalette(container, getTextarea) {
  return directComposerView().bindEmojiPalette(container, getTextarea);
}

function insertTextAtCursor(textarea, text) {
  return directComposerView().insertTextAtCursor(textarea, text);
}

function renderActiveChannelText() {
  return chatStreamView().renderActiveChannelText(chatStreamDeps());
}

function renderMessages() {
  return chatStreamView().renderMessages(chatStreamDeps());
}

function isMessageListNearLatest(threshold = 120) {
  return chatStreamView().isMessageListNearLatest(chatStreamDeps(), threshold);
}

function updateJumpToLatestVisibility() {
  return chatStreamView().updateJumpToLatestVisibility(chatStreamDeps());
}

function scrollMessageListToLatest({ behavior = "auto" } = {}) {
  return chatStreamView().scrollMessageListToLatest(chatStreamDeps(), { behavior });
}

function captureMessageScrollSnapshot() {
  return chatStreamView().captureMessageScrollSnapshot(chatStreamDeps());
}

function restoreMessageScrollSnapshot(snapshot) {
  return chatStreamView().restoreMessageScrollSnapshot(chatStreamDeps(), snapshot);
}

function liveSituationDeps() {
  return {
    state,
    liveSituationBoard,
    compareRankThenRecency,
    worldEventRank,
    worldEventMeta,
    actionableDungeonSnapshot,
    normalizeDungeonStatusSummary,
    pickCurrentDungeonSummary,
    overviewModuleRows,
    latestResourcePeriod,
    filterResourceRowsByPeriod,
    aggregateRareResourceRows,
    isYinNingResource,
    formatResourceAmount,
    formatChatTime,
    displaySource,
    collectorLiveStatus,
    quickActionLabel,
    dungeonSummaryDisplayLabel,
    visibleDungeonActions,
    findOrFetchMessage,
    jumpToMessage,
    fillDirectSendComposer,
    directReplyContextFromAction,
    openOverviewDetailPanel,
    openGameScenePanel,
  };
}

function liveSituationView() {
  return window.MiniwebViews.liveSituation;
}

function renderLiveSituationBoard() {
  return liveSituationView().renderLiveSituationBoard(liveSituationDeps());
}

function liveSituationModel() {
  return liveSituationView().liveSituationModel(liveSituationDeps());
}

function renderLiveMessageHero(primary) {
  return liveSituationView().renderLiveMessageHero(liveSituationDeps(), primary);
}

function renderLiveDungeonHero(summary) {
  return liveSituationView().renderLiveDungeonHero(liveSituationDeps(), summary);
}

function currentDungeonSnapshot() {
  return liveSituationView().currentDungeonSnapshot(liveSituationDeps());
}

function latestLeaderSnapshotMessage() {
  return liveSituationView().latestLeaderSnapshotMessage(liveSituationDeps());
}

function snapshotPriorityMessages() {
  return liveSituationView().snapshotPriorityMessages(liveSituationDeps());
}

function isArchivedOnlySignal(message) {
  return liveSituationView().isArchivedOnlySignal(message);
}

function isPersonalSignal(message) {
  return liveSituationView().isPersonalSignal(liveSituationDeps(), message);
}

function summarySignalMessages() {
  return liveSituationView().summarySignalMessages(liveSituationDeps());
}

function liveResourceSnapshot() {
  return liveSituationView().liveResourceSnapshot(liveSituationDeps());
}

function renderLiveSituationTile(kind, label, message, emptyText, panel) {
  return liveSituationView().renderLiveSituationTile(liveSituationDeps(), kind, label, message, emptyText, panel);
}

function renderLiveDungeonSummaryTile(summary) {
  return liveSituationView().renderLiveDungeonSummaryTile(liveSituationDeps(), summary);
}

function renderLiveResourceSummaryTile(summary) {
  return liveSituationView().renderLiveResourceSummaryTile(liveSituationDeps(), summary);
}

function renderLiveCooldownTile(moduleRow) {
  return liveSituationView().renderLiveCooldownTile(moduleRow);
}

function bindLiveSituationBoard() {
  return liveSituationView().bindLiveSituationBoard(liveSituationDeps(), liveSituationBoard);
}

function liveMessagePreview(message, limit) {
  return liveSituationView().liveMessagePreview(message, limit);
}

function liveMessageKind(message) {
  return liveSituationView().liveMessageKind(liveSituationDeps(), message);
}

function liveMessageKindLabel(message) {
  return liveSituationView().liveMessageKindLabel(liveSituationDeps(), message);
}

function worldEventDeps() {
  return {
    state,
    worldEventStrip,
    compareRankThenRecency,
    summarySignalMessages,
    formatChatTime,
    displaySource,
    actionableDungeonSnapshot,
    currentDungeonSnapshot,
    dungeonSummaryDisplayLabel,
    visibleDungeonActions,
    liveResourceSnapshot,
    formatResourceAmount,
    latestLeaderSnapshotMessage,
    liveMessagePreview,
    isPersonalSignal,
    findOrFetchMessage,
    jumpToMessage,
    fillDirectSendComposer,
    directReplyContextFromAction,
    applyChannelSelection,
    showSkillToast,
    openGameScenePanel,
  };
}

function worldEventView() {
  return window.MiniwebViews.worldEvent;
}

function renderWorldEventStrip() {
  return worldEventView().renderWorldEventStrip(worldEventDeps());
}

function worldEventSlotDefs() {
  return worldEventView().worldEventSlotDefs();
}

function worldEventSlots() {
  return worldEventView().worldEventSlots(worldEventDeps());
}

function worldEventSlotSnapshot(def, matches = []) {
  return worldEventView().worldEventSlotSnapshot(worldEventDeps(), def, matches);
}

function worldEventSlotMatch(def, message) {
  return worldEventView().worldEventSlotMatch(worldEventDeps(), def, message);
}

function worldEventCandidates() {
  return worldEventView().worldEventCandidates(worldEventDeps());
}

function worldEventRank(message) {
  return worldEventView().worldEventRank(worldEventDeps(), message);
}

function worldEventMeta(message) {
  return worldEventView().worldEventMeta(worldEventDeps(), message);
}

function gameSceneDeps() {
  return {
    state,
    gameSceneBoard,
    compareMessagesByRecency,
    summarySignalMessages,
    formatChatTime,
    displaySource,
    identityById,
    activeIdentityPatches,
    identityProfileSourceRows,
    liveResourceSnapshot,
    formatResourceAmount,
    normalizeDungeonStatusSummary,
    pickCurrentDungeonSummary,
    visibleDungeonActions,
    compareActionableDungeonSummary,
    liveMessagePreview,
    overviewModuleRows,
    skillByKey,
    skillIsUnlocked,
    fmtCountdown,
    applyChannelSelection,
    showSkillToast,
    openIdentityStatusModal,
    openResourceStatsModal,
    openDungeonStatusModal,
    openXutianOracleGuideModal,
    openLeaderIntelModal,
    openHealthModal,
    showError,
    fillSkillIntoComposer,
    findOrFetchMessage,
    fillDirectSendComposer,
    directReplyContextFromAction,
    jumpToMessage,
  };
}

function gameSceneView() {
  return window.MiniwebViews.gameScene;
}

function renderGameSceneBoard() {
  return gameSceneView().renderGameSceneBoard(gameSceneDeps());
}

function gameSceneDefs() {
  return gameSceneView().gameSceneDefs();
}

function gameSceneSummaries() {
  return gameSceneView().gameSceneSummaries(gameSceneDeps());
}

function gameSceneSnapshot(def) {
  return gameSceneView().gameSceneSnapshot(gameSceneDeps(), def);
}

function gameSceneModuleBadges(def, extras = []) {
  return gameSceneView().gameSceneModuleBadges(gameSceneDeps(), def, extras);
}

function gameSceneModuleStats(keys) {
  return gameSceneView().gameSceneModuleStats(gameSceneDeps(), keys);
}

function gameSceneSkillActions(def) {
  return gameSceneView().gameSceneSkillActions(gameSceneDeps(), def);
}

function gameSceneCommandActions(def) {
  return gameSceneView().gameSceneCommandActions(gameSceneDeps(), def);
}

function dungeonSummaryDisplayLabel(summary) {
  return gameSceneView().dungeonSummaryDisplayLabel(summary);
}

function actionableDungeonSnapshot() {
  return gameSceneView().actionableDungeonSnapshot(gameSceneDeps());
}

function gameSceneMatch(def, message) {
  return gameSceneView().gameSceneMatch(def, message);
}

async function openGameScenePanel(panel) {
  return gameSceneView().openGameScenePanel(gameSceneDeps(), panel);
}

function questTrackerDeps() {
  return {
    state,
    questTracker,
    compareRankThenRecency,
    summarySignalMessages,
    actionableDungeonSnapshot,
    currentDungeonSnapshot,
    visibleDungeonActions,
    dungeonSummaryDisplayLabel,
    overviewModuleRows,
    skillIsUnlocked,
    skillByKey,
    isPersonalSignal,
    displaySource,
    formatChatTime,
    quickActionLabel,
    openOverviewDetailPanel,
    findOrFetchMessage,
    jumpToMessage,
    openIdentityStatusModal,
    openDungeonStatusModal,
    fillDirectSendComposer,
    directReplyContextFromAction,
    quickActionNeedsManualReview,
  };
}

function questTrackerView() {
  return window.MiniwebViews.questTracker;
}

function renderQuestTracker() {
  return questTrackerView().renderQuestTracker(questTrackerDeps());
}

function questTrackerItems() {
  return questTrackerView().questTrackerItems(questTrackerDeps());
}

function currentDungeonQuestItem(existingItems = []) {
  return questTrackerView().currentDungeonQuestItem(questTrackerDeps(), existingItems);
}

function questActionKey(action) {
  return questTrackerView().questActionKey(action);
}

function currentModuleQuestItems(existingItems = []) {
  return questTrackerView().currentModuleQuestItems(questTrackerDeps(), existingItems);
}

function currentModuleQuestItem(row, activeId) {
  return questTrackerView().currentModuleQuestItem(questTrackerDeps(), row, activeId);
}

function moduleQuestSkill(row) {
  return questTrackerView().moduleQuestSkill(questTrackerDeps(), row);
}

function questTrackerRank(message) {
  return questTrackerView().questTrackerRank(questTrackerDeps(), message);
}

function renderQuestTrackerItem(message) {
  return questTrackerView().renderQuestTrackerItem(questTrackerDeps(), message);
}

function questItemKind(message, actionEntries = null) {
  return questTrackerView().questItemKind(questTrackerDeps(), message, actionEntries);
}

function questTrackerItemKey(item) {
  return questTrackerView().questTrackerItemKey(item);
}

function questTrackerItemByKey(key) {
  return questTrackerView().questTrackerItemByKey(questTrackerDeps(), key);
}

async function openQuestTrackerItem(key) {
  return questTrackerView().openQuestTrackerItem(questTrackerDeps(), key);
}

async function fillQuestTrackerAction(key, index, label) {
  return questTrackerView().fillQuestTrackerAction(questTrackerDeps(), key, index, label);
}

function overviewDeps() {
  return {
    state,
    detailPanel,
    identityById,
    activeIdentityPatches,
    identityProfileSourceRows,
    cockpitMetric,
    sourceInitial,
    formatFieldValue,
    auditTimeLabel,
    identityStatusFlatSpecs,
    identityModuleView,
    questTrackerItems,
    gameSceneSummaries,
    questTrackerItemKey,
    questItemKind,
    displaySource,
    formatChatTime,
    quickActionLabel,
    openIdentityStatusModal,
    openWorldReportModal,
    showError,
    refreshChatViewport,
    loadIdentityPatches,
    loadIdentityModuleStates,
    renderDetail,
    closeWorkspacePanel,
    applyChannelSelection,
    showSkillToast,
    findOrFetchMessage,
    jumpToMessage,
    openQuestTrackerItem,
    fillQuestTrackerAction,
  };
}

function overviewView() {
  return window.MiniwebViews.overview;
}

function renderOverviewDetailPanel() {
  return overviewView().renderOverviewDetailPanel(overviewDeps());
}

function overviewModuleRows(activeId) {
  return overviewView().overviewModuleRows(overviewDeps(), activeId);
}

function identityStatusFlatSpecs() {
  return identityStatusView().identityStatusFlatSpecs();
}

function renderOverviewModuleRow(row) {
  return overviewView().renderOverviewModuleRow(row);
}

function renderOverviewQuestRow(message) {
  return overviewView().renderOverviewQuestRow(overviewDeps(), message);
}

function bindOverviewDetailPanel() {
  return overviewView().bindOverviewDetailPanel(overviewDeps());
}

async function findOrFetchMessage(id) {
  let message =
    state.messages.find((item) => item.id === id) ||
    state.channelSummaryMessages.find((item) => item.id === id) ||
    null;
  if (!message) {
    message = await fetchMessageById(id);
  }
  if (message && !state.messages.some((item) => item.id === message.id)) {
    const byId = new Map(state.messages.map((item) => [item.id, item]));
    byId.set(message.id, message);
    state.messages = sortMessagesByRecency(Array.from(byId.values()));
  }
  return message;
}

function emptyMessageHint() {
  const query = String(state.messageSearch || "").trim();
  if (query) {
    return `当前频道里没有匹配「${query}」的消息。按 Esc 或清空搜索框恢复。`;
  }
  if (state.channels.length === 0) {
    return "还没有从 Telegram 收到消息。先在「配置 Telegram 接入」里完成登录,然后让监听账号开始采集。";
  }
  if (state.selectedChannels.size === 0) {
    return "在左侧勾选要查看的频道,消息会按时间排到这里。";
  }
  if (state.messages.length === 0) {
    return "消息箱当前还是空的。监听跑起来后,新消息会落到这里。";
  }
  return "当前频道筛选下没有消息。可以多勾几个频道,或点右上角刷新。";
}

function collectorLiveStatus() {
  const running = state.listenerSummary?.running || {};
  const collectorKey = state.listenerSummary?.collector || "";
  if (!collectorKey) {
    return "未采集";
  }
  const status = String(running[collectorKey]?.status || "");
  if (status === "running") return "采集中";
  if (status === "starting") return "采集启动中";
  if (status === "reconnecting") return "采集重连中";
  if (status === "stopping") return "采集停止中";
  if (status === "error") return "采集出错";
  return "未采集";
}

function renderChatMessageNode(message) {
  return chatStreamView().renderChatMessageNode(chatStreamDeps(), message);
}

function renderChatContextMeta(message) {
  return chatStreamView().renderChatContextMeta(chatStreamDeps(), message);
}

function visibleMessageBadges(message) {
  return chatStreamView().visibleMessageBadges(chatStreamDeps(), message);
}

function renderChatQuickActions(message) {
  return chatStreamView().renderChatQuickActions(chatStreamDeps(), message);
}

function quickActionLabel(action) {
  return chatStreamView().quickActionLabel(action);
}

function quickActionNeedsManualReview(action) {
  return chatStreamView().quickActionNeedsManualReview(action);
}

async function handleChatQuickAction(message, index, button) {
  return chatStreamView().handleChatQuickAction(chatStreamDeps(), message, index, button);
}

function displaySource(source) {
  return chatStreamView().displaySource(source);
}

function isNumericSource(source) {
  return chatStreamView().isNumericSource(source);
}

function renderChatBodyText(message, isExpanded) {
  return chatStreamView().renderChatBodyText(chatStreamDeps(), message, isExpanded);
}

function groupMessagesByDate(messages) {
  return chatStreamView().groupMessagesByDate(messages);
}

function formatDayLabel(value) {
  return chatStreamView().formatDayLabel(value);
}

function daysBetween(date, now) {
  return chatStreamView().daysBetween(date, now);
}

function formatChatTime(value) {
  return chatStreamView().formatChatTime(value);
}

function messageKind(message) {
  return chatStreamView().messageKind(chatStreamDeps(), message);
}

function sourceInitial(source, kind) {
  return chatStreamView().sourceInitial(source, kind);
}

function detailPanelDeps() {
  return {
    state,
    detailPanel,
    detailState,
    visibleMessages,
    setWorkspacePanelOpen,
    ensureFullMessage,
    renderOverviewDetailPanel,
    bindOverviewDetailPanel,
    renderEnhancedBlock,
    renderTelegramTextHtml,
    displaySource,
    formatChatTime,
    messageKind,
    quickActionLabel,
    setDirectSendReplyFromMessage,
    showSkillToast,
    copyCommandToClipboard,
    fillDirectSendComposer,
    openFocusArchiveModal,
    toggleFocusMuteSender,
    directReplyContextFromAction,
    planOutboxAction,
    renderOutboxPlan,
    renderOutboxPlanError,
    createOutboxDraft,
    renderDetail,
  };
}

function detailPanelView() {
  return window.MiniwebViews.detailPanel;
}

async function renderDetail() {
  return detailPanelView().renderDetail(detailPanelDeps());
}

function renderFocusInsight(message) {
  return detailPanelView().renderFocusInsight(detailPanelDeps(), message);
}

function actionCountLabel(message) {
  return detailPanelView().actionCountLabel(message);
}

function renderFocusTools(message) {
  return detailPanelView().renderFocusTools(detailPanelDeps(), message);
}

function focusReasonList(message) {
  return detailPanelView().focusReasonList(detailPanelDeps(), message);
}

function canFocusArchiveMessage(message) {
  return detailPanelView().canFocusArchiveMessage(detailPanelDeps(), message);
}

function isFocusMutedSenderId(senderId) {
  return detailPanelView().isFocusMutedSenderId(detailPanelDeps(), senderId);
}

function detailCardsDeps() {
  return {
    state,
    displaySource,
  };
}

function detailCardsView() {
  return window.MiniwebViews.detailCards;
}

function renderEnhancedBlock(message) {
  return detailCardsView().renderEnhancedBlock(detailCardsDeps(), message);
}

function renderDetailFields(fields) {
  return detailCardsView().renderDetailFields(fields);
}

function isPresentValue(value) {
  return detailCardsView().isPresentValue(value);
}

function formatFieldValue(value) {
  return detailCardsView().formatFieldValue(value);
}

function rawMatch(raw, regex) {
  return detailCardsView().rawMatch(raw, regex);
}

function rawLineValue(raw, label) {
  return detailCardsView().rawLineValue(raw, label);
}

function parseProgressObject(value, implicitMax = 0) {
  return detailCardsView().parseProgressObject(value, implicitMax);
}

function renderDetailActions(message) {
  return detailPanelView().renderDetailActions(detailPanelDeps(), message);
}

function renderActionContextLine(action) {
  return detailPanelView().renderActionContextLine(action);
}

function bindDetailActions(message) {
  return detailPanelView().bindDetailActions(detailPanelDeps(), message);
}

function openFocusArchiveModal(message, mode) {
  window.MiniwebViews.focusArchive.openFocusArchiveModal({
    applyFocusExcludePattern,
    formatChatTime,
    message,
    mode,
  });
}

async function applyFocusExcludePattern(pattern) {
  const settings = state.settings || (await loadSettings());
  const patterns = Array.from(new Set([...(settings.focus_exclude_patterns || []), pattern]));
  const saved = await postJson("/api/settings", { focus_exclude_patterns: patterns });
  state.settings = saved.settings || (await loadSettings());
  state.lastMessageSeq = 0;
  state.messages = [];
  await loadMessages({ incremental: false });
  renderQuickFilters();
  renderMessages();
  renderDetail();
}

async function toggleFocusMuteSender(message, button) {
  const senderId = Number(message?.sender_id || 0);
  if (!Number.isFinite(senderId) || senderId === 0) return;
  await muteFocusSenderId(senderId, button);
}

async function muteFocusSenderId(senderId, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "处理中…";
  try {
    const settings = state.settings || (await loadSettings());
    const ids = new Set(((settings.focus_muted_sender_ids || []).map((id) => Number(id))).filter((id) => Number.isFinite(id) && id !== 0));
    if (ids.has(senderId)) {
      ids.delete(senderId);
    } else {
      ids.add(senderId);
    }
    const saved = await postJson("/api/settings", {
      focus_muted_sender_ids: Array.from(ids),
    });
    state.settings = saved.settings || (await loadSettings());
    state.lastMessageSeq = 0;
    state.messages = [];
    await loadMessages({ incremental: false });
    renderQuickFilters();
    renderMessages();
    renderDetail();
    button.textContent = ids.has(senderId) ? "已静音" : "已取消静音";
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message || originalText || "操作失败";
    setTimeout(() => {
      button.textContent = originalText || "重点流静音此人";
    }, 1600);
    throw error;
  }
}

async function copyCommandToClipboard(command, button) {
  try {
    await navigator.clipboard.writeText(command);
    const original = button.textContent;
    button.textContent = "已复制";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1200);
  } catch (error) {
    button.textContent = "复制失败";
  }
}

async function createOutboxDraft(action, sourceMessageId) {
  return postJson("/api/outbox/drafts", {
    action,
    source_message_id: sourceMessageId,
  }).catch((error) => ({ ok: false, error: error.message }));
}

async function deleteOutboxDraft(draftId) {
  return postJson("/api/outbox/drafts/delete", { id: draftId }).catch((error) => ({
    ok: false,
    error: error.message,
  }));
}

async function renderOutboxDraftsView() {
  state.detailMode = "message";
  closeWorkspacePanel({ clearSelection: false });
  await outboxView().openDraftsModal(outboxDeps());
}

function outboxDeps() {
  return {
    state,
    copyCommandToClipboard,
    deleteOutboxDraft,
    fetchMessageById,
    findMessageById: (sourceId) => state.messages.find((item) => item.id === sourceId),
    getDrafts: () => state.outboxDrafts || [],
    loadOutboxDrafts,
    selectMessage: (message) => setWorkspaceSelectedMessage(message, { rerenderList: true }),
    planOutboxAction,
    planOutboxAutomation,
    dispatchOutboxAutomation,
    queueOutboxAutomation,
  };
}

function outboxView() {
  return window.MiniwebViews.outbox;
}

function channelLabel(key) {
  return state.channels.find((channel) => channel.key === key)?.label || key;
}

function renderOutboxPlan(plan, action, container) {
  return outboxView().renderOutboxPlan(outboxDeps(), plan, action, container);
}

function renderOutboxPlanError(error, container) {
  return outboxView().renderOutboxPlanError(outboxDeps(), error, container);
}

function renderOutboxAutomationResult(result, container) {
  return outboxView().renderOutboxAutomationResult(outboxDeps(), result, container);
}

function renderOutboxAutomationError(error, container) {
  return outboxView().renderOutboxAutomationError(outboxDeps(), error, container);
}

function actionWithPlanOverrides(action, container) {
  return outboxView().actionWithPlanOverrides(action, container);
}

function renderPlanIdentityOptions(selectedId) {
  return outboxView().renderPlanIdentityOptions(outboxDeps(), selectedId);
}

function renderPlanAccountOptions(selectedLocalId) {
  return outboxView().renderPlanAccountOptions(outboxDeps(), selectedLocalId);
}

function missingLabel(key) {
  return outboxView().missingLabel(key);
}

function planTargetLabel(plan) {
  return outboxView().planTargetLabel(plan);
}

function planIdentityLabel(plan) {
  return outboxView().planIdentityLabel(plan);
}

function planAccountLabel(plan) {
  return outboxView().planAccountLabel(plan);
}

function showError(error) {
  const message = error?.message || String(error || "操作失败");
  showSkillToast(message, "err");
  console.error("[mini-web]", error);
}

function telegramTextEntities(message) {
  const meta = message && typeof message.media_meta === "object" ? message.media_meta : null;
  const entities = Array.isArray(message?.text_entities)
    ? message.text_entities
    : (Array.isArray(meta?.text_entities) ? meta.text_entities : []);
  return entities
    .map((entity) => ({
      type: String(entity.type || ""),
      offset: Number(entity.offset || 0),
      length: Number(entity.length || 0),
      document_id: entity.document_id ? String(entity.document_id) : "",
    }))
    .filter((entity) => entity.type === "custom_emoji" && entity.length > 0 && entity.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
}

function renderTelegramTextHtml(value, message) {
  const text = String(value ?? "");
  if (!text) return "";
  const entities = telegramTextEntities(message);
  if (!entities.length) {
    return escapeHtml(text);
  }
  let html = "";
  let cursor = 0;
  for (const entity of entities) {
    const start = Math.max(0, Math.min(text.length, entity.offset));
    const end = Math.max(start, Math.min(text.length, entity.offset + entity.length));
    if (start < cursor || start >= text.length) {
      continue;
    }
    html += escapeHtml(text.slice(cursor, start));
    const chunk = text.slice(start, end);
    if (chunk) {
      const title = entity.document_id ? `Telegram 自定义表情 ${entity.document_id}` : "Telegram 自定义表情";
      html += `<span class="tg-custom-emoji" title="${escapeAttr(title)}">${escapeHtml(chunk)}</span>`;
    }
    cursor = end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function settingsView() {
  return window.MiniwebViews.settings;
}

function settingsDeps() {
  return {
    state,
    bindAccountControls,
    cancelLogin: () => postJson("/api/login/cancel", {}),
    loadListenerStatus,
    loadNotifyCardTitles: () => fetchJson("/api/notify/card-titles"),
    loadSettings,
    loadTelegramDialogs,
    loadTelegramTopics,
    renderDialogOptions,
    renderTopicOptions,
    rerenderSettings: renderSettings,
    saveCurrentSettingsFromForm,
    sendNotifyTest: () => postJson("/api/notify/test", {}),
    setSettingsNotice: (message) => {
      state.settingsNotice = message;
    },
    showError,
    showSkillToast,
    startLogin: () => postJson("/api/login/start", {}),
    verifyLogin: (payload) => postJson("/api/login/verify", payload),
  };
}

function renderSettings(settings) {
  return settingsView().renderSettings(settingsDeps(), settings);
}

function renderIdentityList() {
  if (!state.identities.length) {
    return `<p class="empty inline">尚未保存游戏身份。登录某个 Telegram 账号后会自动建一条 self-identity（identity_id == account_id）;以频道身份发请手动建一条 identity_id 为 -100… 的 channel-identity。</p>`;
  }
  return state.identities
    .map((identity) => {
      const accountLabel = identity.account?.label || identity.account_local_id || "未绑定账号";
      const name = identity.label || identity.username || identity.send_as_id;
      const kind = identityKindLabel(identity.kind);
      return `
        <article class="identity-item" data-identity-id="${escapeAttr(identity.send_as_id)}">
          <div>
            <strong>${escapeHtml(name)}</strong>
            <small><span class="identity-kind ${escapeAttr(identity.kind || "unknown")}">${escapeHtml(kind)}</span>｜send_as ${escapeHtml(identity.send_as_id)}${identity.username ? `｜@${escapeHtml(identity.username)}` : ""}｜账号 ${escapeHtml(accountLabel)}</small>
            <small>${identity.enabled ? "已启用" : "已停用"}${identity.note ? `｜${escapeHtml(identity.note)}` : ""}</small>
          </div>
          <div class="account-actions">
            <button type="button" data-identity-action="fill" data-identity-id="${escapeAttr(identity.send_as_id)}">编辑</button>
            <button type="button" data-identity-action="delete" data-identity-id="${escapeAttr(identity.send_as_id)}">删除</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function identityKindLabel(kind) {
  if (kind === "self") {
    return "自己 (self)";
  }
  if (kind === "channel") {
    return "频道 (channel)";
  }
  if (kind === "self_unbound") {
    return "未关联账号";
  }
  return "未识别";
}

function renderSidebarIdentityList() {
  if (!sidebarIdentityList) return;
  if (!state.identities.length) {
    sidebarIdentityList.innerHTML = '<p class="empty">还没有身份。登录账号后会自动建好。</p>';
    renderCultivationModules();
    return;
  }
  const patchMap = new Map(activeIdentityPatches().map((p) => [p.key, p.value]));
  sidebarIdentityList.innerHTML = state.identities.map((identity) => {
    const account = state.accounts.find((a) => a.local_id === identity.account_local_id);
    const status = identityRowStatusText(identity, account);
    const offline = identityRowIsOffline(identity, account);
    const active = Number(identity.send_as_id || 0) === Number(state.activeIdentityId || 0);
    const klass = ["identity-row", offline ? "offline" : "", active ? "active" : ""].filter(Boolean).join(" ");
    const name = identity.label || identity.username || identity.send_as_id;
    // 当前激活身份才有 profile chips(identityPatches 是按身份 scoped 的)
    const profileChips = active ? _buildProfileChips(patchMap) : "";
    return `
      <button type="button" class="${klass}" data-identity-row="${escapeAttr(String(identity.send_as_id))}">
        <div class="identity-row-head">
          <strong>${escapeHtml(String(name))}</strong>
          <span class="identity-row-status">${escapeHtml(status)}</span>
        </div>
        <div class="identity-row-sub">
          ${identity.username ? `@${escapeHtml(identity.username)}` : ""} <span class="muted">#${escapeHtml(String(identity.send_as_id))}</span>
        </div>
        ${profileChips}
      </button>
    `;
  }).join("");
  sidebarIdentityList.querySelectorAll("[data-identity-row]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.identityRow);
      setActiveIdentity(id, { toggle: true, loadPatches: true }).catch((err) => {
        console.warn("[mini-web] reload patches failed:", err);
        showSkillToast(`切换身份失败: ${err.message || err}`, "err");
      });
    });
  });
  renderCultivationModules();
}

function _buildProfileChips(patchMap) {
  const charName = patchMap.get("角色名") || "";
  const daohao = patchMap.get("道号") || "";
  const root = patchMap.get("灵根") || "";
  const realm = patchMap.get("境界") || "";
  const sect = (patchMap.get("宗门") || "").replace(/^【|】$/g, "");
  const title = (patchMap.get("称号") || "").replace(/^【|】$/g, "");
  const chips = [];
  if (charName || daohao) {
    const txt = [charName, daohao ? `· ${daohao}` : ""].filter(Boolean).join(" ").trim();
    chips.push(`<span class="row-chip">👤 ${escapeHtml(txt)}</span>`);
  }
  if (realm) chips.push(`<span class="row-chip realm">📿 ${escapeHtml(realm)}</span>`);
  if (root) chips.push(`<span class="row-chip root">🌿 ${escapeHtml(root)}</span>`);
  if (sect) chips.push(`<span class="row-chip sect">🏔️ ${escapeHtml(sect)}</span>`);
  if (title) chips.push(`<span class="row-chip title">🏷️ ${escapeHtml(title)}</span>`);
  if (!chips.length) return "";
  return `<div class="identity-row-profile">${chips.join("")}</div>`;
}

function cultivationDeps() {
  return {
    state,
    modalRoot,
    identityById,
    moduleStartTs,
    fmtCountdown,
    renderGameCockpit,
    fillSkillIntoComposer,
  };
}

function cultivationView() {
  return window.MiniwebViews.cultivation;
}

// 修炼状态二级菜单 — 跟身份绑定:深度闭关/元婴/第二元神 倒计时 chip
const CULTIVATION_MODULE_SPECS = cultivationView().CULTIVATION_MODULE_SPECS;

function renderCultivationModules() {
  return cultivationView().renderCultivationModules(cultivationDeps());
}

function renderCultivationModulesInto(container) {
  return cultivationView().renderCultivationModulesInto(cultivationDeps(), container);
}

function renderCultivationModal() {
  return cultivationView().renderCultivationModal(cultivationDeps());
}

function openCultivationModal() {
  return cultivationView().openCultivationModal(cultivationDeps());
}

function _cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs) {
  return cultivationView().cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs);
}

function tickCultivationModules() {
  return cultivationView().tickCultivationModules(cultivationDeps());
}

const MODULE_ICONS = {
  deep_retreat: "📿",
  yuanying: "👻",
  second_soul: "🪞",
  pet_touch: "🖐️",
  pet_warm: "🔥",
  pet_trial: "🥊",
};
const SIDEBAR_MODULE_KEYS = new Set(Object.keys(MODULE_ICONS));

function moduleStartTs(state) {
  if (!state) return 0;
  return Number(
    state.entered_at ||
    state.last_touched_at ||
    state.last_warmed_at ||
    state.last_success_at ||
    state.last_observed_at ||
    0
  ) || 0;
}

function fmtCountdown(secondsLeft) {
  const s = Math.max(0, Math.floor(secondsLeft));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function renderIdentityModulesLine(sendAsId) {
  const items = (state.identityModuleStates.get(Number(sendAsId)) || [])
    .filter((item) => SIDEBAR_MODULE_KEYS.has(item.module_key));
  if (!items.length) return "";
  const nowSec = Date.now() / 1000;
  const parts = items.map((item) => {
    const icon = MODULE_ICONS[item.module_key] || "•";
    const summary = item.summary || {};
    const st = item.state || {};
    const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
    const startTs = moduleStartTs(st);
    const label = escapeHtml(item.label || item.module_key);
    const liveReady = summary.ready === true || (nextAt > 0 && nextAt <= nowSec) || nextAt === 0;
    if (liveReady) {
      return `<span class="module-chip module-ready">${icon} ${label} 已就绪</span>`;
    }
    const remaining = nextAt - nowSec;
    const total = Math.max(1, nextAt - startTs);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    const text = remaining > 0 ? `剩 ${fmtCountdown(remaining)}` : "已就绪";
    return `
      <span class="module-chip module-waiting" data-module-chip="1"
            data-next-at="${nextAt}" data-start-at="${startTs}" data-icon="${icon}" data-label="${label}">
        <span class="module-chip-text">${icon} ${label} <span class="module-chip-time">${escapeHtml(text)}</span></span>
        <span class="module-chip-bar"><span class="module-chip-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
      </span>
    `;
  });
  return `<span class="identity-row-modules">${parts.join("")}</span>`;
}

function tickIdentityModuleChips() {
  // 底部快捷指令倒计时不能依赖左侧身份 chip 是否存在;否则刚产生 CD 时
  // state 已更新但按钮不会重画,用户要再点一次才看见灰态。
  tickSkillBarChips();
  tickCultivationModules();
  tickCockpitModuleChips();
  tickIdentityStatusCards();
  if (!sidebarIdentityList) return;
  const chips = sidebarIdentityList.querySelectorAll('[data-module-chip="1"]');
  if (!chips.length) return;
  const nowSec = Date.now() / 1000;
  chips.forEach((chip) => {
    const nextAt = Number(chip.dataset.nextAt || 0);
    const startTs = Number(chip.dataset.startAt || 0);
    const icon = chip.dataset.icon || "";
    const label = chip.dataset.label || "";
    const remaining = nextAt - nowSec;
    if (remaining <= 0) {
      chip.classList.remove("module-waiting");
      chip.classList.add("module-ready");
      chip.removeAttribute("data-module-chip");
      chip.innerHTML = `${icon} ${label} 已就绪`;
      return;
    }
    const total = Math.max(1, nextAt - startTs);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    const timeEl = chip.querySelector(".module-chip-time");
    const fillEl = chip.querySelector(".module-chip-bar-fill");
    if (timeEl) timeEl.textContent = `剩 ${fmtCountdown(remaining)}`;
    if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;
  });
}

function tickIdentityStatusCards() {
  return identityStatusView().tickIdentityStatusCards(identityStatusDeps());
}

function tickCockpitModuleChips() {
  const chips = document.querySelectorAll('[data-cockpit-timer="1"]');
  if (!chips.length) return;
  const nowSec = Date.now() / 1000;
  let shouldRerender = false;
  chips.forEach((chip) => {
    const nextAt = Number(chip.dataset.nextAt || 0);
    const startAt = Number(chip.dataset.startAt || 0);
    const remaining = nextAt - nowSec;
    if (remaining <= 0) {
      shouldRerender = true;
      return;
    }
    const total = Math.max(1, nextAt - startAt);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    const timeEl = chip.querySelector(".cockpit-module-time");
    const fillEl = chip.querySelector(".cockpit-module-bar span");
    if (timeEl) timeEl.textContent = `剩 ${fmtCountdown(remaining)}`;
    if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;
  });
  if (shouldRerender) {
    renderCockpitModules();
  }
}

function tickSkillBarChips() {
  const chips = document.querySelectorAll(".skill-chip");
  if (!chips.length) return;
  const activeId = state.activeIdentityId;
  if (!activeId) return;
  const modulesByKey = new Map(
    (state.identityModuleStates.get(Number(activeId)) || []).map((it) => [it.module_key, it])
  );
  const now = Date.now() / 1000;
  let anyExpired = false;
  chips.forEach((chip) => {
    const key = chip.dataset.skillKey;
    const skill = (state.skills || []).find((s) => s.key === key);
    if (!skill || !skill.cd_module) return;
    const ms = modulesByKey.get(skill.cd_module);
    const cdUntil = ms
      ? Number((ms.summary && ms.summary.next_at) || (ms.state && ms.state.cooldown_until) || 0)
      : 0;
    const remaining = cdUntil - now;
    const cdEl = chip.querySelector(".skill-chip-cd");
    if (remaining > 0) {
      if (cdEl) cdEl.textContent = chip.classList.contains("hotbar-skill") ? fmtCountdown(remaining) : `剩 ${fmtCountdown(remaining)}`;
      else {
        // 之前没冷却,现在出现了 — 标记重渲
        anyExpired = true;
      }
    } else if (chip.classList.contains("cooling")) {
      // 冷却到 0:重新渲染整条以解除 disabled
      anyExpired = true;
    }
  });
  if (anyExpired) renderSkillViews();
}

function identityRowStatusText(identity, account) {
  if (!identity.enabled) return "已停用";
  if (!account) return "未绑定账号";
  const loginStatus = account.login_status || "idle";
  if (loginStatus === "done") {
    if (identity.kind === "self") return "已登录｜以自己身份";
    if (identity.kind === "channel") return "已登录｜以频道身份";
    return "已登录";
  }
  if (loginStatus === "waiting_code") return "等验证码";
  if (loginStatus === "need_2fa") return "需要 2FA";
  if (loginStatus === "error") return "账号离线｜登录出错";
  return "账号未登录";
}

function identityRowIsOffline(identity, account) {
  if (!account) return true;
  const status = account.login_status || "idle";
  return status === "error" || status === "idle";
}

function updateCurrentAccountLine() {
  if (!currentAccountLine) return;
  const loggedIn = state.accounts.filter((a) => (a.login_status || "") === "done");
  if (loggedIn.length === 0) {
    currentAccountLine.textContent = "当前账号: 未登录";
    return;
  }
  if (loggedIn.length === 1) {
    const a = loggedIn[0];
    const id = a.account_id ? ` (${a.account_id})` : "";
    currentAccountLine.textContent = `当前账号: ${a.label || a.local_id}${id}`;
    return;
  }
  currentAccountLine.textContent = `已登录 ${loggedIn.length} 个账号`;
}

function updateAccountActionGuards() {
  const loggedInCount = state.accounts.filter((a) => (a.login_status || "") === "done").length;
  const anyCount = state.accounts.length;
  if (addIdentityButton) {
    addIdentityButton.disabled = loggedInCount === 0;
    addIdentityButton.title = loggedInCount === 0
      ? "需要先登录至少一个 Telegram 账号才能新增身份"
      : "选账号 → 拉可用 send_as 列表 → 勾选保存";
  }
  if (logoutAccountButton) {
    logoutAccountButton.disabled = loggedInCount === 0;
    logoutAccountButton.title = loggedInCount === 0
      ? (anyCount === 0 ? "还没有任何 Telegram 账号" : "保存的账号都未登录,无可登出")
      : "登出指定账号(只清 session,不删账号和身份)";
  }
}

function openAddIdentityModal() {
  const accountOptions = state.accounts
    .map((account) => {
      const label = `${account.label || account.local_id}｜${account.local_id}`;
      const status = account.login_status === "done" ? " ✓" : " (未登录)";
      return `<option value="${escapeAttr(account.local_id)}">${escapeHtml(label)}${status}</option>`;
    })
    .join("");
  const accountPickerOptions = `<option value="">选择账号</option>${accountOptions}`;
  const dialog = openModal({
    title: "新增身份",
    body: `
      <section class="modal-section">
        <h4>1. 选账号 + 拉可用身份</h4>
        <div class="form-grid">
          <label>
            <span>账号</span>
            <select data-send-as-field="account">${accountPickerOptions}</select>
          </label>
          <label>
            <span>目标群(可选)</span>
            <input data-send-as-field="target_chat" placeholder="留空走该账号的 target_chat" />
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="primary" data-send-as-action="load">获取可用身份</button>
          <button type="button" data-send-as-action="open-logout" hidden>退出此账号</button>
        </div>
        <p class="modal-status-line info" data-send-as-status>选账号后点「获取可用身份」,会拉出该账号在目标群里所有 send_as peer。</p>
      </section>

      <section class="modal-section">
        <h4>2. 勾选要添加的身份</h4>
        <div class="send-as-bulk-bar" hidden>
          <span data-send-as-summary></span>
          <div class="send-as-bulk-actions">
            <button type="button" data-send-as-action="select-all">全选</button>
            <button type="button" data-send-as-action="select-none">全不选</button>
            <button type="button" class="primary" data-send-as-action="batch-save">保存选中</button>
          </div>
        </div>
        <div data-send-as-list class="send-as-list"></div>
        <div data-send-as-result class="send-as-result" hidden></div>
      </section>

      <details class="modal-section">
        <summary>手动添加单条(GetSendAs 没列出来时用)</summary>
        <div>
          <div class="form-grid">
            <label>
              <span>身份 ID</span>
              <input id="manualSendAsId" placeholder="正数=TG 用户;负数=-100…频道 ID" />
            </label>
            <label>
              <span>显示名(可选)</span>
              <input id="manualLabel" placeholder="留空会用 Telegram 解析的名字" />
            </label>
          </div>
          <div class="form-actions">
            <button type="button" id="manualAddIdentityBtn">添加这一条</button>
          </div>
          <p class="modal-status-line info" id="manualAddStatus" hidden></p>
        </div>
      </details>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindAddIdentityModal(dialog);
}

function bindAddIdentityModal(dialog) {
  const accountSelect = dialog.querySelector('[data-send-as-field="account"]');
  const logoutBtn = dialog.querySelector('[data-send-as-action="open-logout"]');
  if (accountSelect && logoutBtn) {
    const update = () => {
      const localId = accountSelect.value;
      const account = state.accounts.find((a) => a.local_id === localId);
      logoutBtn.hidden = !account || account.login_status !== "done";
    };
    accountSelect.addEventListener("change", update);
    update();
  }

  dialog.querySelectorAll("[data-send-as-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.sendAsAction;
      if (action === "load") {
        await loadSendAsListIntoForm(dialog, button);
        return;
      }
      if (action === "select-all") {
        selectAllSendAs(dialog, "all");
        return;
      }
      if (action === "select-none") {
        selectAllSendAs(dialog, "none");
        return;
      }
      if (action === "batch-save") {
        await batchSaveSelectedSendAs(dialog, button);
        return;
      }
      if (action === "open-logout") {
        const localId = accountSelect?.value || "";
        closeModal();
        openLogoutAccountModal(localId);
        return;
      }
    });
  });

  const manualBtn = dialog.querySelector("#manualAddIdentityBtn");
  if (manualBtn) {
    manualBtn.addEventListener("click", async () => {
      const idInput = dialog.querySelector("#manualSendAsId");
      const labelInput = dialog.querySelector("#manualLabel");
      const status = dialog.querySelector("#manualAddStatus");
      const localId = accountSelect?.value || "";
      const sendAsId = (idInput?.value || "").trim();
      if (!localId) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = "请先选账号";
        return;
      }
      if (!sendAsId) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = "请填 send_as_id";
        return;
      }
      manualBtn.disabled = true;
      status.hidden = false;
      status.className = "modal-status-line info";
      status.textContent = "正在解析并保存…";
      try {
        let label = (labelInput?.value || "").trim();
        let username = "";
        if (!label) {
          const resolved = await postJson("/api/accounts/resolve-entity", {
            local_id: localId,
            send_as_id: Number(sendAsId),
          }).catch(() => ({ ok: false }));
          if (resolved.ok) {
            label = resolved.label || "";
            username = resolved.username || "";
          }
        }
        const result = await postJson("/api/identities", {
          send_as_id: sendAsId,
          account_local_id: localId,
          label,
          username,
          enabled: true,
        });
        if (!result.ok) throw new Error(result.error || "保存失败");
        status.className = "modal-status-line ok";
        status.textContent = `已添加 ${result.identity?.label || result.identity?.send_as_id}`;
        idInput.value = "";
        labelInput.value = "";
        await loadIdentities();
      } catch (error) {
        status.className = "modal-status-line error";
        status.textContent = error.message || "添加失败";
      } finally {
        manualBtn.disabled = false;
      }
    });
  }
}

// ---------- 官方定时 ----------

function scheduleDeps() {
  return {
    state,
    scheduleRail,
    loadAccounts,
    loadIdentities,
    showError,
  };
}

async function loadScheduleRail({ silent = false } = {}) {
  return window.MiniwebViews.schedule.loadScheduleRail(scheduleDeps(), { silent });
}

function syncScheduleBatches(payload) {
  return window.MiniwebViews.schedule.syncScheduleBatches(scheduleDeps(), payload);
}

function renderScheduleRail() {
  return window.MiniwebViews.schedule.renderScheduleRail(scheduleDeps());
}

function renderScheduleRailRow(batch) {
  return window.MiniwebViews.schedule.renderScheduleRailRow(scheduleDeps(), batch);
}

function scheduleRailStatusClass(statusKey, counts) {
  return window.MiniwebViews.schedule.scheduleRailStatusClass(statusKey, counts);
}

function scheduleIdentityLabel(sendAsId) {
  return window.MiniwebViews.schedule.scheduleIdentityLabel(scheduleDeps(), sendAsId);
}

async function openScheduleModal() {
  return window.MiniwebViews.schedule.openScheduleModal(scheduleDeps());
}

function renderScheduleTemplateOptions(templates) {
  return window.MiniwebViews.schedule.renderScheduleTemplateOptions(templates);
}

function renderScheduleBatches(batches) {
  return window.MiniwebViews.schedule.renderScheduleBatches(scheduleDeps(), batches);
}

function scheduleStatusText(statusKey, counts) {
  return window.MiniwebViews.schedule.scheduleStatusText(statusKey, counts);
}

function scheduleStatusPill(statusKey) {
  return window.MiniwebViews.schedule.scheduleStatusPill(statusKey);
}

function scheduleManualMessages(result) {
  return window.MiniwebViews.schedule.scheduleManualMessages(result);
}

function scheduleStatusWithManualMessages(baseText, manualMessages) {
  return window.MiniwebViews.schedule.scheduleStatusWithManualMessages(baseText, manualMessages);
}

function bindScheduleModal(dialog, presets, initialBatches, initialTemplates) {
  return window.MiniwebViews.schedule.bindScheduleModal(
    scheduleDeps(),
    dialog,
    presets,
    initialBatches,
    initialTemplates
  );
}

function bindScheduleBatchActions(dialog) {
  return window.MiniwebViews.schedule.bindScheduleBatchActions(scheduleDeps(), dialog);
}

function scheduleProgressPolling(dialog, batchId) {
  return window.MiniwebViews.schedule.scheduleProgressPolling(scheduleDeps(), dialog, batchId);
}

function openLogoutAccountModal(presetLocalId = "") {
  const loggedIn = state.accounts.filter((a) => (a.login_status || "") === "done");
  if (loggedIn.length === 0) {
    openModal({
      title: "登出账户",
      body: `<section class="modal-section"><p class="modal-status-line info">当前没有已登录的账号,无需登出。</p></section>`,
      footer: `<button type="button" data-modal-close>知道了</button>`,
    });
    return;
  }
  const options = loggedIn
    .map((a) => `<option value="${escapeAttr(a.local_id)}" ${a.local_id === presetLocalId ? "selected" : ""}>${escapeHtml(`${a.label || a.local_id}｜${a.account_id || a.local_id}`)}</option>`)
    .join("");
  const dialog = openModal({
    title: "登出 Telegram 账号",
    body: `
      <section class="modal-section">
        <label>
          <span>选要登出的账号</span>
          <select id="logoutAccountSelect">${options}</select>
        </label>
        <p class="modal-status-line warn">这会移除本地登录态并清理 session 文件,但<strong>不会</strong>删除已添加的身份。</p>
        <p class="modal-status-line info">绑定身份会被暂停;重新登录同一账号后可继续使用。</p>
        <p class="modal-status-line info" id="logoutBoundIdentities"></p>
        <p class="modal-status-line" id="logoutResult" hidden></p>
      </section>
    `,
    footer: `
      <button type="button" data-modal-close>取消</button>
      <button type="button" class="primary" id="logoutConfirmBtn">确认登出</button>
    `,
  });
  if (!dialog) return;

  const select = dialog.querySelector("#logoutAccountSelect");
  const boundLine = dialog.querySelector("#logoutBoundIdentities");
  const updateBound = () => {
    const localId = select.value;
    const count = state.identities.filter((id) => id.account_local_id === localId).length;
    boundLine.textContent = count
      ? `该账号当前绑定 ${count} 条身份(不会被删除,但会暂停)。`
      : "该账号当前没有绑定身份。";
  };
  select.addEventListener("change", updateBound);
  updateBound();

  const confirmBtn = dialog.querySelector("#logoutConfirmBtn");
  const resultLine = dialog.querySelector("#logoutResult");
  confirmBtn.addEventListener("click", async () => {
    const localId = select.value;
    if (!localId) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "退出中…";
    resultLine.hidden = false;
    resultLine.className = "modal-status-line info";
    resultLine.textContent = "正在停 listener、清 session 文件…";
    try {
      const result = await postJson("/api/accounts/logout", { local_id: localId });
      if (!result.ok) throw new Error(result.error || "登出失败");
      resultLine.className = "modal-status-line ok";
      resultLine.textContent = `已登出。如有 ${result.bound_identities || 0} 条绑定身份,已暂停。`;
      await Promise.all([loadAccounts(), loadIdentities()]);
      setTimeout(() => closeModal(), 800);
    } catch (error) {
      resultLine.className = "modal-status-line error";
      resultLine.textContent = error.message;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "确认登出";
    }
  });
}

function renderIdentityForm() {
  const accountOptions = state.accounts
    .map((account) => {
      const label = `${account.label || account.local_id}｜${account.local_id}`;
      return `<option value="${escapeAttr(account.local_id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const accountPickerOptions = `<option value="">选择账号</option>${accountOptions}`;
  return `
    <div class="send-as-section">
      <fieldset class="send-as-picker">
        <legend>从 Telegram 拉取并批量添加身份(channels.GetSendAs)</legend>
        <div class="send-as-controls">
          <label class="send-as-control">
            <span>账号</span>
            <select data-send-as-field="account">
              ${accountPickerOptions}
            </select>
          </label>
          <label class="send-as-control">
            <span>目标群(可选)</span>
            <input data-send-as-field="target_chat" placeholder="留空走该账号配置的 target_chat" />
          </label>
          <button type="button" class="primary" data-send-as-action="load">获取可用身份</button>
        </div>
        <div class="send-as-status-bar">
          <small data-send-as-status>选账号后点「获取可用身份」,会拉出该账号在目标群里所有可用 send_as peer。</small>
        </div>
        <div class="send-as-bulk-bar" hidden>
          <span data-send-as-summary></span>
          <div class="send-as-bulk-actions">
            <button type="button" data-send-as-action="select-all">全选</button>
            <button type="button" data-send-as-action="select-none">全不选</button>
            <button type="button" class="primary" data-send-as-action="batch-save">保存选中</button>
          </div>
        </div>
        <div data-send-as-list class="send-as-list"></div>
        <div data-send-as-result class="send-as-result" hidden></div>
      </fieldset>
    </div>

    <form id="identityForm" class="settings-form account-form">
      <p class="identity-hint">下方表单适合「编辑现有身份」或「手填一条 GetSendAs 没列出的 send_as_id」。常规批量添加用上面的勾选 + 保存选中。</p>
      <div class="form-grid">
        <label>
          <span>身份 ID（send_as_id）</span>
          <input name="send_as_id" inputmode="numeric" placeholder="正数=TG 用户;负数=-100…频道 ID" />
        </label>
        <label>
          <span>绑定 Telegram 账号</span>
          <select name="account_local_id">
            <option value="">暂不绑定</option>
            ${accountOptions}
          </select>
        </label>
        <label>
          <span>显示名称</span>
          <input name="label" placeholder="例如 WA2000 / 凌霄宫公告" />
        </label>
        <label>
          <span>用户名</span>
          <input name="username" placeholder="不带 @ 也可以" />
        </label>
        <label class="span-2">
          <span>备注</span>
          <input name="note" placeholder="可选" />
        </label>
      </div>
      <label class="toggle-row">
        <input name="enabled" type="checkbox" checked />
        <span>启用身份</span>
      </label>
      <div class="form-actions">
        <button type="button" data-identity-form-action="hydrate">用 Telegram 解析此 ID</button>
        <button type="button" data-identity-form-action="clear">清空</button>
        <button type="submit">保存身份</button>
      </div>
    </form>
  `;
}

function bindAccountControls(root = document) {
  root.querySelectorAll("[data-account-action]").forEach((button) => {
    const action = button.dataset.accountAction;
    if (action === "open-new") {
      button.addEventListener("click", () => openAccountModal(null));
      return;
    }
    if (action === "open-edit") {
      button.addEventListener("click", () => {
        const localId = button.dataset.accountId;
        const account = state.accounts.find((item) => item.local_id === localId);
        if (account) openAccountModal(account);
      });
      return;
    }
    if (action === "delete") {
      button.addEventListener("click", async () => {
        const localId = button.dataset.accountId;
        const account = state.accounts.find((item) => item.local_id === localId);
        if (!account) return;
        const name = account.label || account.local_id;
        if (!window.confirm(`删除账号「${name}」?这只删本地配置和 session 引用,不会注销 Telegram 端的会话。`)) {
          return;
        }
        try {
          const result = await postJson("/api/accounts/delete", { local_id: localId });
          if (!result.ok) throw new Error(result.error || "删除失败");
          state.settingsNotice = `${name} 已删除`;
          await loadAccounts();
          renderSettings(state.settings || (await loadSettings()));
        } catch (error) {
          window.alert(error.message);
        }
      });
      return;
    }
    if (action === "toggle-collect") {
      button.addEventListener("change", async () => {
        const localId = button.dataset.accountId;
        const turningOn = button.checked;
        const endpoint = turningOn
          ? "/api/accounts/listener/start"
          : "/api/accounts/listener/stop";
        try {
          const result = await postJson(endpoint, { local_id: localId });
          if (!result.ok && result.listener?.status === "error") {
            throw new Error(result.listener.message || "采集切换失败");
          }
          if (!result.ok && result.error) {
            throw new Error(result.error);
          }
          state.settingsNotice = result.listener?.message || (turningOn ? "已切换为采集账号" : "已停止采集");
          await loadAccounts();
          renderSettings(state.settings || (await loadSettings()));
        } catch (error) {
          state.settingsNotice = error.message;
          // revert UI checkbox locally before re-render
          button.checked = !turningOn;
          renderSettings(state.settings || {});
        }
      });
      return;
    }
  });
}

async function openAccountModal(account) {
  const isNew = !account;
  const settings = state.settings || (await loadSettings());
  const modalState = {
    localId: account?.local_id || "",
    accountSnapshot: account ? { ...account } : null,
    loginStep: account?.login_status === "waiting_code"
      ? "code"
      : account?.login_status === "need_2fa"
        ? "2fa"
        : "phone",
    statusKind: account?.login_status === "done" ? "ok" : account?.login_status === "error" ? "error" : "info",
    statusText: account?.login_message || (account?.login_status === "done" ? "已登录" : "填好手机号,点「发送验证码」开始登录。"),
  };

  const dialog = openModal({
    title: isNew ? "登录 Telegram 账号" : `账号 · ${account.label || account.local_id}`,
    body: renderAccountModalBody(account, settings, modalState),
    footer: `
      <button type="button" data-modal-close>关闭</button>
      <button type="button" class="primary" data-account-modal="save">保存账号</button>
    `,
  });
  if (!dialog) return;
  bindAccountModal(dialog, account, settings, modalState);
}

function renderAccountModalBody(account, settings, modalState) {
  const acc = account || {};
  const savedSecrets = acc.saved_secrets || {};
  const renderInput = (name, value, placeholder, type = "text", attrs = "") =>
    `<input name="${name}" type="${type}" value="${escapeAttr(value || "")}" placeholder="${escapeAttr(placeholder || "")}" ${attrs} />`;
  const accountSummaryLine = acc.account_id
    ? `<p class="muted">account_id ${escapeHtml(acc.account_id)}｜session ${escapeHtml(acc.session_name || acc.local_id || "未生成")}</p>`
    : "";
  const isLoggedIn = (acc.login_status || "") === "done";
  const listenerStatus = (acc.listener_status || "stopped");
  const isCollecting = listenerStatus === "running" || listenerStatus === "starting";
  return `
    <form id="accountModalForm">
      <input type="hidden" name="local_id" value="${escapeAttr(acc.local_id || "")}" />

      <section class="modal-section">
        <h4>基本信息</h4>
        <div class="form-grid">
          <label>
            <span>账号备注</span>
            ${renderInput("label", acc.label || "", "例如 WA2000")}
          </label>
          <label>
            <span>手机号</span>
            ${renderInput("phone", acc.phone || "", "+8613800138000", "tel")}
          </label>
        </div>
        ${accountSummaryLine}
      </section>

      <section class="modal-section">
        <details ${acc.api_id || acc.proxy_type || acc.session_name ? "open" : ""}>
          <summary>高级 / 单账号覆盖（可选,通常不用填）</summary>
          <div>
            <div class="form-grid">
              <label>
                <span>session 名称</span>
                ${renderInput("session_name", acc.session_name || "", "不填则按账号 local_id 派生")}
              </label>
              <label>
                <span>采集优先级(小越优先)</span>
                ${renderInput("collector_priority", String(acc.collector_priority ?? 100), "100", "text", 'inputmode="numeric"')}
              </label>
              <label>
                <span>API ID</span>
                ${renderInput("api_id", acc.api_id || "", "Telegram API ID", "text", 'inputmode="numeric"')}
              </label>
              <label>
                <span>API Hash</span>
                ${renderInput("api_hash", "", savedSecrets.api_hash ? "已保存,留空不变" : "Telegram API Hash", "text", 'autocomplete="off"')}
              </label>
              <label>
                <span>代理类型</span>
                <select name="proxy_type">
                  <option value="" ${acc.proxy_type ? "" : "selected"}>不使用</option>
                  <option value="http" ${acc.proxy_type === "http" ? "selected" : ""}>HTTP</option>
                  <option value="socks5" ${acc.proxy_type === "socks5" ? "selected" : ""}>SOCKS5</option>
                </select>
              </label>
              <label>
                <span>代理 host:port</span>
                ${renderInput("proxy_host", acc.proxy_host || "", "127.0.0.1:7890")}
              </label>
              <label>
                <span>代理用户名</span>
                ${renderInput("proxy_username", acc.proxy_username || "", "")}
              </label>
              <label>
                <span>代理密码</span>
                ${renderInput("proxy_password", "", savedSecrets.proxy_password ? "已保存,留空不变" : "", "password", 'autocomplete="off"')}
              </label>
            </div>
          </div>
        </details>
      </section>

      <section class="modal-section login-flow">
        <h4>登录</h4>
        <p class="modal-status-line ${modalState.statusKind}" data-account-modal-status>${escapeHtml(modalState.statusText)}</p>

        <div class="login-step" data-account-modal-step="phone">
          <div class="form-actions">
            <button type="button" data-account-modal="send-code">发送验证码</button>
          </div>
        </div>

        <div class="login-step" data-account-modal-step="code" ${modalState.loginStep === "phone" ? "hidden" : ""}>
          <div class="form-grid">
            <label class="span-2">
              <span>验证码</span>
              <input name="login_code" placeholder="收到的 Telegram 验证码" autocomplete="off" />
            </label>
          </div>
          <div class="form-actions">
            <button type="button" data-account-modal="verify-code">验证</button>
          </div>
        </div>

        <div class="login-step" data-account-modal-step="2fa" ${modalState.loginStep === "2fa" ? "" : "hidden"}>
          <div class="form-grid">
            <label class="span-2">
              <span>两步验证密码</span>
              <input name="login_password" type="password" placeholder="开启了两步验证才需要" autocomplete="off" />
            </label>
          </div>
          <div class="form-actions">
            <button type="button" data-account-modal="verify-2fa">验证 2FA</button>
          </div>
        </div>
      </section>

      <section class="modal-section listen-target" data-listen-target ${isLoggedIn ? "" : "hidden"}>
        <h4>采集来源</h4>
        <p class="muted">登录后选游戏发生的群和话题(非话题群留空)。游戏 bot 不需要单独配置,会从收到的消息里 <code>sender_is_bot</code> 自动识别。</p>
        <div class="picker-grid">
          <div class="picker-field">
            <div class="picker-head">
              <span>群 / 频道</span>
              <button type="button" data-listen-action="load-dialogs">读取群 / 频道</button>
            </div>
            <select data-listen-select="target_chat">
              <option value="">未选择</option>
            </select>
            ${renderInput("target_chat", acc.target_chat || settings.target_chat || "", "也可手动填 -100... 或 @username")}
          </div>
          <div class="picker-field">
            <div class="picker-head">
              <span>话题(可选)</span>
              <button type="button" data-listen-action="load-topics">读取话题</button>
            </div>
            <select data-listen-select="target_topic_id">
              <option value="">全部话题 / 不限制</option>
            </select>
            ${renderInput("target_topic_id", acc.target_topic_id || settings.target_topic_id || "", "话题群留空 = 全部话题", "text", 'inputmode="numeric"')}
          </div>
        </div>
        <p class="modal-status-line info" data-listen-status hidden></p>
        <label class="toggle-row">
          <input type="checkbox" data-listen-collect-now ${isCollecting ? "checked" : ""} />
          <span>保存后立即开始采集(同时只能一个账号采集,会自动停掉其他)</span>
        </label>
        <div class="form-actions">
          <button type="button" class="primary" data-listen-action="save-target">保存采集来源</button>
        </div>
      </section>
    </form>
  `;
}

function bindAccountModal(dialog, account, settings, modalState) {
  const form = dialog.querySelector("#accountModalForm");
  if (!form) return;

  const setStatus = (kind, text) => {
    modalState.statusKind = kind;
    modalState.statusText = text;
    const line = dialog.querySelector("[data-account-modal-status]");
    if (line) {
      line.className = `modal-status-line ${kind}`;
      line.textContent = text;
    }
  };
  const setStep = (step) => {
    modalState.loginStep = step;
    ["phone", "code", "2fa"].forEach((name) => {
      const node = dialog.querySelector(`[data-account-modal-step="${name}"]`);
      if (!node) return;
      const shouldHide = (name === "code" && step === "phone") || (name === "2fa" && step !== "2fa");
      node.hidden = shouldHide;
    });
  };

  const collectFormPayload = () => {
    const data = new FormData(form);
    return {
      local_id: data.get("local_id"),
      label: data.get("label"),
      phone: data.get("phone"),
      api_id: data.get("api_id"),
      api_hash: data.get("api_hash"),
      session_name: data.get("session_name"),
      target_chat: data.get("target_chat"),
      target_topic_id: data.get("target_topic_id"),
      proxy_type: data.get("proxy_type"),
      proxy_host: data.get("proxy_host"),
      proxy_username: data.get("proxy_username"),
      proxy_password: data.get("proxy_password"),
      collector_priority: data.get("collector_priority") || 100,
      collector_enabled: true,
    };
  };

  const ensureSaved = async () => {
    try {
      const saved = await saveAccount(collectFormPayload());
      if (saved?.local_id) {
        modalState.localId = saved.local_id;
        const localIdInput = form.querySelector('[name="local_id"]');
        if (localIdInput) localIdInput.value = saved.local_id;
      }
      return saved;
    } catch (error) {
      throw error;
    }
  };

  dialog.querySelectorAll("[data-account-modal]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.accountModal;
      try {
        if (action === "save") {
          button.disabled = true;
          await ensureSaved();
          setStatus("ok", "账号已保存");
          await loadAccounts();
          await loadIdentities();
          return;
        }
        if (action === "send-code") {
          button.disabled = true;
          setStatus("info", "正在保存账号并发送验证码...");
          await ensureSaved();
          const result = await postJson("/api/accounts/login/start", { local_id: modalState.localId });
          if (!result.ok) {
            throw new Error(result.error || result.message || "发送验证码失败");
          }
          setStep("code");
          setStatus("info", result.message || "验证码已发送,请在 Telegram 客户端查收");
          dialog.querySelector('[name="login_code"]')?.focus();
          await loadAccounts();
          return;
        }
        if (action === "verify-code") {
          button.disabled = true;
          setStatus("info", "正在校验验证码...");
          const code = form.querySelector('[name="login_code"]').value.trim();
          if (!code) throw new Error("请填写验证码");
          const result = await postJson("/api/accounts/login/verify", {
            local_id: modalState.localId,
            code,
          });
          if (result.status === "need_2fa") {
            setStep("2fa");
            setStatus("warn", result.message || "需要两步验证密码");
            dialog.querySelector('[name="login_password"]')?.focus();
            await loadAccounts();
            return;
          }
          if (!result.ok) {
            throw new Error(result.error || result.message || "验证失败");
          }
          setStep("done");
          setStatus("ok", "登录成功,下面选要采集的群和话题。");
          revealListenTarget(dialog);
          await loadAccounts();
          await loadIdentities();
          return;
        }
        if (action === "verify-2fa") {
          button.disabled = true;
          setStatus("info", "正在校验两步验证密码...");
          const password = form.querySelector('[name="login_password"]').value;
          if (!password) throw new Error("请填写 2FA 密码");
          const result = await postJson("/api/accounts/login/verify", {
            local_id: modalState.localId,
            password,
          });
          if (!result.ok) {
            throw new Error(result.error || result.message || "2FA 验证失败");
          }
          setStep("done");
          setStatus("ok", "登录成功,下面选要采集的群和话题。");          revealListenTarget(dialog);
          await loadAccounts();
          await loadIdentities();
          return;
        }
      } catch (error) {
        setStatus("error", error.message || "操作失败");
      } finally {
        button.disabled = false;
      }
    });
  });

  bindListenTargetControls(dialog, modalState);
}

function revealListenTarget(dialog) {
  const section = dialog.querySelector("[data-listen-target]");
  if (section) section.hidden = false;
}

function bindListenTargetControls(dialog, modalState) {
  const setStatus = (kind, text) => {
    const line = dialog.querySelector("[data-listen-status]");
    if (!line) return;
    line.hidden = !text;
    line.className = `modal-status-line ${kind}`;
    line.textContent = text || "";
  };
  const populateSelect = (select, items, currentValue, valueKey, labelFn) => {
    if (!select) return;
    const current = String(currentValue || "");
    const knownIds = new Set(items.map((it) => String(it[valueKey])));
    const stayCurrent = current && !knownIds.has(current);
    select.innerHTML = `
      <option value="">${select.dataset.listenSelect === "target_topic_id" ? "全部话题 / 不限制" : "未选择"}</option>
      ${stayCurrent ? `<option value="${escapeAttr(current)}" selected>当前手填: ${escapeHtml(current)}</option>` : ""}
      ${items.map((it) => {
        const v = String(it[valueKey]);
        return `<option value="${escapeAttr(v)}" ${v === current ? "selected" : ""}>${escapeHtml(labelFn(it))}</option>`;
      }).join("")}
    `;
  };
  // 群下拉 change 同步到 input
  dialog.querySelectorAll("[data-listen-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const target = select.dataset.listenSelect;
      const input = dialog.querySelector(`[name="${target}"]`);
      if (input) input.value = select.value;
      // 切换群时清空话题
      if (target === "target_chat") {
        const topicInput = dialog.querySelector('[name="target_topic_id"]');
        const topicSelect = dialog.querySelector('[data-listen-select="target_topic_id"]');
        if (topicInput) topicInput.value = "";
        if (topicSelect) topicSelect.value = "";
      }
    });
  });
  dialog.querySelectorAll("[data-listen-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.listenAction;
      const localId = modalState.localId;
      if (!localId) {
        setStatus("warn", "先完成登录,系统才能用这个账号去 Telegram 拉数据");
        return;
      }
      button.disabled = true;
      try {
        if (action === "load-dialogs") {
          setStatus("info", "正在拉取该账号可见的群 / 频道…");
          const result = await fetchJson(`/api/accounts/dialogs?local_id=${encodeURIComponent(localId)}`);
          if (!result.ok) throw new Error(result.error || "拉取失败");
          const dialogsList = result.dialogs || [];
          const select = dialog.querySelector('[data-listen-select="target_chat"]');
          const currentVal = dialog.querySelector('[name="target_chat"]')?.value || "";
          populateSelect(select, dialogsList, currentVal, "id",
            (d) => `${d.title || d.id}｜${dialogKindLabel(d.kind)}｜${d.id}${d.username ? ` @${d.username}` : ""}`);
          setStatus("ok", `共 ${dialogsList.length} 个群 / 频道,从下拉里选`);
          return;
        }
        if (action === "load-topics") {
          const chat = (dialog.querySelector('[name="target_chat"]')?.value || "").trim();
          if (!chat) {
            setStatus("warn", "先选群,才能读这个群的话题");
            return;
          }
          setStatus("info", "正在拉取该群的话题…");
          const result = await fetchJson(`/api/accounts/topics?local_id=${encodeURIComponent(localId)}&chat=${encodeURIComponent(chat)}`);
          if (!result.ok) throw new Error(result.error || "拉取失败");
          const topics = result.topics || [];
          const select = dialog.querySelector('[data-listen-select="target_topic_id"]');
          const currentVal = dialog.querySelector('[name="target_topic_id"]')?.value || "";
          populateSelect(select, topics, currentVal, "id",
            (t) => `${t.title || t.id}｜${t.id}`);
          setStatus("ok", topics.length ? `共 ${topics.length} 个话题` : "该群没有话题(普通群/频道)");
          return;
        }
        if (action === "save-target") {
          const chat = (dialog.querySelector('[name="target_chat"]')?.value || "").trim();
          if (!chat) {
            setStatus("warn", "请选群或手填 -100... 群 ID");
            return;
          }
          const topic = (dialog.querySelector('[name="target_topic_id"]')?.value || "").trim();
          setStatus("info", "正在保存采集来源…");
          await ensureSaveAccountTarget(localId, chat, topic);
          const collectNow = dialog.querySelector("[data-listen-collect-now]")?.checked;
          if (collectNow) {
            setStatus("info", "保存成功,正在切到采集账号…");
            const result = await postJson("/api/accounts/listener/start", { local_id: localId });
            if (!result.ok && result.listener?.status === "error") {
              throw new Error(result.listener.message || "启动采集失败");
            }
            setStatus("ok", "已开始采集,新消息会落到消息箱");
          } else {
            setStatus("ok", "采集来源已保存。回到 sidebar 把账号开关打开就开始采集。");
          }
          await loadAccounts();
          await loadIdentities();
          return;
        }
      } catch (error) {
        setStatus("error", error.message || "操作失败");
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function ensureSaveAccountTarget(localId, targetChat, targetTopicId) {
  const account = state.accounts.find((a) => a.local_id === localId) || {};
  const payload = {
    ...account,
    local_id: localId,
    target_chat: targetChat,
    target_topic_id: targetTopicId || "",
    api_hash: "",
    proxy_password: "",
  };
  return postJson("/api/accounts", payload);
}

function dialogKindLabel(kind) {
  if (kind === "supergroup") return "超级群";
  if (kind === "channel") return "频道";
  if (kind === "group") return "群";
  return "会话";
}

function bindIdentityControls(root = document) {
  const identityForm = root.querySelector("#identityForm");
  if (!identityForm) {
    return;
  }
  const sendAsSection = root.querySelector(".send-as-section");

  identityForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveIdentity(identityPayloadFromForm(identityForm));
      state.settingsNotice = "身份已保存";
      renderSettings(state.settings || (await loadSettings()));
    } catch (error) {
      state.settingsNotice = error.message;
      renderSettings(state.settings || {});
    }
  });

  identityForm.querySelectorAll("[data-identity-form-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.identityFormAction;
      if (action === "clear") {
        identityForm.reset();
        identityForm.querySelector('[name="enabled"]').checked = true;
        return;
      }
      if (action === "hydrate") {
        await hydrateIdentityForm(identityForm, button, root);
        return;
      }
    });
  });

  if (sendAsSection) {
    sendAsSection.querySelectorAll("[data-send-as-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.sendAsAction;
        if (action === "load") {
          await loadSendAsListIntoForm(sendAsSection, button);
          return;
        }
        if (action === "select-all") {
          selectAllSendAs(sendAsSection, "all");
          return;
        }
        if (action === "select-none") {
          selectAllSendAs(sendAsSection, "none");
          return;
        }
        if (action === "batch-save") {
          await batchSaveSelectedSendAs(sendAsSection, button);
          return;
        }
      });
    });
  }

  root.querySelectorAll("[data-identity-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sendAsId = Number(button.dataset.identityId || 0);
      const identity = state.identities.find((item) => Number(item.send_as_id) === sendAsId);
      if (!identity) {
        return;
      }
      try {
        if (button.dataset.identityAction === "fill") {
          fillIdentityForm(identity, root);
          identityForm.scrollIntoView({ block: "nearest" });
          return;
        }
        if (button.dataset.identityAction === "delete") {
          const result = await postJson("/api/identities/delete", { send_as_id: sendAsId });
          if (!result.ok) {
            throw new Error(result.error || "删除身份失败");
          }
          state.settingsNotice = "身份已删除";
          await loadIdentities();
          renderSettings(state.settings || (await loadSettings()));
        }
      } catch (error) {
        state.settingsNotice = error.message;
        renderSettings(state.settings || {});
      }
    });
  });
}

async function loadSendAsListIntoForm(rootEl, button) {
  const accountSelect = rootEl.querySelector('[data-send-as-field="account"]');
  const targetChatInput = rootEl.querySelector('[data-send-as-field="target_chat"]');
  const status = rootEl.querySelector("[data-send-as-status]");
  const result = rootEl.querySelector("[data-send-as-result]");
  if (result) {
    result.hidden = true;
    result.innerHTML = "";
  }
  const localId = accountSelect?.value || "";
  if (!localId) {
    if (status) status.textContent = "请先选账号";
    return;
  }
  const targetChat = (targetChatInput?.value || "").trim();
  button.disabled = true;
  if (status) status.textContent = "正在拉取…";
  state.sendAs = { peers: [], accountLocalId: localId, selected: new Set() };
  rerenderSendAsList(rootEl);
  try {
    const params = new URLSearchParams({ local_id: localId });
    if (targetChat) {
      params.set("target_chat", targetChat);
    }
    const payload = await fetchJson(`/api/accounts/send-as-peers?${params.toString()}`);
    if (!payload.ok) {
      throw new Error(payload.error || "获取可用身份失败");
    }
    state.sendAs = {
      peers: payload.peers || [],
      accountLocalId: localId,
      selected: new Set(),
    };
    // 默认勾选所有还没添加的 peer,符合「批量添加」的常见预期
    state.sendAs.peers.forEach((peer) => {
      if (!isSendAsAlreadyRegistered(peer)) {
        state.sendAs.selected.add(String(peer.send_as_id));
      }
    });
    rerenderSendAsList(rootEl);
    if (status) {
      const total = state.sendAs.peers.length;
      const fresh = state.sendAs.peers.filter((peer) => !isSendAsAlreadyRegistered(peer)).length;
      status.textContent = total
        ? `共 ${total} 个可选身份,其中 ${fresh} 个未添加。默认已勾选未添加的;按需调整后点「保存选中」。`
        : "该账号当前在该群没有可用 send_as 身份";
    }
  } catch (error) {
    if (status) status.textContent = error.message;
    rerenderSendAsList(rootEl);
  } finally {
    button.disabled = false;
  }
}

function isSendAsAlreadyRegistered(peer) {
  if (!peer || peer.send_as_id === undefined || peer.send_as_id === null) {
    return false;
  }
  const id = Number(peer.send_as_id);
  return state.identities.some((identity) => Number(identity.send_as_id) === id);
}

function rerenderSendAsList(rootEl) {
  const list = rootEl.querySelector("[data-send-as-list]");
  const bulkBar = rootEl.querySelector(".send-as-bulk-bar");
  const summary = rootEl.querySelector("[data-send-as-summary]");
  const scope =
    rootEl.closest?.(".modal-body, .modal-dialog") ||
    rootEl.parentElement ||
    rootEl;
  const peers = state.sendAs.peers || [];
  if (!peers.length) {
    if (list) list.innerHTML = "";
    if (bulkBar) bulkBar.hidden = true;
    return;
  }
  if (list) {
    list.innerHTML = peers
      .map((peer) => renderSendAsRow(peer))
      .join("");
    list.querySelectorAll('input[type="checkbox"][data-send-as-checkbox]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.sendAsCheckbox;
        if (cb.checked) {
          state.sendAs.selected.add(id);
        } else {
          state.sendAs.selected.delete(id);
        }
        updateSendAsBulkSummary(rootEl);
      });
    });
    list.querySelectorAll("[data-send-as-fill]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.sendAsFill;
        const peer = peers.find((item) => String(item.send_as_id) === id);
        if (!peer) return;
        const form = scope.querySelector("#identityForm");
        if (!form) return;
        const set = (name, value) => {
          const field = form.querySelector(`[name="${name}"]`);
          if (field) field.value = value ?? "";
        };
        set("send_as_id", peer.send_as_id);
        set("label", peer.title);
        set("username", peer.username);
        set("account_local_id", state.sendAs.accountLocalId);
        form.querySelector('[name="send_as_id"]')?.focus();
      });
    });
  }
  if (bulkBar) {
    bulkBar.hidden = false;
  }
  updateSendAsBulkSummary(rootEl);
}

function renderSendAsRow(peer) {
  const id = String(peer.send_as_id);
  const already = isSendAsAlreadyRegistered(peer);
  const checked = state.sendAs.selected.has(id);
  const kind = peer.kind === "self"
    ? "self"
    : peer.kind === "channel" || peer.kind === "supergroup"
      ? "channel"
      : "self_unbound";
  const tag = identityKindLabel(kind);
  const username = peer.username ? `@${peer.username}` : "";
  const premium = peer.premium_required ? '<span class="status-pill warn">需 Premium</span>' : "";
  const alreadyBadge = already ? '<span class="status-pill ok">已添加</span>' : "";
  return `
    <label class="send-as-row${already ? " disabled" : ""}">
      <input type="checkbox" data-send-as-checkbox="${escapeAttr(id)}"
        ${checked ? "checked" : ""} ${already ? "disabled" : ""} />
      <span class="send-as-row-body">
        <span class="send-as-row-title">
          <strong>${escapeHtml(peer.title || id)}</strong>
          ${username ? `<small>${escapeHtml(username)}</small>` : ""}
        </span>
        <span class="send-as-row-meta">
          <span class="identity-kind ${escapeAttr(kind)}">${escapeHtml(tag)}</span>
          ｜send_as ${escapeHtml(id)}
          ${premium ? `｜${premium}` : ""}
          ${alreadyBadge ? `｜${alreadyBadge}` : ""}
        </span>
      </span>
      <button type="button" class="send-as-row-fill" data-send-as-fill="${escapeAttr(id)}" title="把这条填到下方编辑表单">编辑</button>
    </label>
  `;
}

function updateSendAsBulkSummary(rootEl) {
  const summary = rootEl.querySelector("[data-send-as-summary]");
  const saveButton = rootEl.querySelector('[data-send-as-action="batch-save"]');
  const peers = state.sendAs.peers || [];
  const selectableCount = peers.filter((peer) => !isSendAsAlreadyRegistered(peer)).length;
  const selectedCount = peers.filter(
    (peer) => !isSendAsAlreadyRegistered(peer) && state.sendAs.selected.has(String(peer.send_as_id))
  ).length;
  if (summary) {
    summary.textContent = `已勾选 ${selectedCount} / 可添加 ${selectableCount}`;
  }
  if (saveButton) {
    saveButton.disabled = selectedCount === 0;
    saveButton.textContent = selectedCount > 0 ? `保存选中 (${selectedCount})` : "保存选中";
  }
}

function selectAllSendAs(rootEl, mode) {
  const peers = state.sendAs.peers || [];
  if (mode === "all") {
    peers.forEach((peer) => {
      if (!isSendAsAlreadyRegistered(peer)) {
        state.sendAs.selected.add(String(peer.send_as_id));
      }
    });
  } else {
    state.sendAs.selected.clear();
  }
  rerenderSendAsList(rootEl);
}

async function batchSaveSelectedSendAs(rootEl, button) {
  const peers = state.sendAs.peers || [];
  const localId = state.sendAs.accountLocalId;
  const result = rootEl.querySelector("[data-send-as-result]");
  const status = rootEl.querySelector("[data-send-as-status]");
  if (!localId) {
    if (status) status.textContent = "请先获取可用身份";
    return;
  }
  const targets = peers.filter(
    (peer) => !isSendAsAlreadyRegistered(peer) && state.sendAs.selected.has(String(peer.send_as_id))
  );
  if (!targets.length) {
    if (status) status.textContent = "还没勾选任何未添加的身份";
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = `保存中… (${targets.length})`;
  try {
    const payload = {
      identities: targets.map((peer) => ({
        send_as_id: peer.send_as_id,
        account_local_id: localId,
        label: peer.title || "",
        username: peer.username || "",
        enabled: true,
      })),
    };
    const response = await postJson("/api/identities/batch", payload);
    await loadIdentities();
    renderBatchSaveResult(result, response, peers);
    state.sendAs.selected.clear();
    rerenderSendAsList(rootEl);
    if (status) {
      status.textContent = `本次保存:成功 ${response.saved || 0} / 共 ${response.total || targets.length}。已添加的会自动锁定。`;
    }
  } catch (error) {
    if (result) {
      result.hidden = false;
      result.innerHTML = `<p class="error">${escapeHtml(error.message || "批量保存失败")}</p>`;
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
    updateSendAsBulkSummary(rootEl);
  }
}

function renderBatchSaveResult(container, response, peers) {
  if (!container) return;
  if (!response || !Array.isArray(response.results) || response.results.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const peerById = new Map(peers.map((peer) => [String(peer.send_as_id), peer]));
  const items = response.results.map((entry) => {
    const peer = peerById.get(String(entry.send_as_id ?? ""));
    const title = peer ? (peer.title || peer.send_as_id) : (entry.send_as_id ?? "未知 ID");
    if (entry.ok) {
      return `<li class="ok">✓ ${escapeHtml(String(title))}</li>`;
    }
    return `<li class="warn">✗ ${escapeHtml(String(title))} — ${escapeHtml(entry.error || "保存失败")}</li>`;
  });
  container.hidden = false;
  container.innerHTML = `
    <p>批量保存结果:成功 ${response.saved || 0} / 共 ${response.total || response.results.length}</p>
    <ul class="send-as-result-list">${items.join("")}</ul>
  `;
}

async function hydrateIdentityForm(identityForm, button, root = document) {
  const scope =
    root ||
    identityForm.closest?.(".modal-body, .modal-dialog") ||
    document;
  const status = scope.querySelector("[data-send-as-status]");
  const sendAsValue = identityForm.querySelector('[name="send_as_id"]').value.trim();
  const localId = identityForm.querySelector('[name="account_local_id"]').value
    || scope.querySelector('[data-send-as-field="account"]')?.value
    || "";
  if (!sendAsValue || !localId) {
    if (status) status.textContent = "解析需要先填 send_as_id 并选账号";
    return;
  }
  button.disabled = true;
  if (status) status.textContent = "正在用 Telegram 解析…";
  try {
    const result = await postJson("/api/accounts/resolve-entity", {
      local_id: localId,
      send_as_id: Number(sendAsValue),
    });
    if (!result.ok) {
      throw new Error(result.error || "解析失败");
    }
    const labelInput = identityForm.querySelector('[name="label"]');
    const usernameInput = identityForm.querySelector('[name="username"]');
    if (labelInput && !labelInput.value) labelInput.value = result.label || "";
    if (usernameInput && !usernameInput.value) usernameInput.value = result.username || "";
    if (status) status.textContent = `已解析:${result.label || result.username || result.send_as_id}`;
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function identityPayloadFromForm(form) {
  const data = new FormData(form);
  return {
    send_as_id: data.get("send_as_id"),
    account_local_id: data.get("account_local_id"),
    label: data.get("label"),
    username: data.get("username"),
    note: data.get("note"),
    enabled: data.get("enabled") === "on",
  };
}

function fillIdentityForm(identity, root = document) {
  const form = root.querySelector("#identityForm");
  if (!form) {
    return;
  }
  const values = {
    send_as_id: identity.send_as_id || "",
    account_local_id: identity.account_local_id || "",
    label: identity.label || "",
    username: identity.username || "",
    note: identity.note || "",
  };
  Object.entries(values).forEach(([key, value]) => {
    const field = form.querySelector(`[name="${key}"]`);
    if (field) {
      field.value = value;
    }
  });
  const enabled = form.querySelector('[name="enabled"]');
  if (enabled) {
    enabled.checked = Boolean(identity.enabled);
  }
}

function renderDialogOptions(targetChat) {
  const selected = String(targetChat || "");
  const knownIds = new Set(state.telegramDialogs.map((item) => String(item.id)));
  const currentOption =
    selected && !knownIds.has(selected)
      ? `<option value="${escapeAttr(selected)}" selected>当前手填：${escapeHtml(selected)}</option>`
      : "";
  const options = state.telegramDialogs
    .map((dialog) => {
      const value = String(dialog.id || "");
      const username = dialog.username ? `｜@${dialog.username}` : "";
      const label = `${dialog.title || value}｜${telegramDialogKindLabel(dialog.kind)}｜${value}${username}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `${currentOption}${options}`;
}

function renderTopicOptions(targetTopicId) {
  const selected = String(targetTopicId || "");
  const knownIds = new Set(state.telegramTopics.map((item) => String(item.id)));
  const currentOption =
    selected && !knownIds.has(selected)
      ? `<option value="${escapeAttr(selected)}" selected>当前手填：${escapeHtml(selected)}</option>`
      : "";
  const options = state.telegramTopics
    .map((topic) => {
      const value = String(topic.id || "");
      const label = `${topic.title || value}｜${value}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `${currentOption}${options}`;
}

function telegramDialogKindLabel(kind) {
  if (kind === "supergroup") {
    return "超级群";
  }
  if (kind === "channel") {
    return "频道";
  }
  if (kind === "group") {
    return "群";
  }
  return "会话";
}

async function saveCurrentSettingsFromForm(form) {
  return saveSettings(settingsView().settingsPayloadFromForm(form));
}

function identityById(identityId) {
  const id = Number(identityId || 0);
  return (state.identities || []).find((identity) => Number(identity.send_as_id || 0) === id) || null;
}

function accountForIdentity(identity) {
  if (!identity) return null;
  return (state.accounts || []).find((account) => account.local_id === identity.account_local_id) || null;
}

function ensureActiveIdentity() {
  const previous = Number(state.activeIdentityId || 0) || null;
  if (previous && identityById(previous)) {
    return previous;
  }
  const fallback =
    (state.identities || []).find((identity) => identity.enabled && identityCanSend(identity)) ||
    (state.identities || []).find((identity) => identity.enabled) ||
    (state.identities || [])[0] ||
    null;
  const next = fallback ? Number(fallback.send_as_id || 0) || null : null;
  if (next !== previous) {
    state.activeIdentityId = next;
    state.directSendIdentityId = next;
    state.directSendLastActiveId = next;
    state.identityPatches = [];
    state.identityPatchesOwnerId = next;
    state.identityPatchesLoading = Boolean(next);
    state.identityPatchesRequestSeq += 1;
  }
  return next;
}

async function setActiveIdentity(identityId, options = {}) {
  const next = Number(identityId || 0) || null;
  const current = Number(state.activeIdentityId || 0) || null;
  const resolved = options.toggle && current === next ? null : next;
  if (resolved && !identityById(resolved)) {
    showSkillToast("找不到这个身份", "err");
    return current;
  }
  if (current === resolved) {
    renderIdentityProfileViews();
    renderCultivationModules();
    return resolved;
  }
  state.activeIdentityId = resolved;
  state.directSendIdentityId = resolved;
  state.directSendLastActiveId = resolved;
  clearIdentityPatchesForActive();
  renderCultivationModules();
  if (options.loadPatches !== false) {
    await loadIdentityPatches({ reset: true });
  }
  return resolved;
}

function identityCanSend(identity) {
  const account = accountForIdentity(identity);
  const accountId = Number(account?.account_id || 0);
  const identityId = Number(identity?.send_as_id || 0);
  return Boolean(account && accountId && identityId && accountId === identityId);
}

function identityOptionLabel(identity) {
  const account = accountForIdentity(identity);
  const name = identity?.label || identity?.username || identity?.send_as_id || "未命名身份";
  const accountLabel = account?.label || identity?.account_local_id || "未绑定账号";
  const suffix = identityCanSend(identity) ? "" : "（暂不能发送）";
  return `${name}｜账号 ${accountLabel}${suffix}`;
}

function defaultManualIdentityId() {
  return directComposerView().defaultManualIdentityId(directComposerDeps());
}

function manualSendIdentityOptions(selectedId) {
  return directComposerView().manualSendIdentityOptions(directComposerDeps(), selectedId);
}

function directSendSelectedIdentityId() {
  return directComposerView().directSendSelectedIdentityId(directComposerDeps());
}

function renderDirectSendComposer() {
  return directComposerView().renderDirectSendComposer(directComposerDeps());
}

function setDirectSendStatus(text, kind = "info") {
  return directComposerView().setDirectSendStatus(directComposerDeps(), text, kind);
}

async function sendDirectComposerMessage() {
  if (!directSendInput || !directSendIdentitySelect || !directSendSubmit) return;
  if (!state.identities.length || !state.accounts.length) {
    await Promise.all([loadAccounts(), loadIdentities()]);
  }
  const command = directSendInput.value.trim();
  const identityId = Number(directSendIdentitySelect.value || 0);
  const identity = identityById(identityId);
  if (!identityId || !identity) {
    setDirectSendStatus("请选择发送身份。", "error");
    return;
  }
  if (!identityCanSend(identity)) {
    setDirectSendStatus("当前只支持账号本体身份发送，请切换到可发送身份。", "warn");
    return;
  }
  if (!command) {
    setDirectSendStatus("发送内容不能为空。", "error");
    focusDirectSendInput();
    return;
  }

  directSendSubmit.disabled = true;
  setDirectSendStatus("正在发送...", "info");
  const reply = state.directSendReply;
  const payload = {
    skill_key: "manual_send",
    identity_id: identityId,
    command_override: command,
  };
  if (reply?.chatId) payload.chat_id = reply.chatId;
  if (reply?.replyToMsgId) payload.reply_to_msg_id = reply.replyToMsgId;
  if (reply?.topMsgId) payload.top_msg_id = reply.topMsgId;
  try {
    const result = await postJson("/api/skills/send", payload);
    if (result.ok) {
      setDirectSendStatus(sentStatusText(result, { skillKey: "manual_send", command }), "ok");
      showSkillToast(sentToastText(result, { skillKey: "manual_send", command }), "ok");
      directSendInput.value = "";
      resizeDirectSendInput();
      clearDirectSendReply();
      await refreshChatViewport().catch((err) => console.warn("[direct-send] refresh failed:", err));
    } else {
      setDirectSendStatus(result.error || "发送失败", "error");
      showSkillToast(`❌ ${result.error || "发送失败"}`, "err");
    }
  } catch (error) {
    const message = error.message || "发送出错";
    setDirectSendStatus(message, "error");
    showSkillToast(`❌ ${message}`, "err");
  } finally {
    renderDirectSendComposer();
  }
}

if (selectAllChannels) {
  selectAllChannels.addEventListener("click", () => {
    const next = state.selectedChannels.size === state.channels.length
      ? defaultConversationChannels()
      : state.channels.map((channel) => channel.key);
    applyChannelSelection(next).catch((error) => {
      console.warn("[mini-web] select all channels failed:", error);
      showSkillToast(`频道加载失败: ${error.message || error}`, "err");
    });
  });
}

function defaultConversationChannels() {
  if (state.channels.some((channel) => channel.key === "focus")) {
    return ["focus"];
  }
  return state.channels[0] ? [state.channels[0].key] : [];
}

// viewMode 切换在主界面已下线 — 默认 focus,「全部」走顶部「日志」按钮的 modal。
// setViewMode 留给跳转跨视图等内部调用,但不再绑按钮。
function setViewMode(mode) {
  if (!["focus", "solo"].includes(mode)) return;
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  state.detailMode = "message";
  if (state.selectedMessageId && !visibleMessages().some((m) => m.id === state.selectedMessageId)) {
    state.selectedMessageId = null;
    setWorkspacePanelOpen(false);
  }
  renderMessages();
  renderDetail();
}

if (jumpToLatestButton && messageList) {
  messageList.addEventListener("scroll", updateJumpToLatestVisibility, { passive: true });
  jumpToLatestButton.addEventListener("click", () => {
    scrollMessageListToLatest({ behavior: "smooth" });
  });
}

if (messageSearchInput) {
  messageSearchInput.addEventListener("input", () => {
    state.messageSearch = messageSearchInput.value || "";
    if (state.selectedMessageId && !visibleMessages().some((m) => m.id === state.selectedMessageId)) {
      state.selectedMessageId = null;
      setWorkspacePanelOpen(false);
    }
    renderMessages();
    renderDirectSendComposer();
    renderDetail();
  });
  messageSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!messageSearchInput.value) return;
    messageSearchInput.value = "";
    state.messageSearch = "";
    renderMessages();
    renderActiveChannelText();
  });
}

if (closeDetailButton) {
  closeDetailButton.addEventListener("click", () => closeWorkspacePanel({ clearSelection: false }));
}

if (detailBackdrop) {
  detailBackdrop.addEventListener("click", () => closeWorkspacePanel({ clearSelection: false }));
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (modalRoot && !modalRoot.hidden) return;
  document.querySelectorAll("details[open]").forEach((node) => node.removeAttribute("open"));
  if (layoutGrid?.classList.contains("detail-open")) {
    closeWorkspacePanel({ clearSelection: false });
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  document.querySelectorAll(".workspace-tools-shell[open], .stream-filter-drawer[open], .direct-send-more[open]").forEach((node) => {
    if (!node.contains(target)) {
      node.removeAttribute("open");
    }
  });
});

refreshButton.addEventListener("click", async () => {
  if (state.refreshState === "loading") {
    return;
  }
  state.refreshState = "loading";
  const original = refreshButton.textContent;
  refreshButton.textContent = "正在刷新…";
  refreshButton.disabled = true;
  try {
    await Promise.all([
      refreshChatViewport(),
      loadIdentityPatches(),
      loadIdentityModuleStates(),
      loadWorldSnapshot({ silent: true }),
      loadScheduleRail({ silent: true }),
    ]);
  } catch (error) {
    showError(error);
  } finally {
    state.refreshState = "idle";
    refreshButton.textContent = original;
    refreshButton.disabled = false;
  }
});

if (healthButton) {
  healthButton.addEventListener("click", async () => {
    try {
      await openHealthModal();
    } catch (error) {
      showError(error);
    }
  });
}

directComposerView().bindDirectComposer(directComposerDeps());

outboxButton.addEventListener("click", async () => {
  try {
    outboxButton.closest("details")?.removeAttribute("open");
    await renderOutboxDraftsView();
  } catch (error) {
    showError(error);
  }
});

scheduleButton.addEventListener("click", async () => {
  try {
    scheduleButton.closest("details")?.removeAttribute("open");
    await Promise.all([loadAccounts(), loadIdentities()]);
    await openScheduleModal();
  } catch (error) {
    showError(error);
  }
});

if (scheduleRailRefreshButton) {
  scheduleRailRefreshButton.addEventListener("click", async () => {
    const original = scheduleRailRefreshButton.textContent;
    scheduleRailRefreshButton.textContent = "读取中";
    scheduleRailRefreshButton.disabled = true;
    try {
      await loadScheduleRail();
    } catch (error) {
      showError(error);
    } finally {
      scheduleRailRefreshButton.textContent = original;
      scheduleRailRefreshButton.disabled = false;
    }
  });
}

if (resourceStatsButton) {
  resourceStatsButton.addEventListener("click", async () => {
    try {
      resourceStatsButton.closest("details")?.removeAttribute("open");
      await openResourceStatsModal();
    } catch (error) {
      showError(error);
    }
  });
}

if (dungeonStatusButton) {
  dungeonStatusButton.addEventListener("click", async () => {
    try {
      dungeonStatusButton.closest("details")?.removeAttribute("open");
      await openDungeonStatusModal();
    } catch (error) {
      showError(error);
    }
  });
}

if (inventoryButton) {
  inventoryButton.addEventListener("click", async () => {
    try {
      inventoryButton.closest("details")?.removeAttribute("open");
      await openInventoryModal();
    } catch (error) {
      showError(error);
    }
  });
}

if (settingsButton) {
  settingsButton.addEventListener("click", async () => {
    try {
      settingsButton.closest("details")?.removeAttribute("open");
      await Promise.all([loadAccounts(), loadIdentities()]);
      renderSettings(state.settings || (await loadSettings()));
    } catch (error) {
      showError(error);
    }
  });
}

if (loginAccountButton) {
  loginAccountButton.addEventListener("click", async () => {
    try {
      loginAccountButton.closest("details")?.removeAttribute("open");
      await loadAccounts();
      openAccountModal(null);
    } catch (error) {
      console.error("[mini-web] login click failed:", error);
      showError(error);
    }
  });
} else {
  console.warn("[mini-web] loginAccountButton not found at bind time");
}

if (addIdentityButton) {
  addIdentityButton.addEventListener("click", async () => {
    try {
      addIdentityButton.closest("details")?.removeAttribute("open");
      await Promise.all([loadAccounts(), loadIdentities()]);
      openAddIdentityModal();
    } catch (error) {
      console.error("[mini-web] add-identity failed:", error);
      showError(error);
    }
  });
} else {
  console.warn("[mini-web] addIdentityButton not found at bind time");
}

if (logoutAccountButton) {
  logoutAccountButton.addEventListener("click", async () => {
    try {
      logoutAccountButton.closest("details")?.removeAttribute("open");
      await Promise.all([loadAccounts(), loadIdentities()]);
      openLogoutAccountModal();
    } catch (error) {
      console.error("[mini-web] logout failed:", error);
      showError(error);
    }
  });
} else {
  console.warn("[mini-web] logoutAccountButton not found at bind time");
}

if (gameBotsButton) {
  gameBotsButton.addEventListener("click", () => {
    gameBotsButton.closest("details")?.removeAttribute("open");
    openGameBotsModal();
  });
}

if (filterSettingsButton) {
  filterSettingsButton.addEventListener("click", () => {
    filterSettingsButton.closest("details")?.removeAttribute("open");
    openFilterSettingsModal();
  });
}

if (notifySettingsButton) {
  notifySettingsButton.addEventListener("click", () => {
    notifySettingsButton.closest("details")?.removeAttribute("open");
    openNotifySettingsModal();
  });
}

if (logsButton) {
  logsButton.addEventListener("click", () => openLogsModal());
}

async function openLogsModal() {
  window.MiniwebViews.logs.openLogsModal({
    channels: state.channels || [],
    renderTelegramTextHtml,
  });
}

function startupTask(label, task) {
  return Promise.resolve()
    .then(task)
    .catch((err) => {
      console.warn(`[mini-web] ${label} failed:`, err);
      return null;
    });
}

async function bootstrapApp() {
  try {
    await loadChannels();
    await refreshChatViewport({ incremental: false });
  } catch (error) {
    showError(error);
    return;
  }

  const settingsReady = startupTask("initial settings", async () => {
    await loadSettings();
    renderMessages();
    renderGameCockpit();
  });
  const accountsReady = startupTask("initial accounts", loadAccounts);
  const identitiesReady = accountsReady.then(() => startupTask("initial identities", loadIdentities));

  startupTask("initial schedule rail", () => loadScheduleRail({ silent: true }));
  startupTask("initial world snapshot", () => loadWorldSnapshot({ silent: true }));
  settingsReady.then(() => startupTask("initial bot discovery", loadDiscoveredBots));
  settingsReady.then(() => startupTask("initial message audit", () => loadMessageAudit({ silent: true })));
  identitiesReady.then(() => startupTask("initial identity patches", () => loadIdentityPatches({ reset: true })));
  identitiesReady.then(() => startupTask("initial skills", loadSkills));
}

bootstrapApp();

// ---------- 技能盘(底栏)----------

async function loadSkills() {
  try {
    const data = await fetchJson("/api/skills");
    state.skills = data.skills || [];
    state.skillGroups = data.groups || [];
    state.realmOrder = data.realm_order || [];
    if (state.skillGroups.length && !state.skillGroups.includes(state.skillBarTab)) {
      state.skillBarTab = state.skillGroups[0];
    }
  } catch (err) {
    console.warn("[skills] load failed", err);
  }
  renderSkillViews();
}

// 当前激活身份的宗门 / 境界 — 从 identity_profile state_patches 拿。
// 拿不到就返空(那时 sect/realm 都视为「未知」,不过滤)。
function currentIdentitySect() {
  const patches = activeIdentityPatches();
  const raw = (patches.find((p) => p.key === "宗门") || {}).value || "";
  return String(raw || "").replace(/^【|】$/g, "").trim();
}

function currentIdentityRealm() {
  const patches = activeIdentityPatches();
  return String((patches.find((p) => p.key === "境界") || {}).value || "").trim();
}

function realmIndex(realmName) {
  if (!realmName) return -1;
  const order = state.realmOrder || [];
  return order.indexOf(realmName);
}

function skillIsUnlocked(skill) {
  // sect 限定:有标且当前 sect 已知则必须匹配;未知就放行
  if (skill.sect) {
    const cur = currentIdentitySect();
    if (cur && cur !== skill.sect) return false;
  }
  // realm 限定:有标且当前 realm 已知则必须 >=;未知就放行
  if (skill.realm_min) {
    const cur = currentIdentityRealm();
    if (cur) {
      const need = realmIndex(skill.realm_min);
      const have = realmIndex(cur);
      if (need >= 0 && have >= 0 && have < need) return false;
    }
  }
  return true;
}

function renderSkillBar() {
  return directComposerView().renderSkillBar(directComposerDeps());
}

function renderSkillMenuModal() {
  return directComposerView().renderSkillMenuModal(directComposerDeps());
}

function renderSkillViews() {
  renderSkillBar();
  renderSkillMenuModal();
  renderQuickActionHotbar();
  renderQuestTracker();
  renderLiveSituationBoard();
  renderGameSceneBoard();
  renderGameActionDock();
}

const HOTBAR_ROWS = directComposerView().HOTBAR_ROWS;
const HOTBAR_VISIBLE_SLOTS = directComposerView().HOTBAR_VISIBLE_SLOTS;

function hotbarSkillGroups() {
  return directComposerView().hotbarSkillGroups(directComposerDeps());
}

function hotbarSkillScore(skill) {
  return directComposerView().hotbarSkillScore(skill);
}

function quickActionHotbarSkills() {
  return directComposerView().quickActionHotbarSkills(directComposerDeps());
}

function renderQuickActionHotbar() {
  return directComposerView().renderQuickActionHotbar(directComposerDeps());
}

function openSkillMenuModal() {
  return directComposerView().openSkillMenuModal(directComposerDeps());
}

function renderSkillPanel(tabsEl, chipsEl, identityEl, rerender) {
  return directComposerView().renderSkillPanel(directComposerDeps(), tabsEl, chipsEl, identityEl, rerender);
}

function fillSkillIntoComposer(skillKey, button = null) {
  return directComposerView().fillSkillIntoComposer(directComposerDeps(), skillKey, button);
}

function showSkillToast(text, kind) {
  window.MiniwebToast.showToast(text, kind);
}

// 自动轮询消息流(只在 chat 视图 + 页面可见时拉,避免 tab 切走还在打)。
// listener 持续 ingest 新消息进 SQLite,这里负责把它们端到 UI。
let pollTimer = null;
let pollInflight = false;
let nextAccountsPollAt = 0;
let nextBotDiscoveryPollAt = 0;
let nextIdentityStatePollAt = 0;
let nextHealthPollAt = 0;
let nextWorldSnapshotPollAt = 0;
let nextSchedulePollAt = 0;

async function pollTick() {
  if (pollInflight) return;
  if (document.hidden) return;
  if (state.refreshState === "loading") return;
  pollInflight = true;
  try {
    // 即使用户切到草稿箱/官方定时视图,后台也继续把新消息 merge 进 state,
    // 这样切回 chat 时立刻看见最新的。listener 写得很快,前端再不跟就脱节。
    const now = Date.now();
    const tasks = [refreshChatViewport({ incremental: true })];
    if (now >= nextAccountsPollAt) {
      nextAccountsPollAt = now + ACCOUNT_POLL_INTERVAL_MS;
      tasks.push(loadAccounts().catch((err) => console.warn("[mini-web] accounts poll failed:", err)));
    }
    if (now >= nextBotDiscoveryPollAt) {
      nextBotDiscoveryPollAt = now + BOT_DISCOVERY_POLL_INTERVAL_MS;
      tasks.push(loadDiscoveredBots().catch((err) => console.warn("[mini-web] bot discovery poll failed:", err)));
    }
    if (now >= nextHealthPollAt) {
      nextHealthPollAt = now + HEALTH_POLL_INTERVAL_MS;
      tasks.push(loadMessageAudit({ silent: true }).catch((err) => console.warn("[mini-web] health poll failed:", err)));
    }
    if (now >= nextWorldSnapshotPollAt) {
      nextWorldSnapshotPollAt = now + WORLD_SNAPSHOT_POLL_INTERVAL_MS;
      tasks.push(loadWorldSnapshot({ silent: true }).catch((err) => console.warn("[mini-web] world snapshot poll failed:", err)));
    }
    if (now >= nextSchedulePollAt) {
      nextSchedulePollAt = now + ACCOUNT_POLL_INTERVAL_MS;
      tasks.push(loadScheduleRail({ silent: true }).catch((err) => console.warn("[mini-web] schedule rail poll failed:", err)));
    }
    const [messageResult] = await Promise.all(tasks);
    if ((messageResult && messageResult.changed) || now >= nextIdentityStatePollAt) {
      nextIdentityStatePollAt = now + IDENTITY_STATE_POLL_INTERVAL_MS;
      await loadIdentityModuleStates().catch(() => {});
    }
  } catch (error) {
    console.warn("[mini-web] poll tick failed:", error);
  } finally {
    pollInflight = false;
  }
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(pollTick, POLL_INTERVAL_MS);
  // module chip 每秒倒计时本地 tick(不走网络),独立于 polling
  if (window._moduleChipTimer == null) {
    window._moduleChipTimer = window.setInterval(tickIdentityModuleChips, 1000);
  }
}

function stopPolling() {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    pollTick();
    startPolling();
  }
});

startPolling();
