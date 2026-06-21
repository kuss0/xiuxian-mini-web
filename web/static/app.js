// MINIWEB-BUILD: chat-client-shell 2026-05-21T04:42

const CHAT_FEATURE_ENABLED = false;

const { state } = window.MiniwebState;
const {
  ACCOUNT_POLL_INTERVAL_MS,
  BOT_DISCOVERY_POLL_INTERVAL_MS,
  CHANNEL_SUMMARY_LIMIT,
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
  displayDayIndex,
  displayTimeParts,
  formatDisplayClockTime,
  formatDisplayMonthDayTime,
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
const outboxButton = document.querySelector("#outboxButton");
const scheduleButton = document.querySelector("#scheduleButton");
const scheduleRail = document.querySelector("#scheduleRail");
const scheduleRailRefreshButton = document.querySelector("#scheduleRailRefreshButton");
const scheduleIdentityQuickSelect = document.querySelector("#scheduleIdentityQuickSelect");
const scheduleIdentityFollowChatButton = document.querySelector("#scheduleIdentityFollowChatButton");
const scheduleIdentityQuickMeta = document.querySelector("#scheduleIdentityQuickMeta");
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
const sidebarIdentityList = document.querySelector("#identityList");
const currentAccountLine = document.querySelector("#currentAccountLine");
const activeIdentityDock = document.querySelector("#activeIdentityDock");
const activeIdentityQuickSelect = document.querySelector("#activeIdentityQuickSelect");
const activeIdentityStatusButton = document.querySelector("#activeIdentityStatusButton");
const activeIdentityQuickMeta = document.querySelector("#activeIdentityQuickMeta");
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
    min_gap_seconds: "60",
    min_missing_msg_ids: "20",
    limit: "12",
  });
  if (deep) params.set("deep", "1");
  const payload = await fetchJson(`/api/message-audit?${params.toString()}`);
  state.messageAudit = payload;
  renderGameCockpit();
  updateGlobalBanner();
  return payload;
}

async function backfillMessageGaps(payload = {}) {
  const result = await postJson("/api/message-audit/backfill", {
    since_hours: 24,
    min_gap_seconds: 60,
    min_missing_msg_ids: 20,
    limit: 8,
    time_budget_sec: 30,
    ...(payload || {}),
  });
  if (result.audit) {
    state.messageAudit = result.audit;
    renderGameCockpit();
    updateGlobalBanner();
  }
  return result;
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
  if (!CHAT_FEATURE_ENABLED) {
    if (!incremental) {
      state.messageLoading = false;
      state.messageError = "";
      state.lastMessageSeq = 0;
      state.messages = [];
      state.channelSummaryMessages = [];
      state.channelSummarySeq = 0;
      state.selectedMessageId = null;
      state.detailMode = "message";
      state.chatUnreadCount = 0;
      state.messageRenderDeferred = false;
    }
    return { changed: false, count: 0 };
  }
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
  if (!CHAT_FEATURE_ENABLED) {
    if (!incremental) {
      state.messageLoading = false;
      state.messageError = "";
      state.lastMessageSeq = Math.max(0, Number(state.channelSummarySeq || 0));
      state.messages = [];
      state.selectedMessageId = null;
      state.detailMode = "message";
    }
    return { changed: false, count: 0 };
  }
  // 增量:轮询用,只拉 rowid > lastSeq 的新卡片(可能 0 条)
  // 初始化:首次/手动刷新用,拉最近 200 条
  // channel/channels:默认 focus(重点流);多频道组合由后端 OR 过滤;日志按钮单独走全量 modal
  if (state.channels.length > 0 && selectedChannelKeys().length === 0) {
    if (!incremental) {
      state.messageLoading = false;
      state.messageError = "";
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
  if (!incremental) {
    state.messageLoading = true;
    state.messageError = "";
    renderMessages();
  }
  let payload;
  try {
    payload = await fetchJson(`/api/messages?${params.toString()}`);
  } catch (error) {
    if (!incremental) {
      state.messageLoading = false;
      state.messageError = error?.message || String(error || "读取消息失败");
      renderMessages();
    }
    throw error;
  }
  const incoming = payload.messages || [];
  const serverMax = Number(payload.max_seq || 0);
  const wasNearLatest = !incremental || isMessageListNearLatest();

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
    const unseenIncomingCount = incoming.filter((card) => !byId.has(card.id) && messageMatchesSearch(card)).length;
    for (const card of incoming) {
      byId.set(card.id, card);  // 同 id 的会被新版本覆盖(支持 edit)
    }
    state.messages = sortMessagesByRecency(Array.from(byId.values()));
    state.chatUnreadCount = wasNearLatest ? 0 : Math.min(999, Number(state.chatUnreadCount || 0) + unseenIncomingCount);
  } else {
    // 初始化:直接替换
    state.messages = sortMessagesByRecency(incoming);
    state.chatUnreadCount = 0;
    state.messageLoading = false;
    state.messageError = "";
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
  if (incremental && !wasNearLatest) {
    deferMessageRenderUntilLatest();
  } else {
    state.messageRenderDeferred = false;
    renderMessages();
  }
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
  renderActiveIdentityDock();
  renderScheduleIdentityDock();
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
  if (activeChanged) {
    syncScheduleSelectionToActiveIdentity();
  }
  renderSidebarIdentityList();
  renderActiveIdentityDock();
  renderSkillViews();
  renderScheduleIdentityDock();
  renderScheduleRail();
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
    state.identityStateObservationSummary = payload.observation_summary || {};
    renderSidebarIdentityList();
    renderActiveIdentityDock();
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
  renderActiveIdentityDock();
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

function globalBannerDeps() {
  return {
    state,
    globalBanner,
    openHealthModal,
    openGameBotsModal,
  };
}

function globalBannerView() {
  return window.MiniwebViews.globalBanner;
}

function currentGameBotIds() {
  return globalBannerView().currentGameBotIds(globalBannerDeps());
}

function updateGlobalBanner() {
  return globalBannerView().updateGlobalBanner(globalBannerDeps());
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
    openScheduleModuleQuickModal,
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
    loadWorldReportPayload: async () => {
      const [health, dungeon, resource, leader, priority] = await Promise.all([
        fetchJson("/api/health"),
        fetchJson("/api/dungeon-status?limit=90&summary_limit=3&order=recent"),
        fetchJson("/api/resource-stats?period=day&source_type=all&limit=120"),
        fetchJson("/api/messages?channel=leader&limit=6"),
        fetchJson("/api/messages?channels=risk,focus&limit=16&compact=1"),
      ]);
      return { health, dungeon, resource, leader, priority };
    },
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
    loadLeaderMessages: () => fetchJson("/api/messages?channel=leader&limit=100"),
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
    loadAccounts,
    loadIdentities,
    renderGameCockpit,
    renderSkillViews,
    openScheduleModal,
    openScheduleModuleQuickModal,
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

function manualMessagePreview(message) {
  if (!message) return "";
  const raw = String(message.raw || message.summary || message.title || "").trim();
  const compact = clipGraphemes(raw.replace(/\s+/g, " "), 120);
  const source = displaySource(message.source);
  const msgId = message.msg_id ? `#${message.msg_id}` : message.id || "";
  return `${source} ${msgId}${compact ? `: ${compact}` : ""}`;
}

function directReplyContextFromAction(action, fallbackMessage = null) {
  if (!action) return null;
  const chatId = Number(action.chat_id || fallbackMessage?.chat_id || 0);
  const replyToMsgId = Number(action.reply_to_msg_id || 0);
  if (!chatId || !replyToMsgId) return null;
  const parent =
    (state.messages || []).find((message) =>
      Number(message.chat_id || 0) === chatId &&
      Number(message.msg_id || 0) === replyToMsgId
    ) || fallbackMessage;
  return {
    messageId: parent?.id || `tg:${chatId}:${replyToMsgId}`,
    chatId,
    replyToMsgId,
    topMsgId: Number(action.top_msg_id || parent?.top_msg_id || 0) || null,
    source: parent ? displaySource(parent.source) : "Telegram 消息",
    preview: parent ? manualMessagePreview(parent) : `回复消息 #${replyToMsgId}`,
  };
}

function setWorkspaceSelectedMessage(message, { rerenderList = true } = {}) {
  if (!CHAT_FEATURE_ENABLED) {
    showSkillToast("聊天视图已移除,请从记录面板查看原消息。", "warn");
    return;
  }
  if (!message) return;
  state.detailMode = "message";
  state.selectedMessageId = message.id;
  setWorkspacePanelOpen(true);
  if (rerenderList) renderMessages();
  renderDirectSendComposer();
  renderDetail().catch((error) => console.warn("[mini-web] render selected detail failed:", error));
}

function selectMessageForComposer(message, { rerenderList = true } = {}) {
  if (!CHAT_FEATURE_ENABLED) {
    showSkillToast("聊天发送栏已移除。", "warn");
    return;
  }
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
  if (!CHAT_FEATURE_ENABLED) {
    showSkillToast("聊天详情面板已移除。", "warn");
    return;
  }
  state.detailMode = "overview";
  state.selectedMessageId = null;
  setWorkspacePanelOpen(true);
  renderMessages();
  renderDirectSendComposer();
  renderDetail().catch((error) => console.warn("[mini-web] render overview detail failed:", error));
}

function fillDirectSendComposer(command, opts = {}) {
  void command;
  void opts;
  showSkillToast("聊天发送栏已移除,请改用草稿箱或官方定时。", "warn");
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
  return formatDisplayMonthDayTime(text) || text.replace("T", " ").replace(/\+.+$/, "");
}

async function openHealthModal() {
  await window.MiniwebViews.health.openHealthModal({
    auditTimeLabel,
    formatChatTime,
    getInitialAudit: () => state.messageAudit,
    healthStatusLabel,
    listenerStatusText,
    loadMessageAudit,
    backfillMessageGaps,
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
    loadFilterDiagnostics: () => fetchJson("/api/filter/diagnostics?limit=1000"),
    muteFocusSenderId,
    previewFocusExcludePattern: (payload) => postJson("/api/focus-exclude/preview", payload),
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
    loadDungeonStatus: ({ scanLimit, summaryLimit }) => fetchJson(`/api/dungeon-status?limit=${scanLimit}&summary_limit=${encodeURIComponent(summaryLimit)}&order=recent`),
    loadCangkunGuide: () => fetchJson("/api/cangkun-guide"),
    loadXutianOracleGuide: () => fetchJson("/api/xutian-oracle-guide"),
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
    loadXutianOracleGuide: () => fetchJson("/api/xutian-oracle-guide"),
  });
}

async function openCangkunGuideModal() {
  await window.MiniwebViews.cangkunGuide.openCangkunGuideModal({
    fillCommand: (command) => fillDirectSendComposer(command, {
      statusText: "已填入苍坤洞府命令，请确认后发送。",
      statusKind: "info",
    }),
    loadCangkunGuide: () => fetchJson("/api/cangkun-guide"),
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
    loadNotifyCardTitles: () => fetchJson("/api/notify/card-titles"),
    loadSettings,
    saveSettings,
    sendNotifyTest: () => postJson("/api/notify/test", {}),
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

async function planOutboxAction(action) {
  const data = await postJson("/api/outbox/plan", { action });
  state.outboxPlan = data;
  return data;
}

function visibleMessages() {
  return [];
}

function messageMatchesSearch(message) {
  const query = String(state.messageSearch || "").trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    message?.title,
    message?.summary,
    message?.raw,
    message?.source,
    ...(message?.tags || []),
  ].map((item) => String(item || "").toLowerCase()).join("\n");
  return haystack.includes(query);
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
  if (!CHAT_FEATURE_ENABLED) {
    const known = new Set(state.channels.map((channel) => channel.key));
    const filtered = [...(nextChannels || [])].filter((key) => known.has(key));
    state.selectedChannels = new Set(filtered);
    state.lastMessageSeq = 0;
    state.messages = [];
    state.selectedMessageId = null;
    return refreshChatViewport({ incremental: false });
  }
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
  if (!card) return null;
  const replyTo = Number(card.reply_to_msg_id || 0);
  const chatId = Number(card.chat_id || 0);
  if (!replyTo || !chatId) return null;
  return (state.messages || []).find((message) =>
    Number(message.chat_id || 0) === chatId &&
    Number(message.msg_id || 0) === replyTo
  ) || null;
}

function jumpToMessage(target) {
  if (!CHAT_FEATURE_ENABLED) {
    showSkillToast("聊天视图已移除,请从记录面板检索原消息。", "warn");
    return;
  }
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
  const parent = parentMessageOf(message);
  if (!parent) return "";
  return `<div class="reply-context"><span>${escapeHtml(displaySource(parent.source))}</span><small>${escapeHtml(parent.summary || parent.title || "")}</small></div>`;
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
  return;
}

function orderedChannelsForConversationList(latestByChannel = null) {
  void latestByChannel;
  return [...(state.channels || [])];
}

function channelTooltip(channel, latest) {
  const label = channel?.label || channel?.key || "频道";
  const latestText = latest ? `${formatChatTime(latest.time)} ${displaySource(latest.source)}: ${latest.summary || latest.title || ""}`.trim() : "";
  return latestText ? `${label}\n${latestText}` : label;
}

function latestMessagesByChannel() {
  const byChannel = new Map();
  for (const message of summarySignalMessages()) {
    const channels = message.channels || [message.channel || "all"];
    for (const channel of channels) {
      if (!byChannel.has(channel) || compareMessagesByRecency(message, byChannel.get(channel)) < 0) {
        byChannel.set(channel, message);
      }
    }
  }
  return byChannel;
}

function latestMessageForChannel(channelKey) {
  return latestMessagesByChannel().get(channelKey) || null;
}

function channelPreviewText(message, channel) {
  if (!message) return channel?.description || "暂无消息";
  return `${displaySource(message.source)}: ${clipGraphemes(message.summary || message.title || message.raw || "", 90)}`;
}

function channelIcon(key, label) {
  const text = String(label || key || "?").trim();
  return firstGrapheme(text).toUpperCase() || "?";
}

function quickFilterIsAll() {
  return state.selectedChannels.size === state.channels.length;
}

function quickFilterActiveKey() {
  return quickFilterIsAll() ? "all" : [...state.selectedChannels].sort().join(",");
}

function renderQuickFilters() {
  return;
}

async function applyQuickFilter(key) {
  void key;
  return { changed: false, count: 0 };
}

function activeQuickFilterKeyForSelection() {
  return quickFilterActiveKey();
}

function quickFilterKnownChannels(preset) {
  const known = new Set((state.channels || []).map((channel) => channel.key));
  return (preset?.channels || []).filter((key) => known.has(key));
}

function quickFilterCount(preset, counts) {
  return quickFilterKnownChannels(preset).reduce((total, key) => total + Number(counts?.get?.(key) || counts?.[key] || 0), 0);
}

function channelMessageCounts() {
  const counts = new Map();
  for (const message of summarySignalMessages()) {
    for (const channel of message.channels || [message.channel || "all"]) {
      counts.set(channel, (counts.get(channel) || 0) + 1);
    }
  }
  return counts;
}

function renderIdentitySnapshot() {
  return identityManagementView().renderIdentitySnapshot(identityManagementDeps(), identitySnapshot);
}

function copyToClipboardSilent(text) {
  if (!text) return;
  try {
    navigator.clipboard.writeText(text);
  } catch (_e) { /* noop */ }
}

function renderActiveChannelText() {
  return;
}

function renderMessages() {
  return;
}

function deferMessageRenderUntilLatest() {
  state.messageRenderDeferred = true;
  updateJumpToLatestVisibility();
}

function flushDeferredMessageRender({ toLatest = false, behavior = "auto" } = {}) {
  if (!state.messageRenderDeferred) return false;
  state.messageRenderDeferred = false;
  renderMessages();
  if (toLatest) {
    scrollMessageListToLatest({ behavior });
  }
  return true;
}

function isMessageListNearLatest(threshold = 120) {
  if (!messageList) return true;
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= threshold;
}

function updateJumpToLatestVisibility() {
  if (!jumpToLatestButton) return;
  jumpToLatestButton.hidden = true;
}

function scrollMessageListToLatest({ behavior = "auto" } = {}) {
  if (!messageList) return;
  messageList.scrollTo({ top: messageList.scrollHeight, behavior });
}

function captureMessageScrollSnapshot() {
  if (!messageList) return null;
  return { top: messageList.scrollTop, bottom: messageList.scrollHeight - messageList.scrollTop };
}

function restoreMessageScrollSnapshot(snapshot) {
  if (!messageList || !snapshot) return;
  messageList.scrollTop = Math.max(0, messageList.scrollHeight - Number(snapshot.bottom || 0));
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
  if (state.messageLoading && state.messages.length === 0) {
    return "正在读取消息...";
  }
  if (state.messageError && state.messages.length === 0) {
    return `消息读取失败: ${state.messageError}`;
  }
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
  return "";
}

function renderChatContextMeta(message) {
  return "";
}

function visibleMessageBadges(message) {
  return [];
}

function renderChatQuickActions(message) {
  return "";
}

function quickActionLabel(action) {
  const rawLabel = String(action?.label || "").trim();
  const command = String(action?.command || "").trim();
  const cleaned = rawLabel
    .replace(/^复制\s*/, "")
    .replace(/[（(]回复[）)]/g, "")
    .trim();
  if (cleaned && cleaned.length <= 12) return cleaned;
  return command.replace(/^[.。]/, "").trim() || "动作";
}

function quickActionNeedsManualReview(action) {
  const command = String(action?.command || "").trim();
  return command === ".自证" || command === "。自证";
}

async function handleChatQuickAction(message, index, button) {
  showSkillToast("聊天快捷动作已移除,请改用草稿箱或官方定时。", "warn");
}

function displaySource(source) {
  const clean = String(source || "").trim();
  if (!clean) return "未知发送者";
  return isNumericSource(clean) ? `用户 ${clean}` : clean;
}

function isNumericSource(source) {
  const clean = String(source || "").trim();
  return clean !== "" && NUMERIC_SOURCE_RE.test(clean);
}

function renderChatBodyText(message, isExpanded) {
  const raw = String(message?.raw || "").trim();
  const fallback = String(message?.summary || message?.title || "").trim();
  const text = raw || fallback || "（空消息）";
  const lines = text.split("\n");
  const tooLong = countGraphemes(text) > MESSAGE_PREVIEW_CHAR_LIMIT || lines.length > MESSAGE_PREVIEW_LINE_LIMIT;
  if (!tooLong || isExpanded) {
    return { html: renderTelegramTextHtml(text, message), truncated: tooLong };
  }
  let preview = lines.slice(0, MESSAGE_PREVIEW_LINE_LIMIT).join("\n");
  if (countGraphemes(preview) > MESSAGE_PREVIEW_CHAR_LIMIT) {
    preview = clipGraphemes(preview, MESSAGE_PREVIEW_CHAR_LIMIT);
  }
  return { html: `${renderTelegramTextHtml(preview, message)}<span class="chat-text-ellipsis">…</span>`, truncated: true };
}

function groupMessagesByDate(messages) {
  const groups = [];
  let current = null;
  for (const message of messages || []) {
    const label = formatDayLabel(message.time);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(message);
  }
  return groups;
}

function formatDayLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "时间未知";
  const parts = displayTimeParts(text);
  if (!parts) return text;
  const diffDays = daysBetween(text, new Date());
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "前天";
  const nowParts = displayTimeParts(new Date());
  if (parts.year === nowParts?.year) {
    return `${Number(parts.month)} 月 ${Number(parts.day)} 日`;
  }
  return `${parts.year} 年 ${Number(parts.month)} 月 ${Number(parts.day)} 日`;
}

function daysBetween(date, now) {
  const a = displayDayIndex(date);
  const b = displayDayIndex(now);
  if (a === null || b === null) return 0;
  return b - a;
}

function formatChatTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return formatDisplayClockTime(text) || text;
}

function messageKind(message) {
  const channels = message?.channels || [message?.channel];
  const source = String(message?.source || "");
  if (message?.severity === "risk" || channels.includes("risk")) return "risk";
  if (isPersonalSignal(message)) return "mine";
  if (message?.sender_is_bot || channels.includes("system") || source.includes("韩天尊") || source.includes("天尊")) return "bot";
  return "player";
}

function sourceInitial(source, kind) {
  const clean = String(source || "").replace(/^@/, "").trim();
  if (kind === "risk") return "!";
  if (clean.includes("韩天尊") || clean.includes("天尊")) return "天";
  if (!clean) return "?";
  return firstGrapheme(clean).toUpperCase();
}

async function renderDetail() {
  return;
}

function renderFocusInsight(message) {
  return "";
}

function actionCountLabel(message) {
  const count = (message?.actions || []).length;
  return count ? `${count} 个动作` : "无动作";
}

function renderFocusTools(message) {
  return "";
}

function focusReasonList(message) {
  return message?.filter_reasons || [];
}

function canFocusArchiveMessage(message) {
  return false;
}

function isFocusMutedSenderId(senderId) {
  const id = Number(senderId || 0);
  if (!id) return false;
  return ((state.settings || {}).focus_muted_sender_ids || []).map(Number).includes(id);
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
  return "";
}

function renderActionContextLine(action) {
  return "";
}

function bindDetailActions(message) {
  return;
}

function openFocusArchiveModal(message, mode) {
  window.MiniwebViews.focusArchive.openFocusArchiveModal({
    applyFocusExcludePattern,
    formatChatTime,
    message,
    mode,
    previewFocusExcludePattern: (payload) => postJson("/api/focus-exclude/preview", payload),
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
    loadTianjigeStatus: () => fetchJson("/api/tianjige/status"),
    loadTelegramDialogs,
    loadTelegramTopics,
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

function identityManagementView() {
  return window.MiniwebViews.identityManagement;
}

function identityManagementDeps() {
  return {
    state,
    activeIdentityPatches,
    batchSaveIdentities: (identities) => postJson("/api/identities/batch", { identities }),
    closeModal,
    identityKindLabel,
    loadIdentities,
    loadSendAsPeers: (localId, targetChat) => {
      const params = new URLSearchParams({ local_id: localId });
      if (targetChat) {
        params.set("target_chat", targetChat);
      }
      return fetchJson(`/api/accounts/send-as-peers?${params.toString()}`);
    },
    moduleStartTs,
    fmtCountdown,
    openLogoutAccountModal,
    renderCultivationModules,
    resolveAccountEntity: (localId, sendAsId) => postJson("/api/accounts/resolve-entity", {
      local_id: localId,
      send_as_id: Number(sendAsId),
    }),
    saveIdentity: (payload) => postJson("/api/identities", payload),
    setActiveIdentity,
    showSkillToast,
  };
}

function renderAddIdentityModalBody() {
  return identityManagementView().renderAddIdentityModalBody(identityManagementDeps());
}

function renderSidebarIdentityList() {
  return identityManagementView().renderSidebarIdentityList(identityManagementDeps(), sidebarIdentityList);
}

function renderIdentityModulesLine(sendAsId) {
  return identityManagementView().renderIdentityModulesLine(identityManagementDeps(), sendAsId);
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

function tickIdentityModuleChips() {
  tickCultivationModules();
  tickCockpitModuleChips();
  tickIdentityStatusCards();
  identityManagementView().tickSidebarIdentityModuleChips(identityManagementDeps(), sidebarIdentityList);
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

function updateCurrentAccountLine() {
  return accountManagementView().updateCurrentAccountLine(accountManagementDeps(), currentAccountLine);
}

function updateAccountActionGuards() {
  return accountManagementView().updateAccountActionGuards(accountManagementDeps(), {
    addIdentityButton,
    logoutAccountButton,
  });
}

function openAddIdentityModal() {
  const dialog = openModal({
    title: "新增身份",
    body: renderAddIdentityModalBody(),
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindAddIdentityModal(dialog);
}

function bindAddIdentityModal(dialog) {
  return identityManagementView().bindAddIdentityModal(identityManagementDeps(), dialog);
}

// ---------- 官方定时 ----------

function scheduleDeps() {
  return {
    state,
    scheduleRail,
    scheduleIdentityQuickSelect,
    scheduleIdentityFollowChatButton,
    scheduleIdentityQuickMeta,
    identityOptionLabel,
    loadAccounts,
    loadIdentities,
    setActiveIdentity,
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

function renderScheduleIdentityDock() {
  if (!window.MiniwebViews?.schedule?.renderScheduleIdentityDock) return;
  return window.MiniwebViews.schedule.renderScheduleIdentityDock(scheduleDeps());
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

async function openScheduleModal(options = {}) {
  return window.MiniwebViews.schedule.openScheduleModal(scheduleDeps(), options);
}

async function openScheduleModuleQuickModal(options = {}) {
  return window.MiniwebViews.schedule.openScheduleModuleQuickModal(scheduleDeps(), options);
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
      body: renderLogoutEmptyBody(),
      footer: renderLogoutEmptyFooter(),
    });
    return;
  }
  const dialog = openModal({
    title: "登出 Telegram 账号",
    body: renderLogoutAccountModalBody(loggedIn, presetLocalId),
    footer: renderLogoutAccountModalFooter(),
  });
  if (!dialog) return;

  const select = dialog.querySelector("#logoutAccountSelect");
  const updateBound = () => updateLogoutBoundIdentities(dialog);
  select.addEventListener("change", updateBound);
  updateBound();

  const confirmBtn = dialog.querySelector("#logoutConfirmBtn");
  confirmBtn.addEventListener("click", async () => {
    const localId = selectedLogoutAccountId(dialog);
    if (!localId) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "退出中…";
    setLogoutResult(dialog, "info", "正在停 listener、清 session 文件…");
    try {
      const result = await postJson("/api/accounts/logout", { local_id: localId });
      if (!result.ok) throw new Error(result.error || "登出失败");
      setLogoutResult(dialog, "ok", `已登出。如有 ${result.bound_identities || 0} 条绑定身份,已暂停。`);
      await Promise.all([loadAccounts(), loadIdentities()]);
      setTimeout(() => closeModal(), 800);
    } catch (error) {
      setLogoutResult(dialog, "error", error.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = "确认登出";
    }
  });
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

function accountManagementView() {
  return window.MiniwebViews.accountManagement;
}

function accountManagementDeps() {
  return {
    state,
    saveAccount,
    loadAccounts,
    loadIdentities,
    startAccountLogin: (localId) => postJson("/api/accounts/login/start", { local_id: localId }),
    verifyAccountLogin: (payload) => postJson("/api/accounts/login/verify", payload),
    loadAccountDialogs: (localId) => fetchJson(`/api/accounts/dialogs?local_id=${encodeURIComponent(localId)}`),
    loadAccountTopics: (localId, chat) => fetchJson(`/api/accounts/topics?local_id=${encodeURIComponent(localId)}&chat=${encodeURIComponent(chat)}`),
    saveAccountTarget: ensureSaveAccountTarget,
    startAccountListener: (localId) => postJson("/api/accounts/listener/start", { local_id: localId }),
  };
}

function renderLogoutEmptyBody() {
  return accountManagementView().renderLogoutEmptyBody(accountManagementDeps());
}

function renderLogoutEmptyFooter() {
  return accountManagementView().renderLogoutEmptyFooter(accountManagementDeps());
}

function renderLogoutAccountModalBody(loggedIn, presetLocalId) {
  return accountManagementView().renderLogoutAccountModalBody(accountManagementDeps(), loggedIn, presetLocalId);
}

function renderLogoutAccountModalFooter() {
  return accountManagementView().renderLogoutAccountModalFooter(accountManagementDeps());
}

function selectedLogoutAccountId(dialog) {
  return accountManagementView().selectedLogoutAccountId(dialog);
}

function updateLogoutBoundIdentities(dialog) {
  return accountManagementView().updateLogoutBoundIdentities(dialog, state.identities);
}

function setLogoutResult(dialog, kind, text) {
  return accountManagementView().setLogoutResult(dialog, kind, text);
}

function renderAccountModalBody(account, settings, modalState) {
  return accountManagementView().renderAccountModalBody(accountManagementDeps(), account, settings, modalState);
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

function bindAccountModal(dialog, account, settings, modalState) {
  return accountManagementView().bindAccountModal(accountManagementDeps(), dialog, account, settings, modalState);
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

async function saveCurrentSettingsFromForm(form) {
  return saveSettings(settingsView().settingsPayloadFromForm(form));
}

function identityById(identityId) {
  const id = Number(identityId || 0);
  return (state.identities || []).find((identity) => Number(identity.send_as_id || 0) === id) || null;
}

function activeIdentityProfileLabel() {
  const patches = activeIdentityPatches();
  const patchMap = new Map((patches || []).map((patch) => [patch.key, patch.value]));
  return (
    patchMap.get("角色名") ||
    patchMap.get("道号") ||
    patchMap.get("境界") ||
    ""
  );
}

function renderActiveIdentityDock() {
  if (!activeIdentityQuickSelect) return;
  const identities = state.identities || [];
  const activeId = Number(state.activeIdentityId || 0) || 0;
  if (!identities.length) {
    activeIdentityQuickSelect.innerHTML = '<option value="">先登录账号</option>';
    activeIdentityQuickSelect.disabled = true;
    if (activeIdentityStatusButton) activeIdentityStatusButton.disabled = true;
    if (activeIdentityQuickMeta) activeIdentityQuickMeta.textContent = "还没有可用身份";
    return;
  }
  activeIdentityQuickSelect.disabled = false;
  activeIdentityQuickSelect.innerHTML = [
    '<option value="">未选择</option>',
    ...identities.map((identity) => {
      const id = Number(identity.send_as_id || 0);
      const account = accountForIdentity(identity);
      const name = identity.label || identity.username || identity.send_as_id || "未命名";
      const accountLabel = account?.label || identity.account_local_id || "未绑定";
      const status = identityCanSend(identity) ? "" : "｜不可发";
      return `<option value="${escapeAttr(String(id))}" ${id === activeId ? "selected" : ""}>${escapeHtml(String(name))}｜${escapeHtml(String(accountLabel))}${escapeHtml(status)}</option>`;
    }),
  ].join("");
  activeIdentityQuickSelect.value = activeId ? String(activeId) : "";
  const identity = activeId ? identityById(activeId) : null;
  const profile = activeIdentityProfileLabel();
  if (activeIdentityStatusButton) activeIdentityStatusButton.disabled = !identity;
  if (activeIdentityQuickMeta) {
    activeIdentityQuickMeta.textContent = identity
      ? [profile, identityCanSend(identity) ? "可发送" : "账号未就绪"].filter(Boolean).join("｜")
      : "选择后同步聊天与定时";
  }
  if (activeIdentityDock) {
    activeIdentityDock.classList.toggle("is-ready", Boolean(identity && identityCanSend(identity)));
    activeIdentityDock.classList.toggle("is-warn", Boolean(identity && !identityCanSend(identity)));
  }
}

function syncScheduleSelectionToActiveIdentity(identityId = state.activeIdentityId) {
  const id = Number(identityId || 0) || 0;
  state.scheduleSelectedSendAsIds = id ? [id] : [];
}

function accountForIdentity(identity) {
  if (!identity) return null;
  const localId = String(identity.account_local_id || "");
  return (state.accounts || []).find((account) => String(account.local_id || "") === localId) || null;
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
    if (options.syncSchedule !== false) {
      syncScheduleSelectionToActiveIdentity(resolved);
      renderScheduleIdentityDock();
      renderScheduleRail();
    }
    renderIdentityProfileViews();
    renderCultivationModules();
    return resolved;
  }
  state.activeIdentityId = resolved;
  if (options.syncSchedule !== false) {
    syncScheduleSelectionToActiveIdentity(resolved);
  }
  clearIdentityPatchesForActive();
  renderActiveIdentityDock();
  renderScheduleIdentityDock();
  renderScheduleRail();
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
  const loginDone = String(account?.login_status || "") === "done";
  const targetChat = String(account?.target_chat || state.settings?.target_chat || "").trim();
  return Boolean(account && loginDone && accountId && identityId && targetChat);
}

function identityOptionLabel(identity) {
  const account = accountForIdentity(identity);
  const name = identity?.label || identity?.username || identity?.send_as_id || "未命名身份";
  const accountLabel = account?.label || identity?.account_local_id || "未绑定账号";
  const suffix = identityCanSend(identity) ? "" : "（账号未就绪）";
  return `${name}｜账号 ${accountLabel}${suffix}`;
}

function renderDirectSendComposer() {
  return;
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
  messageList.addEventListener("scroll", () => {
    updateJumpToLatestVisibility();
    if (state.messageRenderDeferred && isMessageListNearLatest()) {
      flushDeferredMessageRender({ toLatest: true });
    }
  }, { passive: true });
  jumpToLatestButton.addEventListener("click", () => {
    if (flushDeferredMessageRender({ toLatest: true, behavior: "auto" })) {
      return;
    }
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
  document.querySelectorAll(".workspace-tools-shell[open], .stream-filter-drawer[open]").forEach((node) => {
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

if (activeIdentityQuickSelect) {
  activeIdentityQuickSelect.addEventListener("change", async () => {
    const id = Number(activeIdentityQuickSelect.value || 0) || null;
    try {
      await setActiveIdentity(id, { loadPatches: true });
      showSkillToast(id ? "已切换当前身份" : "已清空当前身份", "ok");
    } catch (error) {
      console.warn("[mini-web] active identity quick switch failed:", error);
      showSkillToast(`切换身份失败: ${error.message || error}`, "err");
      renderActiveIdentityDock();
    }
  });
}

if (activeIdentityStatusButton) {
  activeIdentityStatusButton.addEventListener("click", () => {
    try {
      openIdentityStatusModal();
    } catch (error) {
      showError(error);
    }
  });
}

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
    Promise.allSettled([loadAccounts(), loadIdentities()]).catch(() => {});
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
    exportLogMessages: ({ channel, fmt }) => {
      const params = new URLSearchParams({
        channel: channel || "all",
        fmt: fmt || "jsonl",
      });
      return apiFetch(`/api/messages/export?${params.toString()}`);
    },
    loadLogMessages: ({ beforeSeq, channel, limit }) => {
      const params = new URLSearchParams({ channel: channel || "all" });
      params.set("limit", limit || "200");
      if (Number(beforeSeq || 0) > 0) {
        params.set("before_seq", String(beforeSeq));
      }
      return fetchJson(`/api/messages?${params.toString()}`);
    },
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

function delayedStartupTask(label, task, delayMs = 3000) {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      if (document.hidden) {
        resolve(null);
        return;
      }
      startupTask(label, task).then(resolve);
    }, delayMs);
  });
}

async function bootstrapApp() {
  const scheduleReady = startupTask("initial schedule rail", () => loadScheduleRail({ silent: true }));
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

  void scheduleReady;
  delayedStartupTask("initial world snapshot", () => loadWorldSnapshot({ silent: true }), 5000);
  settingsReady.then(() => delayedStartupTask("initial bot discovery", loadDiscoveredBots, 12000));
  settingsReady.then(() => delayedStartupTask("initial message audit", () => loadMessageAudit({ silent: true }), 8000));
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

function renderSkillViews() {
  renderQuestTracker();
  renderLiveSituationBoard();
  renderGameSceneBoard();
  renderGameActionDock();
}

function fillSkillIntoComposer(skillKey, button = null) {
  void skillKey;
  void button;
  showSkillToast("聊天发送栏已移除,快捷指令不再直接填入。", "warn");
}

function showSkillToast(text, kind) {
  window.MiniwebToast.showToast(text, kind);
}

// 轻量前端轮询。聊天视图关闭时不再拉消息流,只保留账号/健康/世界快照等低频刷新。
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
    const now = Date.now();
    let messageResult = null;
    const tasks = [];
    if (CHAT_FEATURE_ENABLED) {
      tasks.push(refreshChatViewport({ incremental: true }).then((result) => {
        messageResult = result;
        return result;
      }));
    }
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
    await Promise.all(tasks);
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
