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

function renderGameCockpit() {
  if (!gameCockpit && !gameHud && !gameActionDock && !gamePrimaryStrip) return;
  renderCockpitIdentity();
  renderCockpitModules();
  renderCockpitInbox();
  renderGamePrimaryStrip();
  renderLiveSituationBoard();
  renderGameActionDock();
  renderGameSceneBoard();
  renderQuestTracker();
}

function renderGamePrimaryStrip() {
  if (!gamePrimaryStrip) return;
  const focus = primaryFocusStripModel();
  const dungeon = primaryDungeonStripModel();
  const status = primaryStatusStripModel();
  gamePrimaryStrip.innerHTML = `
    <button type="button" class="game-primary-item focus ${escapeAttr(focus.kind)}" data-primary-strip-action="${escapeAttr(focus.action)}">
      <span>${escapeHtml(focus.label)}</span>
      <strong>${escapeHtml(focus.title)}</strong>
      <small>${escapeHtml(focus.meta)}</small>
    </button>
    <button type="button" class="game-primary-item dungeon ${escapeAttr(dungeon.kind)}" data-primary-strip-action="dungeon">
      <span>${escapeHtml(dungeon.label)}</span>
      <strong>${escapeHtml(dungeon.title)}</strong>
      <small>${escapeHtml(dungeon.meta)}</small>
    </button>
    <button type="button" class="game-primary-item status ${escapeAttr(status.kind)}" data-primary-strip-action="status">
      <span>${escapeHtml(status.label)}</span>
      <strong>${escapeHtml(status.title)}</strong>
      <small>${escapeHtml(status.meta)}</small>
    </button>
    <button type="button" class="game-primary-more" data-primary-strip-action="secondary">工具</button>
  `;
  gamePrimaryStrip.querySelectorAll("[data-primary-strip-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handlePrimaryStripAction(button.dataset.primaryStripAction || "").catch((error) => showError(error));
    });
  });
}

function primaryFocusStripModel() {
  const auditStatus = state.messageAudit?.status || "";
  if (auditStatus && auditStatus !== "ok") {
    return {
      label: "重点",
      title: "消息箱异常",
      meta: healthStatusLabel(auditStatus),
      kind: "warn",
      action: "health",
    };
  }
  const message = primaryFocusMessage();
  if (!message) {
    return {
      label: "重点",
      title: "暂无重点回复",
      meta: collectorLiveStatus() || "风险、@我和重点频道会显示在这里",
      kind: "muted",
      action: "overview",
    };
  }
  const meta = worldEventMeta(message);
  const actionCount = (message.actions || []).filter((item) => String(item.command || "").trim()).length;
  const preview = liveMessagePreview(message, 44);
  return {
    label: meta.label === "我的" ? "重点 / 我的" : "重点",
    title: String(message.title || displaySource(message.source) || "重点回复").trim(),
    meta: [
      formatChatTime(message.time) || "最近",
      displaySource(message.source),
      actionCount ? `${actionCount} 个候选` : preview,
    ].filter(Boolean).join("｜"),
    kind: meta.kind || "focus",
    action: "focus",
  };
}

function primaryFocusMessage() {
  const seen = new Set();
  return summarySignalMessages()
    .filter((message) => {
      if (!message?.id || seen.has(message.id)) return false;
      seen.add(message.id);
      const channels = message.channels || [message.channel];
      const tags = message.tags || [];
      if (channels.includes("dungeon")) return false;
      if (message.severity === "risk" || channels.includes("risk")) return true;
      if (isPersonalSignal(message)) return true;
      if (channels.includes("leader") || channels.includes("focus")) return true;
      if ((tags.includes("会长") || tags.includes("重点")) && messageKind(message) === "bot") return true;
      return false;
    })
    .sort(compareRankThenRecency(primaryFocusRank))[0] || null;
}

function primaryFocusRank(message) {
  const channels = message.channels || [message.channel];
  const hasCommand = (message.actions || []).some((item) => String(item.command || "").trim());
  if (message.severity === "risk" || channels.includes("risk")) return 1;
  if (hasCommand) return 2;
  if (isPersonalSignal(message)) return 3;
  if (channels.includes("leader")) return 4;
  if (channels.includes("focus")) return 5;
  return 9;
}

function primaryDungeonStripModel() {
  const summary = actionableDungeonSnapshot() || currentDungeonSnapshot();
  if (!summary) {
    return {
      label: "副本",
      title: "暂无副本线索",
      meta: "苍坤洞府、虚天殿等副本会在这里置顶",
      kind: "muted",
    };
  }
  const actions = visibleDungeonActions(summary).filter((action) => String(action.command || "").trim());
  const meta = [
    summary.status || "副本",
    summary.latestStage || "",
    actions.length ? `${actions.length} 个动作` : "",
    formatChatTime(summary.latestMessage?.time) || "",
  ].filter(Boolean).join("｜");
  return {
    label: "副本",
    title: dungeonSummaryDisplayLabel(summary),
    meta: meta || summary.advice || summary.routeVerdict || "点击查看副本面板",
    kind: summary.statusKind || "dungeon",
  };
}

function primaryStatusStripModel() {
  const activeId = Number(state.activeIdentityId || 0) || null;
  const identity = activeId ? identityById(activeId) : null;
  const patchMap = new Map(activeIdentityPatches().map((item) => [item.key, item.value]));
  const identityName =
    patchMap.get("角色名") ||
    patchMap.get("道号") ||
    identity?.label ||
    identity?.username ||
    (activeId ? String(activeId) : "未选角色");
  const identityMeta = [
    patchMap.get("境界"),
    String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
  ].filter(Boolean).join("｜") || (identity ? "资料待补全" : "先选身份");
  const moduleRow = overviewModuleRows(activeId).find((row) => ["warn", "ready", "running", "cooling"].includes(row.view?.cls)) || null;
  return {
    label: "角色 / CD",
    title: String(identityName),
    meta: moduleRow ? `${moduleRow.view.label} ${moduleRow.view.time}`.trim() : identityMeta,
    kind: moduleRow?.view?.cls || (activeId ? "ready" : "muted"),
  };
}

async function handlePrimaryStripAction(action) {
  if (action === "secondary") {
    openSecondaryGamePanel();
    return;
  }
  if (action === "focus") {
    const signal = primaryFocusMessage();
    const message = signal?.id ? await findOrFetchMessage(signal.id) : null;
    if (message) {
      jumpToMessage(message);
    } else {
      openOverviewDetailPanel();
    }
    return;
  }
  if (action === "overview") {
    openOverviewDetailPanel();
    return;
  }
  if (action === "dungeon") {
    await openDungeonStatusModal();
    return;
  }
  if (action === "health") {
    await openHealthModal();
    return;
  }
  openIdentityStatusModal();
}

function openSecondaryGamePanel() {
  const shell = document.querySelector(".workspace-tools-shell");
  const secondary = document.querySelector(".game-secondary-shell");
  if (shell) shell.open = true;
  if (secondary) {
    secondary.open = true;
    secondary.scrollIntoView({ block: "nearest" });
  } else {
    openOverviewDetailPanel();
  }
}

function renderCockpitIdentity() {
  if (!cockpitIdentity && !hudIdentity) return;
  const activeId = Number(state.activeIdentityId || 0) || null;
  const identity = activeId ? identityById(activeId) : null;
  const account = identity ? accountForIdentity(identity) : null;
  const patches = activeIdentityPatches();
  const patchMap = new Map(patches.map((item) => [item.key, item.value]));
  const sourceRows = identityProfileSourceRows(patches);
  if (!identity) {
    const hudSelect = renderHudIdentitySelect(activeId);
    const emptyHtml = `
      <div class="cockpit-empty">
        <strong>未选择身份</strong>
        <span>左侧选身份后，下方发送栏会自动跟随。</span>
      </div>
    `;
    if (cockpitIdentity) cockpitIdentity.innerHTML = emptyHtml;
    if (hudIdentity) {
      hudIdentity.innerHTML = `
        <div class="hud-empty">
          <strong>未选择身份</strong>
          <span>选择角色后显示状态</span>
          ${hudSelect}
        </div>
      `;
      bindHudIdentitySelect();
    }
    return;
  }

  const name =
    patchMap.get("角色名") ||
    patchMap.get("道号") ||
    identity.label ||
    identity.username ||
    String(identity.send_as_id || "未命名");
  const subtitleParts = [
    patchMap.get("境界"),
    String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
    patchMap.get("灵根"),
  ].filter(Boolean);
  const cultivation = String(patchMap.get("修为") || "");
  const power = String(patchMap.get("综合战力") || "");
  const title = String(patchMap.get("称号") || "").replace(/^【|】$/g, "");
  const canSend = identityCanSend(identity);
  const statusClass = !account ? "warn" : canSend ? "ok" : "warn";
  const statusText = !account ? "未绑定账号" : canSend ? "可直接发送" : "只能观察";
  const metricRows = [
    ["战力", power || "未读"],
    ["修为", cultivation || "未读"],
    ["称号", title || "未读"],
  ].filter(([, value]) => value);

  if (cockpitIdentity) {
    cockpitIdentity.innerHTML = `
      <div class="cockpit-identity-main">
        <div class="cockpit-avatar">${escapeHtml(sourceInitial(name, "player"))}</div>
        <div class="cockpit-identity-title">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(subtitleParts.join("｜") || "等待消息箱补全角色资料")}</span>
        </div>
        <span class="cockpit-status ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <div class="cockpit-player-meta">
        ${metricRows.map(([label, value]) => cockpitMetric(label, value)).join("")}
      </div>
      ${renderHudProfileSource(sourceRows)}
    `;
  }

  if (hudIdentity) {
    const hudMetrics = [
      ["境界", patchMap.get("境界") || "未读"],
      ["灵根", patchMap.get("灵根") || "未读"],
      ["战力", power || "未读"],
      ["修为", cultivation || "未读"],
    ];
    hudIdentity.innerHTML = `
      <div class="hud-identity-switch">
        <span>当前角色</span>
        ${renderHudIdentitySelect(activeId)}
      </div>
      <div class="hud-player-main">
        <div class="cockpit-avatar hud-avatar">${escapeHtml(sourceInitial(name, "player"))}</div>
        <div class="hud-player-title">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(subtitleParts.join("｜") || title || "等待角色资料")}</span>
        </div>
        <span class="cockpit-status ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <div class="hud-player-metrics">
        ${hudMetrics.map(([label, value]) => cockpitMetric(label, value)).join("")}
      </div>
      ${renderHudProfileSource(sourceRows)}
    `;
    bindHudIdentitySelect();
  }
  bindHudSourceButtons();
}

function renderHudIdentitySelect(activeId) {
  if (!state.identities.length) {
    return "";
  }
  const options = [
    `<option value="">未选择</option>`,
    ...state.identities.map((identity) => {
      const id = Number(identity.send_as_id || 0);
      const name = identity.label || identity.username || identity.send_as_id || "未命名";
      const account = accountForIdentity(identity);
      const accountLabel = account?.label || identity.account_local_id || "未绑定";
      return `
        <option value="${escapeAttr(String(id))}" ${id === Number(activeId || 0) ? "selected" : ""}>
          ${escapeHtml(String(name))}｜${escapeHtml(String(accountLabel))}
        </option>
      `;
    }),
  ].join("");
  return `<select class="hud-identity-select" data-hud-identity-select aria-label="切换当前角色">${options}</select>`;
}

function bindHudIdentitySelect() {
  hudIdentity?.querySelector("[data-hud-identity-select]")?.addEventListener("change", (event) => {
    const id = Number(event.currentTarget.value || 0) || null;
    setActiveIdentity(id, { loadPatches: true }).catch((err) => {
      console.warn("[mini-web] switch identity failed:", err);
      showSkillToast(`切换身份失败: ${err.message || err}`, "err");
    });
  });
}

function renderHudProfileSource(rows) {
  const cleanRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!cleanRows.length) {
    return `
      <button type="button" class="hud-profile-source muted" data-hud-source-status>
        <span>资料来源</span>
        <strong>等待玉牒 / 战力</strong>
      </button>
    `;
  }
  const latest = cleanRows
    .map((row) => row.updatedAt)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
  const primary = cleanRows.find((row) => row.sourceMessageId) || cleanRows[0];
  const countText = `${cleanRows.length} 项投影`;
  const timeText = auditTimeLabel(latest) || "未知时间";
  const sourceAttr = primary?.sourceMessageId ? `data-hud-source-message="${escapeAttr(primary.sourceMessageId)}"` : "data-hud-source-status";
  return `
    <button type="button" class="hud-profile-source" ${sourceAttr}>
      <span>资料来源</span>
      <strong>${escapeHtml(countText)}｜${escapeHtml(timeText)}</strong>
    </button>
  `;
}

function bindHudSourceButtons() {
  [cockpitIdentity, hudIdentity].filter(Boolean).forEach((root) => {
    root.querySelectorAll("[data-hud-source-message]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.hudSourceMessage || "";
        const message = id ? await findOrFetchMessage(id) : null;
        if (message) {
          jumpToMessage(message);
        } else {
          openIdentityStatusModal();
        }
      });
    });
    root.querySelectorAll("[data-hud-source-status]").forEach((button) => {
      button.addEventListener("click", () => openIdentityStatusModal());
    });
  });
}

function cockpitMetric(label, value) {
  return `
    <span class="cockpit-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value || "—"))}</strong>
    </span>
  `;
}

function renderCockpitModules() {
  if (!cockpitModules && !hudModules) return;
  const activeId = Number(state.activeIdentityId || 0) || null;
  if (!activeId) {
    const empty = '<p class="cockpit-muted">选中身份后显示关键 CD。</p>';
    if (cockpitModules) cockpitModules.innerHTML = empty;
    if (hudModules) hudModules.innerHTML = empty;
    return;
  }
  const moduleStates = state.identityModuleStates.get(activeId) || [];
  const byKey = new Map(moduleStates.map((item) => [item.module_key, item]));
  const now = Date.now() / 1000;
  const specs = [
    { key: "wild_training", icon: "⚔️", label: "野外" },
    { key: "checkin", icon: "📋", label: "点卯" },
    { key: "tower", icon: "🗼", label: "闯塔" },
    { key: "deep_retreat", icon: "📿", label: "深闭" },
    { key: "retreat_shallow", icon: "🧘", label: "浅闭" },
    { key: "yuanying", icon: "👻", label: "元婴" },
    { key: "second_soul", icon: "🪞", label: "元神" },
    { key: "pet_touch", icon: "🖐️", label: "抚摸" },
    { key: "pet_warm", icon: "♨️", label: "温养" },
    { key: "pet_trial", icon: "🥊", label: "试炼" },
  ];
  const rows = specs.map((spec) => {
    const item = byKey.get(spec.key);
    const summary = item?.summary || {};
    const st = item?.state || {};
    const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
    const startAt = moduleStartTs(st);
    const label = item?.label || spec.label;
    if (!item) {
      return cockpitModuleChip({ icon: spec.icon, label, text: "未知", cls: "unknown" });
    }
    const phase = String(summary.phase || st.phase || "");
    if (phase === "running") {
      if (nextAt > now) {
        const remaining = Math.max(0, nextAt - now);
        const total = Math.max(1, nextAt - startAt);
        const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
        return cockpitModuleChip({
          icon: spec.icon,
          label,
          text: `剩 ${fmtCountdown(remaining)}`,
          cls: "cooling",
          nextAt,
          startAt,
          pct,
        });
      }
      return cockpitModuleChip({ icon: spec.icon, label, text: "待结算", cls: "ready" });
    }
    const ready = summary.ready === true || nextAt === 0 || (nextAt > 0 && nextAt <= now);
    if (ready) {
      return cockpitModuleChip({ icon: spec.icon, label, text: "已就绪", cls: "ready" });
    }
    const remaining = Math.max(0, nextAt - now);
    const total = Math.max(1, nextAt - startAt);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    return cockpitModuleChip({
      icon: spec.icon,
      label,
      text: `剩 ${fmtCountdown(remaining)}`,
      cls: "cooling",
      nextAt,
      startAt,
      pct,
    });
  });
  const html = rows.join("");
  if (cockpitModules) cockpitModules.innerHTML = html;
  if (hudModules) hudModules.innerHTML = html;
}

function cockpitModuleChip({ icon, label, text, cls, nextAt = 0, startAt = 0, pct = 0 }) {
  const liveAttrs = nextAt
    ? ` data-cockpit-timer="1" data-next-at="${nextAt}" data-start-at="${startAt}"`
    : "";
  return `
    <div class="cockpit-module ${escapeAttr(cls || "")}"${liveAttrs}>
      <span class="cockpit-module-icon">${escapeHtml(icon || "•")}</span>
      <span class="cockpit-module-label">${escapeHtml(label || "")}</span>
      <strong class="cockpit-module-time">${escapeHtml(text || "—")}</strong>
      <span class="cockpit-module-bar"><span style="width:${Number(pct || 0).toFixed(1)}%"></span></span>
    </div>
  `;
}

function renderCockpitInbox() {
  if (!cockpitInbox && !hudInbox) return;
  const audit = state.messageAudit || {};
  const messages = audit.messages || {};
  const listener = audit.listener || state.listenerSummary || {};
  const running = listener.running || {};
  const runningCount = Object.keys(running).length;
  const status = audit.status || (runningCount ? "ok" : "warn");
  const latestMsg = audit.latest_target_msg_id || messages.latest_msg_id || 0;
  const latestTime = auditTimeLabel(messages.latest_message_time || audit.time || "");
  const gapCount = Number(audit.gap_count || 0);
  const counts = channelMessageCounts();
  const html = `
    <button type="button" class="cockpit-inbox-status ${escapeAttr(status)}" data-cockpit-action="health">
      <span class="health-dot" aria-hidden="true"></span>
      <strong>${escapeHtml(healthStatusLabel(status))}</strong>
      <small>${escapeHtml(listenerStatusText(listener, runningCount))}</small>
    </button>
    <div class="cockpit-inbox-line">
      ${cockpitMetric("水位", latestMsg ? `#${formatNumber(latestMsg)}` : "未配置")}
      ${cockpitMetric("断层", `${formatNumber(gapCount)} 段`)}
      ${cockpitMetric("重点", `${formatNumber(counts.get("focus") || 0)} 条`)}
      ${cockpitMetric("最近", latestTime || "暂无")}
    </div>
  `;
  [cockpitInbox, hudInbox].filter(Boolean).forEach((root) => {
    root.innerHTML = html;
    root.querySelector('[data-cockpit-action="health"]')?.addEventListener("click", () => openHealthModal());
  });
}

function renderGameActionDock() {
  if (!gameActionDock) return;
  const active = identityById(state.activeIdentityId);
  const activeName = active ? (active.label || active.username || active.send_as_id) : "未选角色";
  const counts = channelMessageCounts();
  const focusCount = Number(counts.get("focus") || 0);
  const dungeonCount = Number(counts.get("dungeon") || 0);
  const resourceCount = Number(counts.get("resource") || 0) + Number(counts.get("training") || 0);
  const leaderCount = Number(counts.get("leader") || 0);
  const healthStatus = state.messageAudit?.status || (state.listenerSummary?.collector ? "ok" : "warn");
  const questCount = questTrackerItems().length;
  const dungeonSummary = actionableDungeonSnapshot() || currentDungeonSnapshot();
  const dungeonActions = visibleDungeonActions(dungeonSummary).length;
  const resource = liveResourceSnapshot();
  const rareTop = resource?.rareRows?.[0] || null;
  const dungeonMeta = dungeonSummary
    ? `${dungeonSummaryDisplayLabel(dungeonSummary)} ${dungeonSummary.status || ""}`.trim()
    : (dungeonCount ? `${formatNumber(dungeonCount)} 条` : "房间/卦象");
  const rareMeta = rareTop
    ? `${rareTop.resource_name}${formatResourceAmount(rareTop.total_amount, rareTop.unit)}`
    : (resourceCount ? `${formatNumber(resourceCount)} 条` : "收益统计");
  const dockItems = [
    { key: "overview", label: "概览", meta: questCount ? `${formatNumber(questCount)} 待办` : (active ? "右侧面板" : "全局态势") },
    { key: "report", label: "战报", meta: "世界总览" },
    { key: "status", label: "状态", meta: active ? "角色总览" : "先选身份" },
    { key: "intel", label: "情报", meta: leaderCount ? `${formatNumber(leaderCount)} 条` : "会长频道" },
    { key: "dungeon", label: "副本", meta: dungeonActions ? `${formatNumber(dungeonActions)} 动作` : dungeonMeta },
    { key: "guide", label: "攻略", meta: "虚天卦象" },
    { key: "resource", label: "资源", meta: rareMeta },
    { key: "inventory", label: "库存", meta: "批量转移" },
    { key: "schedule", label: "定时", meta: "官方排班" },
    { key: "logs", label: "记录", meta: focusCount ? `重点 ${formatNumber(focusCount)}` : "按天查看" },
    { key: "health", label: "健康", meta: healthStatusLabel(healthStatus) },
  ];
  gameActionDock.innerHTML = `
    <div class="game-dock-context">
      <span>当前</span>
      <strong>${escapeHtml(String(activeName))}</strong>
      <div class="game-dock-context-metrics">
        <span><b>待办</b>${escapeHtml(formatNumber(questCount))}</span>
        <span><b>副本</b>${escapeHtml(dungeonSummary ? (dungeonSummary.status || "线索") : "暂无")}</span>
        <span><b>收益</b>${escapeHtml(rareTop ? rareTop.resource_name : "今日")}</span>
      </div>
    </div>
    <div class="game-dock-actions">
      ${dockItems.map((item) => `
        <button type="button" data-game-dock-action="${escapeAttr(item.key)}">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.meta)}</small>
        </button>
      `).join("")}
    </div>
  `;
  gameActionDock.querySelectorAll("[data-game-dock-action]").forEach((button) => {
    button.addEventListener("click", () => handleGameDockAction(button.dataset.gameDockAction || ""));
  });
}

async function handleGameDockAction(action) {
  try {
    if (action === "overview") {
      openOverviewDetailPanel();
      return;
    }
    if (action === "report") {
      await openWorldReportModal();
      return;
    }
    if (action === "status") {
      openIdentityStatusModal();
      return;
    }
    if (action === "intel") {
      await openLeaderIntelModal();
      return;
    }
    if (action === "dungeon") {
      await openDungeonStatusModal();
      return;
    }
    if (action === "guide") {
      await openXutianOracleGuideModal();
      return;
    }
    if (action === "resource") {
      await openResourceStatsModal();
      return;
    }
    if (action === "inventory") {
      await openInventoryModal();
      return;
    }
    if (action === "schedule") {
      await Promise.all([loadAccounts(), loadIdentities()]);
      await openScheduleModal();
      return;
    }
    if (action === "logs") {
      await openLogsModal();
      return;
    }
    if (action === "health") {
      await openHealthModal();
    }
  } catch (error) {
    showError(error);
  }
}

async function openWorldReportModal() {
  const dialog = openModal({
    title: "今日战报",
    body: `
      <section class="modal-section world-report-modal">
        <div id="worldReportBody" class="world-report-body">
          <p class="empty inline">正在读取今日态势...</p>
        </div>
      </section>
    `,
    footer: `
      <button type="button" id="worldReportRefresh">刷新战报</button>
      <button type="button" data-modal-close>关闭</button>
    `,
  });
  if (!dialog) return;
  const load = async () => {
    const body = dialog.querySelector("#worldReportBody");
    const button = dialog.querySelector("#worldReportRefresh");
    if (button) button.disabled = true;
    if (body) body.innerHTML = '<p class="empty inline">正在读取今日态势...</p>';
    try {
      const [health, dungeon, resource, leader, priority] = await Promise.all([
        fetchJson("/api/health"),
        fetchJson("/api/dungeon-status?limit=90&summary_limit=3&order=recent"),
        fetchJson("/api/resource-stats?period=day&source_type=all&limit=120"),
        fetchJson("/api/messages?channel=leader&limit=6"),
        fetchJson("/api/messages?channels=risk,focus&limit=16&compact=1"),
      ]);
      const payload = { health, dungeon, resource, leader, priority };
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
      if (body) body.innerHTML = renderWorldReport(payload);
      bindWorldReport(dialog, payload);
    } catch (error) {
      if (body) body.innerHTML = `<p class="empty inline">战报读取失败：${escapeHtml(error.message || "未知错误")}</p>`;
    } finally {
      if (button) button.disabled = false;
    }
  };
  dialog.querySelector("#worldReportRefresh")?.addEventListener("click", () => load());
  await load();
}

function renderWorldReport(payload) {
  const health = payload.health || {};
  const dungeonSummaries = ((payload.dungeon || {}).summaries || []).map(normalizeDungeonStatusSummary);
  const currentDungeon = pickCurrentDungeonSummary(dungeonSummaries);
  const resource = payload.resource || {};
  const rows = resource.rows || [];
  const events = resource.event_summary || resource.events || [];
  const latestPeriod = latestResourcePeriod(rows, events);
  const periodRows = filterResourceRowsByPeriod(rows, latestPeriod);
  const periodEvents = filterResourceRowsByPeriod(events, latestPeriod);
  const rareRows = aggregateRareResourceRows(periodRows.filter((row) => row.resource_category === "rare")).slice(0, 6);
  const leaderItems = (payload.leader?.messages || []).slice(0, 4);
  const quests = questTrackerItems().slice(0, 6);
  return `
    <div class="world-report-hero">
      <div>
        <span>消息箱</span>
        <strong>${escapeHtml(worldReportListenerLabel(health))}</strong>
        <small>${escapeHtml(worldReportLatestMessageLabel(health))}</small>
      </div>
      <div>
        <span>当前副本</span>
        <strong>${escapeHtml(currentDungeon ? `${currentDungeon.dungeonName}${currentDungeon.dungeonId ? ` #${currentDungeon.dungeonId}` : ""}` : "暂无")}</strong>
        <small>${escapeHtml(currentDungeon?.status || "最近没有活跃副本线索")}</small>
      </div>
      <div>
        <span>今日资源事件</span>
        <strong>${escapeHtml(formatNumber((resource.events || []).length))}</strong>
        <small>${escapeHtml(latestPeriod || "暂无周期")}</small>
      </div>
      <div>
        <span>情报摘录</span>
        <strong>${escapeHtml(formatNumber(leaderItems.length))}</strong>
        <small>会长 / 天尊普通发言</small>
      </div>
      <div>
        <span>待办动作</span>
        <strong>${escapeHtml(formatNumber(quests.length))}</strong>
        <small>只填入发送栏</small>
      </div>
    </div>
    <div class="world-report-grid">
      <section class="world-report-section wide">
        <div class="world-report-section-head">
          <strong>待办动作</strong>
          <button type="button" data-world-report-open="overview">查看全部</button>
        </div>
        <div class="world-report-quests">
          ${quests.length ? quests.map(renderWorldReportQuestCard).join("") : '<p class="empty inline">暂无风险、@我或待确认动作。</p>'}
        </div>
      </section>
      <section class="world-report-section wide">
        <div class="world-report-section-head">
          <strong>当前副本</strong>
          <button type="button" data-world-report-open="dungeon">副本面板</button>
        </div>
        ${currentDungeon ? renderCurrentDungeonPanel(currentDungeon) : '<p class="empty inline">暂无活跃副本线索。</p>'}
      </section>
      <section class="world-report-section">
        <div class="world-report-section-head">
          <strong>野外历练</strong>
          <button type="button" data-world-report-open="resource">资源面板</button>
        </div>
        <div class="world-report-wild">
          ${renderWorldReportWildCards(periodEvents)}
        </div>
      </section>
      <section class="world-report-section">
        <div class="world-report-section-head">
          <strong>稀有产物</strong>
          <button type="button" data-world-report-open="resource">查看统计</button>
        </div>
        <div class="world-report-rare">
          ${rareRows.length ? rareRows.map((row) => `
            <span>
              <strong>${escapeHtml(row.resource_name || "资源")}</strong>
              <em>${escapeHtml(formatResourceAmount(row.total_amount, row.unit))}</em>
              <small>${escapeHtml((row.sources || []).slice(0, 2).join(" / ") || "来源")}</small>
            </span>
          `).join("") : '<p class="empty inline">暂无稀有产物统计。</p>'}
        </div>
      </section>
      <section class="world-report-section wide">
        <div class="world-report-section-head">
          <strong>情报摘录</strong>
          <button type="button" data-world-report-open="intel">情报频道</button>
        </div>
        <div class="leader-intel-list world-report-intel-list">
          ${leaderItems.length ? leaderItems.map(renderLeaderIntelCard).join("") : '<p class="empty inline">暂无情报消息。</p>'}
        </div>
      </section>
    </div>
  `;
}

function renderWorldReportQuestCard(message) {
  const key = questTrackerItemKey(message);
  const actionEntries = (message.actions || [])
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => String(action.command || "").trim());
  const { kind, text: kindText } = questItemKind(message, actionEntries);
  const preview = clipGraphemes(
    String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim(),
    86
  );
  return `
    <article class="world-report-quest ${escapeAttr(kind)}">
      <button type="button" data-world-report-quest-view="${escapeAttr(key)}">
        <span>${escapeHtml(kindText)}</span>
        <strong>${escapeHtml(message.title || displaySource(message.source) || "待办")}</strong>
        <small>${escapeHtml(formatChatTime(message.time) || "")}｜${escapeHtml(displaySource(message.source) || "快照")}</small>
        <em>${escapeHtml(preview || "等待查看原文")}</em>
      </button>
      ${actionEntries.length ? `
        <div>
          ${actionEntries.slice(0, 2).map(({ action, index }) => `
            <button type="button" data-world-report-quest-action="${escapeAttr(`${key}::${index}`)}" title="${escapeAttr(String(action.command || ""))}">
              ${escapeHtml(quickActionLabel(action))}
            </button>
          `).join("")}
        </div>
      ` : ""}
    </article>
  `;
}

function renderWorldReportWildCards(periodEvents) {
  const strategies = ["谨慎", "均衡", "深入"];
  const cards = strategies.map((strategy) => {
    const rows = (periodEvents || []).filter((row) => row.source_type === "wild_training" && String(row.source_name || "").includes(strategy));
    const success = rows.filter((row) => row.result === "success").reduce((sum, row) => sum + Number(row.event_count || 0), 0);
    const failed = rows.filter((row) => row.result === "failed").reduce((sum, row) => sum + Number(row.event_count || 0), 0);
    const cooldown = rows.filter((row) => row.result === "cooldown").reduce((sum, row) => sum + Number(row.event_count || 0), 0);
    const total = success + failed;
    const rate = total ? `${Math.round((success / total) * 100)}%` : "暂无";
    return `
      <article class="world-report-wild-card">
        <span>${escapeHtml(strategy)}</span>
        <strong>${escapeHtml(rate)}</strong>
        <small>${escapeHtml(formatNumber(success))} 成 / ${escapeHtml(formatNumber(failed))} 败｜CD ${escapeHtml(formatNumber(cooldown))}</small>
      </article>
    `;
  });
  return cards.join("");
}

function worldReportListenerLabel(health) {
  const running = health?.listener?.running || {};
  const rows = Object.values(running);
  const first = rows[0] || {};
  if (first.status === "running") return "监听运行中";
  if (first.status === "starting") return "监听启动中";
  return rows.length ? String(first.status || "未知") : "未运行";
}

function worldReportLatestMessageLabel(health) {
  const messages = health?.messages || {};
  const latest = messages.latest_msg_id ? `#${formatNumber(messages.latest_msg_id)}` : "无水位";
  const time = auditTimeLabel(messages.latest_message_time || "");
  return `${latest}${time ? `｜${time}` : ""}`;
}

function bindWorldReport(dialog, payload) {
  const dungeonSummaries = ((payload.dungeon || {}).summaries || []).map(normalizeDungeonStatusSummary);
  const body = dialog.querySelector("#worldReportBody");
  if (body && dungeonSummaries.length) {
    bindDungeonStatusCards(body, dungeonSummaries);
  }
  body?.querySelectorAll("[data-leader-intel-jump]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.leaderIntelJump || "";
      if (!id) return;
      const message = await findOrFetchMessage(id);
      closeModal();
      if (message) jumpToMessage(message);
    });
  });
  body?.querySelectorAll("[data-world-report-open]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.dataset.worldReportOpen || "";
      closeModal();
      if (target === "dungeon") {
        await openDungeonStatusModal();
      } else if (target === "resource") {
        await openResourceStatsModal();
      } else if (target === "intel") {
        await openLeaderIntelModal();
      } else if (target === "overview") {
        openOverviewDetailPanel();
      }
    });
  });
  body?.querySelectorAll("[data-world-report-quest-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      const key = button.dataset.worldReportQuestView || "";
      closeModal();
      await openQuestTrackerItem(key);
    });
  });
  body?.querySelectorAll("[data-world-report-quest-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [key, indexText] = String(button.dataset.worldReportQuestAction || "").split("::");
      closeModal();
      await fillQuestTrackerAction(key, Number(indexText || 0), "战报动作");
    });
  });
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

const IDENTITY_STATUS_GROUPS = [
  {
    key: "daily",
    title: "日常",
    hint: "常规循环和会卡行动的长 CD。",
    modules: [
      { key: "wild_training", skill: "wild_training" },
      { key: "checkin", skill: "checkin" },
      { key: "tower", skill: "tower" },
      { key: "deep_retreat", skill: "deep_retreat", query: "deep_retreat_query" },
      { key: "retreat_shallow", skill: "retreat_shallow" },
      { key: "yuanying", skill: "yuanying", query: "yuanying_status" },
      { key: "second_soul", skill: "second_soul_train", query: "second_soul_status" },
      { key: "ranch", skill: "ranch" },
    ],
  },
  {
    key: "artifact",
    title: "器灵",
    hint: "抚摸、温养、试炼三块合并看。",
    modules: [
      { key: "pet_touch", skill: "pet_touch" },
      { key: "pet_warm", skill: "pet_warm" },
      { key: "pet_trial", skill: "pet_trial" },
    ],
  },
  {
    key: "concubine",
    title: "侍妾",
    hint: "入梦、代卜、心劫分开显示，查询走我的侍妾。",
    query: "concubine_status",
    modules: [
      { key: "concubine_dream", skill: "concubine_dream" },
      { key: "concubine_tianji", skill: "concubine_tianji" },
      { key: "concubine_heart", skill: "concubine_heart" },
    ],
  },
  {
    key: "stargazer",
    title: "星宫",
    hint: "观星台三项独立 CD，按宗门解锁快捷按钮。",
    query: "stargazer_panel",
    modules: [
      { key: "stargazer_guide", skill: "stargazer_guide" },
      { key: "stargazer_soothe", skill: "stargazer_soothe" },
      { key: "stargazer_collect", skill: "stargazer_collect" },
    ],
  },
  {
    key: "tianti",
    title: "天阶",
    hint: "登天阶、问心台、九天罡风分开观测。",
    query: "tianti_status",
    modules: [
      { key: "tianti_climb", skill: "tianti_climb" },
      { key: "tianti_wenxin", skill: "tianti_wenxin" },
      { key: "tianti_gangfeng", skill: "tianti_gangfeng" },
    ],
  },
  {
    key: "taiyi",
    title: "太一",
    hint: "太一周期用于引道 / 搜寻节点的手动判断。",
    query: "taiyi",
    modules: [
      { key: "taiyi_cycle", skill: "yindao", extraSkills: ["node_search"] },
    ],
  },
];

function openIdentityStatusModal() {
  const active = identityById(state.activeIdentityId);
  const titleSuffix = active ? `｜${active.label || active.username || active.send_as_id}` : "";
  const dialog = openModal({
    title: `角色状态${titleSuffix}`,
    body: `
      <section class="modal-section identity-status-modal">
        <div id="identityStatusBody" class="identity-status-body">
          ${renderIdentityStatusBody()}
        </div>
      </section>
    `,
    footer: `
      <button type="button" data-identity-status-action="refresh">刷新状态</button>
      <button type="button" data-modal-close>关闭</button>
    `,
  });
  if (!dialog) return;
  bindIdentityStatusModal(dialog);
}

function renderIdentityStatusBody() {
  const activeId = Number(state.activeIdentityId || 0) || null;
  if (!activeId) {
    return '<p class="empty">先在左侧或顶部选择一个身份。</p>';
  }
  const identity = identityById(activeId);
  const patchMap = new Map(activeIdentityPatches().map((item) => [item.key, item.value]));
  const stateItems = state.identityModuleStates.get(activeId) || [];
  const byKey = new Map(stateItems.map((item) => [item.module_key, item]));
  const titleParts = [
    patchMap.get("境界"),
    String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
    patchMap.get("灵根"),
  ].filter(Boolean);
  const name =
    patchMap.get("角色名") ||
    patchMap.get("道号") ||
    identity?.label ||
    identity?.username ||
    String(activeId);
  const profileChips = [
    ["角色", name],
    ["境界", patchMap.get("境界") || "未读"],
    ["灵根", patchMap.get("灵根") || "未读"],
    ["战力", patchMap.get("综合战力") || "未读"],
    ["修为", patchMap.get("修为") || "未读"],
  ];
  const sourceRows = identityProfileSourceRows(activeIdentityPatches());
  return `
    <div class="identity-status-profile">
      <div>
        <strong>${escapeHtml(String(name))}</strong>
        <span>${escapeHtml(titleParts.join("｜") || "等待消息箱补全角色资料")}</span>
      </div>
      <div class="identity-status-profile-grid">
        ${profileChips.map(([label, value]) => cockpitMetric(label, value)).join("")}
      </div>
      ${renderIdentityProfileSources(sourceRows)}
    </div>
    <div class="identity-status-groups">
      ${IDENTITY_STATUS_GROUPS.map((group) => renderIdentityStatusGroup(group, byKey)).join("")}
    </div>
  `;
}

function identityProfileSourceRows(patches) {
  const wanted = ["角色名", "境界", "宗门", "灵根", "修为", "综合战力"];
  const byKey = new Map((patches || []).map((item) => [item.key, item]));
  return wanted
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .map((item) => ({
      key: item.key,
      value: item.value,
      sourceMessageId: item.source_message_id || "",
      updatedAt: item.updated_at || "",
    }));
}

function renderIdentityProfileSources(rows) {
  if (!rows.length) {
    return '<p class="identity-source-empty">暂无投影来源。发送或监听“我的灵根 / 战力”后会更新。</p>';
  }
  const latest = rows
    .map((row) => row.updatedAt)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
  return `
    <details class="identity-source-panel">
      <summary>
        <span>资料来源</span>
        <strong>${escapeHtml(latest ? `最近 ${auditTimeLabel(latest)}` : "等待消息箱")}</strong>
      </summary>
      <div class="identity-source-list">
        ${rows.map((row) => `
          <div class="identity-source-row">
            <span>${escapeHtml(row.key)}</span>
            <strong>${escapeHtml(formatFieldValue(row.value))}</strong>
            <small>${escapeHtml(auditTimeLabel(row.updatedAt) || "未知时间")}</small>
            ${row.sourceMessageId ? `
              <button type="button" data-identity-source-jump="${escapeAttr(row.sourceMessageId)}">
                来源
              </button>
            ` : '<em>无来源</em>'}
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderIdentityStatusGroup(group, byKey) {
  const querySkill = group.query ? skillByKey(group.query) : null;
  const queryButton = querySkill && skillIsUnlocked(querySkill)
    ? `<button type="button" class="identity-status-query" data-status-skill="${escapeAttr(querySkill.key)}">${escapeHtml(querySkill.label || "查询")}</button>`
    : "";
  return `
    <section class="identity-status-group ${escapeAttr(group.key)}">
      <div class="identity-status-group-head">
        <div>
          <strong>${escapeHtml(group.title)}</strong>
          <span>${escapeHtml(group.hint || "")}</span>
        </div>
        ${queryButton}
      </div>
      <div class="identity-status-grid">
        ${group.modules.map((spec) => renderIdentityStatusCard(spec, byKey.get(spec.key))).join("")}
      </div>
    </section>
  `;
}

function renderIdentityStatusCard(spec, item) {
  const view = identityModuleView(spec, item);
  const actionButtons = identityStatusActions(spec)
    .map((skill) => {
      const disabled = !skillIsUnlocked(skill);
      return `
        <button type="button" data-status-skill="${escapeAttr(skill.key)}" ${disabled ? "disabled" : ""}>
          ${escapeHtml(skill.label || skill.command || "填入")}
        </button>
      `;
    })
    .join("");
  const excerpt = String(item?.state?.last_text_excerpt || "").trim();
  return `
    <article class="identity-status-card ${escapeAttr(view.cls)}" data-status-module="${escapeAttr(spec.key)}">
      <div class="identity-status-card-head">
        <span class="identity-status-icon">${escapeHtml(view.icon)}</span>
        <strong>${escapeHtml(view.label)}</strong>
        <em>${escapeHtml(view.status)}</em>
      </div>
      <div class="identity-status-card-main">
        <span class="identity-status-time" ${view.nextAt ? `data-status-timer="1" data-next-at="${view.nextAt}" data-start-at="${view.startAt}"` : ""}>
          ${escapeHtml(view.time)}
        </span>
        <span class="identity-status-bar"><span style="width:${view.pct.toFixed(1)}%"></span></span>
      </div>
      ${excerpt ? `<p>${escapeHtml(clipGraphemes(excerpt.replace(/\s+/g, " "), 82))}</p>` : '<p class="muted">暂无最近文案。</p>'}
      ${actionButtons ? `<div class="identity-status-actions">${actionButtons}</div>` : ""}
    </article>
  `;
}

function identityModuleView(spec, item) {
  const skill = spec.skill ? skillByKey(spec.skill) : null;
  const now = Date.now() / 1000;
  const summary = item?.summary || {};
  const st = item?.state || {};
  const label = item?.label || skill?.label || spec.label || spec.key;
  const icon = skill?.icon || spec.icon || "•";
  const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
  const startAt = moduleStartTs(st);
  const lastStatus = String(summary.status || st.last_status || "");
  if (!item) {
    return { label, icon, cls: "unknown", status: "未观测", time: "未知", nextAt: 0, startAt: 0, pct: 0 };
  }
  if (String(summary.phase || st.phase || "") === "running") {
    if (nextAt > now) {
      const remaining = nextAt - now;
      return moduleTimingView({ label, icon, cls: "running", status: "进行中", nextAt, startAt, remaining });
    }
    return { label, icon, cls: "ready", status: "待结算", time: "已到点", nextAt: 0, startAt, pct: 100 };
  }
  if (!nextAt || nextAt <= now || summary.ready === true) {
    const status = lastStatus === "failed" ? "上次失败" : lastStatus === "cooldown" ? "已过 CD" : "已就绪";
    const cls = lastStatus === "failed" ? "warn" : "ready";
    return { label, icon, cls, status, time: summary.text || "已就绪", nextAt: 0, startAt, pct: 100 };
  }
  return moduleTimingView({ label, icon, cls: "cooling", status: lastStatus === "cooldown" ? "冷却中" : "等待中", nextAt, startAt, remaining: nextAt - now });
}

function moduleTimingView({ label, icon, cls, status, nextAt, startAt, remaining }) {
  const total = Math.max(1, nextAt - startAt);
  const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
  return {
    label,
    icon,
    cls,
    status,
    time: `剩 ${fmtCountdown(remaining)}`,
    nextAt,
    startAt,
    pct,
  };
}

function identityStatusActions(spec) {
  const keys = [spec.skill, ...(spec.extraSkills || []), spec.query].filter(Boolean);
  const seen = new Set();
  return keys
    .map((key) => skillByKey(key))
    .filter(Boolean)
    .filter((skill) => {
      if (skill.reply_mode === "required" || !String(skill.command || "").trim()) return false;
      if (seen.has(skill.key)) return false;
      seen.add(skill.key);
      return true;
    });
}

function skillByKey(skillKey) {
  if (!skillKey) return null;
  return (state.skills || []).find((skill) => skill.key === skillKey) || null;
}

function bindIdentityStatusModal(dialog) {
  bindIdentityStatusBody(dialog);
  dialog.querySelector('[data-identity-status-action="refresh"]')?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const old = button.textContent;
    button.disabled = true;
    button.textContent = "刷新中...";
    try {
      await Promise.all([
        loadIdentityModuleStates(),
        loadIdentityPatches({ reset: true }),
      ]);
      const body = dialog.querySelector("#identityStatusBody");
      if (body) body.innerHTML = renderIdentityStatusBody();
      bindIdentityStatusBody(dialog);
      renderGameCockpit();
      renderSkillViews();
    } catch (error) {
      showSkillToast(`刷新失败: ${error.message || error}`, "err");
    } finally {
      button.disabled = false;
      button.textContent = old || "刷新状态";
    }
  });
}

function bindIdentityStatusBody(dialog) {
  dialog.querySelectorAll("[data-status-skill]").forEach((button) => {
    button.addEventListener("click", () => fillSkillIntoComposer(button.dataset.statusSkill, button));
  });
  dialog.querySelectorAll("[data-identity-source-jump]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.identitySourceJump || "";
      if (!id) return;
      const message = await findOrFetchMessage(id);
      if (message) {
        closeModal();
        jumpToMessage(message);
      }
    });
  });
}

function directReplyContextFromMessage(message) {
  if (!message) return null;
  const chatId = Number(message.chat_id || 0);
  const msgId = Number(message.msg_id || 0);
  if (!chatId || !msgId) return null;
  return {
    messageId: message.id || `tg:${chatId}:${msgId}`,
    chatId,
    replyToMsgId: msgId,
    topMsgId: Number(message.top_msg_id || 0) || null,
    source: displaySource(message.source),
    preview: manualMessagePreview(message),
  };
}

function directReplyContextFromAction(action, fallbackMessage = null) {
  if (!action) return null;
  const chatId = Number(action.chat_id || fallbackMessage?.chat_id || 0);
  const replyToMsgId = Number(action.reply_to_msg_id || 0);
  if (!chatId || !replyToMsgId) return null;
  const parent =
    state.messages.find(
      (message) =>
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

function setDirectSendReply(replyContext) {
  state.directSendReply = replyContext || null;
  renderDirectSendReplyContext();
}

function clearDirectSendReply() {
  setDirectSendReply(null);
}

function renderDirectSendReplyContext() {
  if (!directSendReplyContext) return;
  const reply = state.directSendReply;
  if (!reply) {
    directSendReplyContext.hidden = true;
    directSendReplyContext.innerHTML = "";
    return;
  }
  const preview = reply.preview || `${reply.source || "Telegram 消息"} #${reply.replyToMsgId || ""}`;
  directSendReplyContext.hidden = false;
  directSendReplyContext.innerHTML = `
    <div class="direct-send-reply-main">
      <span>回复</span>
      <strong>${escapeHtml(preview)}</strong>
      <small>群 ${escapeHtml(String(reply.chatId || ""))}｜消息 #${escapeHtml(String(reply.replyToMsgId || ""))}</small>
    </div>
    <button type="button" data-direct-reply-clear>取消回复</button>
  `;
  directSendReplyContext.querySelector("[data-direct-reply-clear]")?.addEventListener("click", () => {
    clearDirectSendReply();
    focusDirectSendInput();
  });
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
  if (!directSendSelectionContext) return;
  const message = selectedVisibleMessage();
  if (!message) {
    directSendSelectionContext.hidden = true;
    directSendSelectionContext.innerHTML = "";
    return;
  }
  const channels = (message.channels || [message.channel])
    .map((channel) => channelLabel(channel))
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
  const title = String(message.title || "").trim();
  const raw = String(message.summary || message.raw || "").trim().replace(/\s+/g, " ");
  const preview = clipGraphemes(raw || title || "（空消息）", 120);
  const canReply = Number(message.chat_id || 0) !== 0 && Number(message.msg_id || 0) > 0;
  const kind = messageKind(message);
  const source = displaySource(message.source);
  directSendSelectionContext.hidden = false;
  directSendSelectionContext.innerHTML = `
    <div class="direct-selection-main kind-${escapeAttr(kind)}">
      <span>当前消息</span>
      <strong>${escapeHtml(source)}${title ? `｜${escapeHtml(title)}` : ""}</strong>
      <small>${escapeHtml(formatChatTime(message.time) || message.time || "")}${channels ? `｜${escapeHtml(channels)}` : ""}${message.msg_id ? `｜#${escapeHtml(String(message.msg_id))}` : ""}</small>
      <p>${escapeHtml(preview)}</p>
    </div>
    <div class="direct-selection-actions">
      <button type="button" class="primary" data-direct-selected-action="reply" ${canReply ? "" : "disabled"}>回复</button>
      <button type="button" data-direct-selected-action="quote">填入原文</button>
      <button type="button" data-direct-selected-action="copy">复制</button>
      <button type="button" data-direct-selected-action="clear">清除</button>
    </div>
  `;
  directSendSelectionContext.querySelector('[data-direct-selected-action="reply"]')?.addEventListener("click", () => {
    setDirectSendReplyFromMessage(message);
  });
  directSendSelectionContext.querySelector('[data-direct-selected-action="quote"]')?.addEventListener("click", () => {
    const text = String(message.raw || message.summary || message.title || "").trim();
    fillDirectSendComposer(text, {
      replyContext: null,
      statusText: "已把当前消息原文填入发送框，请确认后发送。",
      statusKind: "info",
    });
  });
  directSendSelectionContext.querySelector('[data-direct-selected-action="copy"]')?.addEventListener("click", async (event) => {
    const text = String(message.raw || message.summary || message.title || "").trim();
    await copyCommandToClipboard(text, event.currentTarget);
  });
  directSendSelectionContext.querySelector('[data-direct-selected-action="clear"]')?.addEventListener("click", () => {
    state.selectedMessageId = null;
    setWorkspacePanelOpen(false);
    renderMessages();
    renderDirectSendComposer();
  });
}

function renderDirectSendActionHints() {
  if (!directSendActionHints) return;
  const message = selectedVisibleMessage();
  const actions = (message?.actions || []).filter((action) => String(action.command || "").trim());
  if (!message || !actions.length) {
    directSendActionHints.hidden = true;
    directSendActionHints.innerHTML = "";
    return;
  }
  directSendActionHints.hidden = false;
  directSendActionHints.innerHTML = `
    <span class="direct-action-hints-label">候选动作</span>
    <div class="direct-action-hints-list">
    ${actions.slice(0, 6).map((action, index) => {
      const command = String(action.command || "").trim();
      return `
        <button type="button" data-direct-action-hint="${index}" title="${escapeAttr(command)}">
          <strong>${escapeHtml(quickActionLabel(action))}</strong>
          <small>${escapeHtml(clipGraphemes(command, 42))}</small>
        </button>
      `;
    }).join("")}
    ${actions.length > 6 ? `<span class="direct-action-hints-more">+${actions.length - 6}</span>` : ""}
    </div>
  `;
  directSendActionHints.querySelectorAll("[data-direct-action-hint]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = actions[Number(button.dataset.directActionHint || 0)];
      if (!action) return;
      fillDirectSendComposer(action.command, {
        identityId: action.identity_id,
        replyContext: directReplyContextFromAction(action, message),
        statusText: quickActionNeedsManualReview(action)
          ? "已填入候选动作，请补全内容后发送。"
          : "已填入候选动作，请确认后发送。",
        statusKind: "info",
      });
    });
  });
}

function fillDirectSendComposer(command, opts = {}) {
  const text = String(command || "").trim();
  if (opts.identityId) {
    state.directSendIdentityId = Number(opts.identityId || 0) || state.directSendIdentityId;
  }
  if (opts.replyContext !== undefined) {
    setDirectSendReply(opts.replyContext);
  }
  renderDirectSendComposer();
  if (directSendInput && text) {
    directSendInput.value = text;
    resizeDirectSendInput();
  }
  if (opts.statusText) {
    setDirectSendStatus(opts.statusText, opts.statusKind || "info");
  }
  if (opts.focus !== false) {
    focusDirectSendInput();
  }
}

function resizeDirectSendInput() {
  if (!directSendInput) return;
  directSendInput.style.height = "auto";
  const style = window.getComputedStyle(directSendInput);
  const minHeight = Number.parseFloat(style.minHeight) || 44;
  const cssMaxHeight = Number.parseFloat(style.maxHeight);
  const maxHeight = Number.isFinite(cssMaxHeight) && cssMaxHeight > 0 ? cssMaxHeight : 140;
  const nextHeight = Math.min(Math.max(directSendInput.scrollHeight, minHeight), maxHeight);
  directSendInput.style.height = `${nextHeight}px`;
  directSendInput.style.overflowY = directSendInput.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
}

function focusDirectSendInput() {
  window.requestAnimationFrame(() => {
    if (!directSendInput) return;
    resizeDirectSendInput();
    if (window.innerWidth <= 900) {
      directSendComposer?.scrollIntoView({ block: "nearest" });
    }
    try {
      directSendInput.focus({ preventScroll: true });
    } catch (_error) {
      directSendInput.focus();
    }
    directSendInput.setSelectionRange(directSendInput.value.length, directSendInput.value.length);
  });
}

function setDirectSendReplyFromMessage(message) {
  const reply = directReplyContextFromMessage(message);
  if (!reply) {
    showSkillToast("这条消息缺少 Telegram chat_id/msg_id，不能回复", "err");
    return;
  }
  fillDirectSendComposer("", {
    replyContext: reply,
    statusText: `已锁定回复对象：${reply.preview}`,
    statusKind: "info",
  });
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

async function openResourceStatsModal() {
  const dialog = openModal({
    title: "资源统计",
    body: `
      <section class="modal-section">
        <h4>全服资源统计</h4>
        <p class="muted">当前统计消息箱采集到的「野外历练」「风希」「极阴」「南陇侯」「非血色副本」「灵树」结算。副本可按入口单独筛选，稀有产物会优先展示。</p>
        <div class="form-grid resource-stats-controls">
          <label>
            <span>周期</span>
            <select id="resourceStatsPeriod">
              <option value="day">按天</option>
              <option value="week">按周</option>
              <option value="month">按月</option>
            </select>
          </label>
          <label>
            <span>来源</span>
            <select id="resourceStatsSource">
              <option value="all">全部</option>
              <option value="wild_training">野外历练</option>
              <option value="wind_xi">风希</option>
              <option value="jiyin">极阴</option>
              <option value="nanlong">南陇侯</option>
              <option value="tree_harvest">灵树采摘</option>
              <option value="dungeon">副本结算（全部）</option>
              <option value="dungeon|虚天殿·夺鼎">副本 · 虚天殿 · 夺鼎</option>
              <option value="dungeon|虚天殿·求稳">副本 · 虚天殿 · 求稳</option>
              <option value="dungeon|黄龙山">副本 · 黄龙山</option>
              <option value="dungeon|昆吾山">副本 · 昆吾山</option>
              <option value="dungeon|坠魔谷">副本 · 坠魔谷</option>
            </select>
          </label>
        </div>
        <div class="form-actions">
          <button type="button" id="resourceStatsRefresh">刷新统计</button>
          <button type="button" id="resourceCoverageRefresh">覆盖诊断</button>
          <button type="button" id="resourceCoverageReparse">补解析漏样本</button>
        </div>
        <p class="modal-status-line info" id="resourceStatsStatus" hidden></p>
      </section>

      <section class="modal-section">
        <div id="resourceStatsSummary" class="resource-stats-summary"></div>
        <div id="resourceCoverageBox" class="resource-stats-table-wrap" hidden></div>
        <div id="resourceStatsTable" class="resource-stats-table-wrap">
          <p class="empty inline">选择周期和来源后，点击「刷新统计」读取数据。打开面板不会自动统计。</p>
        </div>
      </section>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindResourceStatsModal(dialog);
  setResourceStatsStatus(dialog, "info", "未自动统计。需要时点「刷新统计」。");
}

function bindResourceStatsModal(dialog) {
  dialog.querySelector("#resourceStatsRefresh")?.addEventListener("click", () => {
    refreshResourceStats(dialog).catch((error) => {
      setResourceStatsStatus(dialog, "error", error.message || "刷新失败");
    });
  });
  dialog.querySelector("#resourceCoverageRefresh")?.addEventListener("click", () => {
    refreshResourceCoverage(dialog).catch((error) => {
      setResourceStatsStatus(dialog, "error", error.message || "覆盖诊断失败");
    });
  });
  dialog.querySelector("#resourceCoverageReparse")?.addEventListener("click", () => {
    reparseResourceCoverage(dialog).catch((error) => {
      setResourceStatsStatus(dialog, "error", error.message || "补解析失败");
    });
  });
  dialog.querySelector("#resourceStatsPeriod")?.addEventListener("change", () => {
    resetResourceStatsPlaceholder(dialog);
  });
  dialog.querySelector("#resourceStatsSource")?.addEventListener("change", () => {
    resetResourceStatsPlaceholder(dialog);
  });
}

async function reparseResourceCoverage(dialog) {
  const button = dialog.querySelector("#resourceCoverageReparse");
  if (button) button.disabled = true;
  setResourceStatsStatus(dialog, "info", "正在重跑最近漏解析资源候选…");
  try {
    const payload = await postJson("/api/resource-coverage/reparse", { limit: 5000 });
    if (!payload.ok) throw new Error(payload.error || "补解析失败");
    const text = `补解析完成：有效 ${payload.scanned || 0} 条，跳过噪音 ${payload.skipped || 0} 条，写入事件 ${payload.reparsed_events || 0}，流水 ${payload.reparsed_deltas || 0}，仍未识别 ${payload.still_missing || 0}`;
    setResourceStatsStatus(dialog, payload.still_missing ? "warn" : "ok", text);
    await refreshResourceCoverage(dialog);
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshResourceCoverage(dialog) {
  const box = dialog.querySelector("#resourceCoverageBox");
  const button = dialog.querySelector("#resourceCoverageRefresh");
  if (box) {
    box.hidden = false;
    box.innerHTML = '<p class="empty inline">覆盖诊断中…</p>';
  }
  if (button) button.disabled = true;
  setResourceStatsStatus(dialog, "info", "正在扫描最近疑似资源文案…");
  try {
    const payload = await fetchJson("/api/resource-coverage?limit=5000");
    if (!payload.ok) throw new Error(payload.error || "覆盖诊断失败");
    if (box) box.innerHTML = renderResourceCoverage(payload);
    setResourceStatsStatus(
      dialog,
      payload.missing ? "warn" : "ok",
      `覆盖诊断：有效 ${payload.scanned || 0} 条，已解析 ${payload.parsed || 0} 条，疑似漏 ${payload.missing || 0} 条，已排除噪音 ${payload.ignored || 0} 条。`
    );
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshResourceStats(dialog) {
  const period = dialog.querySelector("#resourceStatsPeriod")?.value || "day";
  const sourceFilter = parseResourceStatsSource(dialog.querySelector("#resourceStatsSource")?.value || "all");
  const table = dialog.querySelector("#resourceStatsTable");
  const refreshButton = dialog.querySelector("#resourceStatsRefresh");
  if (table) table.innerHTML = '<p class="empty inline">加载中…</p>';
  if (refreshButton) refreshButton.disabled = true;
  setResourceStatsStatus(dialog, "info", "正在读取统计…");
  try {
    const params = new URLSearchParams({ period, source_type: sourceFilter.source_type, limit: "500" });
    if (sourceFilter.source_name) params.set("source_name", sourceFilter.source_name);
    const payload = await fetchJson(`/api/resource-stats?${params.toString()}`);
    renderResourceStats(dialog, payload);
    const count = (payload.rows || []).length + (payload.events || []).length;
    setResourceStatsStatus(dialog, "ok", `已加载 ${count} 行。血色副本结算不会进入这里。`);
  } catch (error) {
    if (table) {
      table.innerHTML = `<p class="empty inline">统计读取失败：${escapeHtml(error.message || "未知错误")}</p>`;
    }
    throw error;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

function resetResourceStatsPlaceholder(dialog) {
  const summary = dialog.querySelector("#resourceStatsSummary");
  const table = dialog.querySelector("#resourceStatsTable");
  const coverage = dialog.querySelector("#resourceCoverageBox");
  if (summary) summary.innerHTML = "";
  if (coverage) {
    coverage.hidden = true;
    coverage.innerHTML = "";
  }
  if (table) {
    table.innerHTML = '<p class="empty inline">筛选条件已改变，点击「刷新统计」重新读取。</p>';
  }
  setResourceStatsStatus(dialog, "info", "未自动刷新，避免打开或切换时重复扫统计。");
}

function setResourceStatsStatus(dialog, kind, text) {
  const status = dialog.querySelector("#resourceStatsStatus");
  if (!status) return;
  status.hidden = !text;
  status.className = `modal-status-line ${kind || "info"}`;
  status.textContent = text || "";
}

function renderResourceStats(dialog, payload) {
  const rows = payload.rows || [];
  const events = payload.events || [];
  const eventSummary = payload.event_summary || [];
  const summary = dialog.querySelector("#resourceStatsSummary");
  const table = dialog.querySelector("#resourceStatsTable");
  if (summary) {
    summary.innerHTML = renderResourceDashboard(payload);
  }
  if (!table) return;
  if (!rows.length && !events.length) {
    table.innerHTML = '<p class="empty inline">暂无统计数据。只有 listener 采到对应结算文案后才会出现。</p>';
    return;
  }
  table.innerHTML = `
    <div class="resource-stats-detail-head">
      <span>明细默认收起，避免大表拖慢弹窗。</span>
      <button type="button" id="resourceStatsToggleDetails">展开明细</button>
    </div>
    <div id="resourceStatsDetailBody" hidden>
      ${renderResourceDeltaTable(rows)}
      ${renderResourceEventTable(eventSummary)}
      ${renderResourceDiagnostics(payload.diagnostics || {})}
      ${Array.isArray(payload.notes) && payload.notes.length
        ? `<div class="resource-stats-notes">${payload.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>`
        : ""}
    </div>
  `;
  const toggle = table.querySelector("#resourceStatsToggleDetails");
  const detail = table.querySelector("#resourceStatsDetailBody");
  toggle?.addEventListener("click", () => {
    if (!detail) return;
    const hidden = detail.hidden;
    detail.hidden = !hidden;
    toggle.textContent = hidden ? "收起明细" : "展开明细";
  });
}

function renderResourceDashboard(payload) {
  const rows = payload.rows || [];
  const eventSummary = payload.event_summary || [];
  const latestPeriod = latestResourcePeriod(rows, eventSummary);
  const sourceType = payload.source_type || "all";
  const sections = [];
  sections.push(`
    <section class="resource-dashboard-section compact">
      <div class="resource-dashboard-head">
        <div>
          <strong>统计口径</strong>
          <span>${escapeHtml(latestPeriod || "暂无周期")}｜${escapeHtml(resourceStatsScopeLabel(payload))}</span>
        </div>
      </div>
      <div class="resource-dashboard-strip">
        ${renderResourceTrustCards(payload)}
      </div>
    </section>
  `);
  if (sourceType === "all" || sourceType === "wild_training") {
    sections.push(renderWildTrainingDashboardPanel(rows, eventSummary, latestPeriod));
  }
  sections.push(renderRareResourceDashboardPanel(rows, latestPeriod));
  sections.push(renderEventOutcomeDashboardPanel(eventSummary, latestPeriod, sourceType));
  return `<div class="resource-dashboard">${sections.filter(Boolean).join("")}</div>`;
}

function renderWildTrainingDashboardPanel(rows, eventSummary, latestPeriod) {
  const strategies = ["谨慎", "均衡", "深入"];
  const periodEvents = filterResourceRowsByPeriod(eventSummary, latestPeriod)
    .filter((row) => row.source_type === "wild_training");
  const periodRows = filterResourceRowsByPeriod(rows, latestPeriod)
    .filter((row) => row.source_type === "wild_training");
  if (!periodEvents.length && !periodRows.length) return "";
  const byStrategy = new Map(strategies.map((strategy) => [strategy, {
    strategy,
    success: 0,
    failed: 0,
    cooldown: 0,
    total: 0,
    gainXiuwei: 0,
    lossXiuwei: 0,
  }]));
  for (const row of periodEvents) {
    const strategy = wildStrategyFromSourceName(row.source_name);
    if (!byStrategy.has(strategy)) continue;
    const target = byStrategy.get(strategy);
    target.success += Number(row.success || 0) + Number(row.extra_success || 0);
    target.failed += Number(row.failed || 0) + Number(row.basic_only || 0);
    target.cooldown += Number(row.cooldown || 0);
    target.total += Number(row.total || 0);
  }
  for (const row of periodRows) {
    const strategy = wildStrategyFromSourceName(row.source_name);
    if (!byStrategy.has(strategy)) continue;
    if (!String(row.resource_name || "").includes("修为")) continue;
    const target = byStrategy.get(strategy);
    const amount = Number(row.total_amount || 0);
    if (amount >= 0) target.gainXiuwei += amount;
    else target.lossXiuwei += Math.abs(amount);
  }
  return `
    <section class="resource-dashboard-section">
      <div class="resource-dashboard-head">
        <div>
          <strong>野外历练</strong>
          <span>${escapeHtml(latestPeriod || "本期")}｜三难度成功率和修为正负收益分开看</span>
        </div>
      </div>
      <div class="resource-wild-grid">
        ${strategies.map((strategy) => renderWildStrategyCard(byStrategy.get(strategy))).join("")}
      </div>
    </section>
  `;
}

function renderWildStrategyCard(item) {
  const attempts = item.success + item.failed;
  const rate = attempts ? (item.success * 100) / attempts : 0;
  return `
    <article class="resource-wild-card">
      <div class="resource-wild-card-head">
        <strong>${escapeHtml(item.strategy)}</strong>
        <span>${attempts ? `${rate.toFixed(1)}%` : "—"}</span>
      </div>
      <div class="resource-progress-bar" aria-hidden="true">
        <span style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></span>
      </div>
      <div class="resource-wild-stats">
        <span>成功 <b>${escapeHtml(formatNumber(item.success))}</b></span>
        <span>失败 <b>${escapeHtml(formatNumber(item.failed))}</b></span>
        <span>CD <b>${escapeHtml(formatNumber(item.cooldown))}</b></span>
      </div>
      <div class="resource-wild-yield">
        <span>修为 +${escapeHtml(formatNumber(item.gainXiuwei))}</span>
        <span class="negative">-${escapeHtml(formatNumber(item.lossXiuwei))}</span>
      </div>
    </article>
  `;
}

function renderRareResourceDashboardPanel(rows, latestPeriod) {
  const rareRows = aggregateRareResourceRows(filterResourceRowsByPeriod(rows, latestPeriod));
  if (!rareRows.length) return "";
  const yinNing = rareRows.find((row) => isYinNingResource(row.resource_name));
  const scarce = rareRows
    .filter((row) => !isYinNingResource(row.resource_name))
    .sort((a, b) => (
      Number(a.total_amount || 0) - Number(b.total_amount || 0)
      || Number(a.event_count || 0) - Number(b.event_count || 0)
      || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
    ))
    .slice(0, yinNing ? 5 : 6);
  const items = [yinNing, ...scarce].filter(Boolean);
  return `
    <section class="resource-dashboard-section">
      <div class="resource-dashboard-head">
        <div>
          <strong>稀有产物</strong>
          <span>${escapeHtml(latestPeriod || "本期")}｜阴凝优先，其余按低量稀有靠前</span>
        </div>
      </div>
      <div class="resource-rare-grid">
        ${items.map((item) => `
          <article class="resource-rare-card ${isYinNingResource(item.resource_name) ? "highlight" : ""}">
            <span>${escapeHtml(item.resource_name || "资源")}</span>
            <strong>${escapeHtml(formatResourceAmount(item.total_amount, item.unit))}</strong>
            <small>${escapeHtml((item.sources || []).slice(0, 2).join(" / ") || "资源")}｜${escapeHtml(formatNumber(item.event_count))} 次</small>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderEventOutcomeDashboardPanel(eventSummary, latestPeriod, sourceType) {
  const rows = filterResourceRowsByPeriod(eventSummary, latestPeriod)
    .filter((row) => row.source_type !== "wild_training");
  if (!rows.length) return "";
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.source_type || ""}|${row.source_name || ""}`;
    const item = grouped.get(key) || {
      source_type: row.source_type || "",
      source_name: row.source_name || "",
      success: 0,
      failed: 0,
      escaped: 0,
      cooldown: 0,
      extra: 0,
      basic: 0,
      settled: 0,
      total: 0,
      outcomes: [],
    };
    item.success += Number(row.success || 0);
    item.failed += Number(row.failed || 0);
    item.escaped += Number(row.escaped || 0);
    item.cooldown += Number(row.cooldown || 0);
    item.extra += Number(row.extra_success || 0);
    item.basic += Number(row.basic_only || 0);
    item.settled += Number(row.settled || 0);
    item.total += Number(row.total || 0);
    if (row.outcome && !item.outcomes.includes(row.outcome)) item.outcomes.push(row.outcome);
    grouped.set(key, item);
  }
  const title = sourceType === "dungeon" ? "副本结算" : "副本 / 奇遇";
  const items = Array.from(grouped.values())
    .sort((a, b) => outcomeSourceRank(a.source_type) - outcomeSourceRank(b.source_type) || String(a.source_name).localeCompare(String(b.source_name), "zh-CN"))
    .slice(0, 8);
  return `
    <section class="resource-dashboard-section">
      <div class="resource-dashboard-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(latestPeriod || "本期")}｜副本按入口，风希/极阴/南陇侯单列</span>
        </div>
      </div>
      <div class="resource-outcome-grid">
        ${items.map(renderOutcomeCard).join("")}
      </div>
    </section>
  `;
}

function renderOutcomeCard(item) {
  const isDungeon = item.source_type === "dungeon";
  const main = isDungeon
    ? `${formatNumber(item.extra + item.basic + item.settled)} 次`
    : `${formatNumber(item.success + item.failed + item.escaped || item.total)} 次`;
  const detail = isDungeon
    ? `额外 ${formatNumber(item.extra)}｜基础 ${formatNumber(item.basic)}｜结算 ${formatNumber(item.settled)}`
    : `成功 ${formatNumber(item.success)}｜失败 ${formatNumber(item.failed)}${item.escaped ? `｜逃脱 ${formatNumber(item.escaped)}` : ""}`;
  return `
    <article class="resource-outcome-card ${escapeAttr(item.source_type || "unknown")}">
      <span>${escapeHtml(resourceSourceLabel(item.source_type, item.source_name))}</span>
      <strong>${escapeHtml(main)}</strong>
      <small>${escapeHtml(detail)}</small>
      ${item.outcomes.length ? `<em>${escapeHtml(item.outcomes.slice(0, 2).join(" / "))}</em>` : ""}
    </article>
  `;
}

function outcomeSourceRank(sourceType) {
  return {
    dungeon: 1,
    wind_xi: 2,
    jiyin: 3,
    nanlong: 4,
    tree_harvest: 5,
  }[sourceType] || 9;
}

function renderResourceDiagnostics(diagnostics) {
  const unknown = Number(diagnostics.unknown_source_events || 0);
  const empty = Number(diagnostics.empty_outcome_events || 0);
  if (!unknown && !empty) return "";
  const chips = [];
  if (unknown) chips.push(`来源未知 ${formatNumber(unknown)} 条`);
  if (empty) chips.push(`结果细分空 ${formatNumber(empty)} 条`);
  const samples = [
    ...(diagnostics.unknown_sources || []).slice(0, 3),
    ...(diagnostics.empty_outcomes || []).slice(0, 3),
  ];
  return `
    <div class="resource-stats-notes warn">
      ${chips.map((text) => `<span>${escapeHtml(text)}</span>`).join("")}
      ${samples.map((item) => `<span>${escapeHtml(item.source || "")}｜${escapeHtml(formatNumber(item.count || 0))}</span>`).join("")}
    </div>
  `;
}

function renderResourceTrustCards(payload) {
  const audit = state.messageAudit || {};
  const gapCount = Number(audit.gap_count || 0);
  const rows = payload.rows || [];
  const events = payload.events || [];
  const cards = [];
  cards.push(`
    <div class="resource-stat-card ${gapCount ? "warn" : ""}">
      <span>统计可信度</span>
      <strong>${escapeHtml(gapCount ? "需复核" : "正常")}</strong>
      <small>${gapCount ? `消息箱近24小时 ${formatNumber(gapCount)} 段断层` : "消息箱近期无明显断层"}</small>
    </div>
  `);
  cards.push(`
    <div class="resource-stat-card">
      <span>当前口径</span>
      <strong>${escapeHtml(resourceStatsScopeLabel(payload))}</strong>
      <small>${escapeHtml((payload.period || "day") === "week" ? "按周" : (payload.period || "day") === "month" ? "按月" : "按天")}｜${escapeHtml(formatNumber(events.length))} 事件行 / ${escapeHtml(formatNumber(rows.length))} 资源行</small>
    </div>
  `);
  return cards.join("");
}

function resourceStatsScopeLabel(payload) {
  const type = payload.source_type || "all";
  const name = payload.source_name || "";
  if (!type || type === "all") return "全部来源";
  return resourceSourceLabel(type, name);
}

function renderResourceCoverage(payload) {
  const rows = payload.rows || [];
  const samples = payload.missing_samples || [];
  if (!rows.length) {
    return '<p class="empty inline">最近没有命中资源统计候选文案。</p>';
  }
  return `
    <div class="resource-stats-subtitle">覆盖诊断 · 有效 ${escapeHtml(formatNumber(payload.scanned || 0))} 条 / 原始 ${escapeHtml(formatNumber(payload.candidate_rows || payload.scanned || 0))} 条</div>
    <table class="resource-stats-table">
      <thead>
        <tr>
          <th>文案类型</th>
          <th>候选</th>
          <th>已解析</th>
          <th>疑似漏</th>
          <th>覆盖率</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const total = Number(row.total || 0);
          const parsed = Number(row.parsed || 0);
          const rate = total ? `${Math.round((parsed * 1000) / total) / 10}%` : "—";
          return `
            <tr>
              <td>${escapeHtml(row.kind || "")}</td>
              <td class="num">${escapeHtml(formatNumber(total))}</td>
              <td class="num">${escapeHtml(formatNumber(parsed))}</td>
              <td class="num ${Number(row.missing || 0) ? "negative" : ""}">${escapeHtml(formatNumber(row.missing || 0))}</td>
              <td class="num">${escapeHtml(rate)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    ${samples.length ? `
      <div class="resource-stats-notes">
        ${samples.slice(0, 8).map((item) => `<span>${escapeHtml(item.kind || "")}｜#${escapeHtml(String(item.msg_id || ""))}｜${escapeHtml(clipGraphemes(item.text || "", 72))}</span>`).join("")}
      </div>
    ` : ""}
    ${Array.isArray(payload.notes) && payload.notes.length ? `<div class="resource-stats-notes">${payload.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : ""}
  `;
}

function renderResourceEventTable(summaryRows) {
  if (!summaryRows.length) return "";
  return groupResourceRowsBySource(summaryRows).map((group) => `
    <div class="resource-stats-subtitle">执行结果 · ${escapeHtml(group.label)}</div>
    <table class="resource-stats-table">
      <thead>
        <tr>
          <th>周期</th>
          <th>来源</th>
          <th>成功/额外</th>
          <th>失败/基础</th>
          <th>冷却</th>
          <th>结算</th>
          <th>成功率</th>
        </tr>
      </thead>
      <tbody>
        ${group.rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.period || "")}</td>
            <td>${escapeHtml(resourceSourceLabel(row.source_type, row.source_name))}</td>
            <td class="num">${escapeHtml(formatNumber((row.success || 0) + (row.extra_success || 0)))}</td>
            <td class="num">${escapeHtml(formatNumber((row.failed || 0) + (row.basic_only || 0)))}</td>
            <td class="num">${escapeHtml(formatNumber(row.cooldown || 0))}</td>
            <td class="num">${escapeHtml(formatNumber(row.settled || 0))}</td>
            <td class="num">${escapeHtml(formatSuccessRate(row.success_rate))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `).join("");
}

function renderResourceDeltaTable(rows) {
  if (!rows.length) return "";
  return `
    ${renderResourceDeltaAggregateTable(rows)}
    ${groupResourceRowsBySource(rows).map((group) => `
    ${renderResourceDeltaSubTable("稀有产物", group.rows.filter((row) => row.resource_category === "rare"), group.label)}
    ${renderResourceDeltaSubTable("正收益", group.rows.filter((row) => row.resource_category !== "rare" && row.amount_kind !== "loss"), group.label)}
    ${renderResourceDeltaSubTable("负收益", group.rows.filter((row) => row.amount_kind === "loss"), group.label)}
  `).join("")}
  `;
}

function renderResourceDeltaAggregateTable(rows) {
  const sourceCount = new Set(rows.map((row) => `${row.source_type || ""}|${row.source_name || ""}`)).size;
  if (sourceCount <= 1) return "";
  const isWildOnly = rows.length > 0 && rows.every((row) => row.source_type === "wild_training");
  const aggregateRows = aggregateResourceRows(rows).map((row) => (
    isWildOnly ? { ...row, source_type: "wild_training" } : row
  ));
  return `
    ${renderResourceDeltaSubTable("稀有产物", aggregateRows.filter((row) => row.resource_category === "rare"), "全部来源汇总")}
    ${renderResourceDeltaSubTable("正收益", aggregateRows.filter((row) => row.resource_category !== "rare" && row.amount_kind !== "loss"), "全部来源汇总")}
    ${renderResourceDeltaSubTable("负收益", aggregateRows.filter((row) => row.amount_kind === "loss"), "全部来源汇总")}
  `;
}

function aggregateResourceRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [
      row.period || "",
      row.resource_name || "",
      row.unit || "",
      row.basis || "",
      row.amount_kind || "",
      row.resource_category || "",
    ].join("|");
    const prev = grouped.get(key) || {
      period: row.period || "",
      source_type: "aggregate",
      source_name: "全部来源汇总",
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      amount_kind: row.amount_kind || "",
      resource_category: row.resource_category || "",
      total_amount: 0,
      event_count: 0,
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    grouped.set(key, prev);
  }
  return Array.from(grouped.values()).sort((a, b) => (
    String(b.period || "").localeCompare(String(a.period || ""), "zh-CN")
    || String(b.resource_category || "").localeCompare(String(a.resource_category || ""), "zh-CN")
    || String(a.amount_kind || "").localeCompare(String(b.amount_kind || ""), "zh-CN")
    || Math.abs(Number(b.total_amount || 0)) - Math.abs(Number(a.total_amount || 0))
    || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
  ));
}

function renderResourceDeltaSubTable(title, rows, label) {
  if (!rows.length) return "";
  const displayRows = sortResourceDeltaRowsForDisplay(rows, title);
  return `
    <div class="resource-stats-subtitle">${escapeHtml(title)} · ${escapeHtml(label)}</div>
    <table class="resource-stats-table">
      <thead>
        <tr>
          <th>周期</th>
          <th>资源</th>
          <th>合计</th>
          <th>单数</th>
          <th>口径</th>
        </tr>
      </thead>
      <tbody>
        ${displayRows.map((row) => `
          <tr>
            <td>${escapeHtml(row.period || "")}</td>
            <td>${escapeHtml(row.resource_name || "")}</td>
            <td class="num ${Number(row.total_amount || 0) < 0 ? "negative" : ""}">${escapeHtml(formatResourceAmount(row.total_amount, row.unit))}</td>
            <td class="num">${escapeHtml(formatNumber(row.event_count || 0))}</td>
            <td>${escapeHtml(resourceBasisLabel(row.basis))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function sortResourceDeltaRowsForDisplay(rows, title) {
  const items = [...(rows || [])];
  const isWildRare = title === "稀有产物" && items.some((row) => row.source_type === "wild_training");
  if (!isWildRare) return items;
  return items.sort((a, b) => (
    String(b.period || "").localeCompare(String(a.period || ""), "zh-CN")
    || Number(!isYinNingResource(a.resource_name)) - Number(!isYinNingResource(b.resource_name))
    || Number(a.total_amount || 0) - Number(b.total_amount || 0)
    || Number(a.event_count || 0) - Number(b.event_count || 0)
    || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
  ));
}

function groupResourceRowsBySource(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const label = resourceSourceLabel(row.source_type, row.source_name);
    const key = `${row.source_type || ""}|${row.source_name || ""}`;
    if (!grouped.has(key)) grouped.set(key, { label, rows: [] });
    grouped.get(key).rows.push(row);
  }
  return Array.from(grouped.values());
}

function renderResourceStatsSummary(rows, eventSummary, payload = {}) {
  if (!rows.length && !eventSummary.length) return "";
  if (payload.source_type === "wild_training") {
    return renderWildTrainingStatsSummary(rows, eventSummary);
  }
  const rareRows = rows.filter((row) => row.resource_category === "rare");
  const latestRarePeriod = latestResourcePeriod(rareRows, []);
  const latestEventPeriod = latestResourcePeriod([], eventSummary);
  const summaryRows = latestRarePeriod
    ? rareRows.filter((row) => String(row.period || "") === latestRarePeriod)
    : rareRows;
  const summaryEvents = latestEventPeriod
    ? eventSummary.filter((row) => String(row.period || "") === latestEventPeriod)
    : eventSummary;
  const cards = [];
  const totals = new Map();
  for (const row of summaryRows) {
    const key = `${row.resource_name || ""}|${row.unit || ""}|${row.basis || ""}`;
    const prev = totals.get(key) || {
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      total_amount: 0,
      event_count: 0,
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    totals.set(key, prev);
  }
  const top = Array.from(totals.values())
    .sort((a, b) => b.total_amount - a.total_amount || String(a.resource_name).localeCompare(String(b.resource_name), "zh-CN"))
    .slice(0, 4);
  cards.push(...top.map((item) => `
      <div class="resource-stat-card">
        <span>稀有｜${escapeHtml(item.resource_name || "资源")}</span>
        <strong>${escapeHtml(formatResourceAmount(item.total_amount, item.unit))}</strong>
        <small>${escapeHtml(latestRarePeriod || "本期")}｜${escapeHtml(resourceBasisLabel(item.basis))}｜${escapeHtml(formatNumber(item.event_count))} 次</small>
      </div>
  `));
  for (const item of summaryEvents.slice(0, 4)) {
    if (cards.length >= 6) break;
    const successRate = formatSuccessRate(item.success_rate);
    const eventTotal = Number(item.total || 0);
    const dungeonCount = Number((item.settled || 0) + (item.basic_only || 0) + (item.extra_success || 0));
    const main = item.source_type === "wild_training"
      ? `${formatNumber(item.success || 0)} 成 / ${formatNumber(item.failed || 0)} 败`
      : item.source_type === "wind_xi"
        ? `${formatNumber(item.success || 0)} 次成功`
        : item.source_type === "dungeon"
          ? `${formatNumber(dungeonCount)} 次`
          : `${formatNumber(eventTotal || dungeonCount)} 次`;
    const sub = item.source_type === "wild_training"
      ? `CD ${formatNumber(item.cooldown || 0)}｜成功率 ${successRate}`
      : item.source_type === "wind_xi"
        ? `成功率 ${successRate}`
        : item.source_type === "dungeon"
          ? `额外 ${formatNumber(item.extra_success || 0)}｜基础 ${formatNumber(item.basic_only || 0)}`
          : `成功 ${formatNumber(item.success || 0)}｜结算 ${formatNumber(item.settled || 0)}`;
    cards.push(`
      <div class="resource-stat-card">
        <span>${escapeHtml(resourceSourceLabel(item.source_type, item.source_name))}｜${escapeHtml(item.period || "")}</span>
        <strong>${escapeHtml(main)}</strong>
        <small>${escapeHtml(sub)}</small>
      </div>
    `);
  }
  return cards.join("");
}

function renderWildTrainingStatsSummary(rows, eventSummary) {
  const latestPeriod = latestResourcePeriod(rows, eventSummary);
  const periodEvents = latestPeriod
    ? eventSummary.filter((row) => String(row.period || "") === latestPeriod)
    : eventSummary;
  const periodRows = latestPeriod
    ? rows.filter((row) => String(row.period || "") === latestPeriod)
    : rows;
  const cards = [];
  const strategies = ["谨慎", "均衡", "深入"];
  const byStrategy = new Map(strategies.map((strategy) => [strategy, {
    strategy,
    success: 0,
    failed: 0,
    cooldown: 0,
    total: 0,
  }]));
  for (const row of periodEvents) {
    const strategy = wildStrategyFromSourceName(row.source_name);
    if (!byStrategy.has(strategy)) continue;
    const target = byStrategy.get(strategy);
    target.success += Number(row.success || 0) + Number(row.extra_success || 0);
    target.failed += Number(row.failed || 0) + Number(row.basic_only || 0);
    target.cooldown += Number(row.cooldown || 0);
    target.total += Number(row.total || 0);
  }
  for (const strategy of strategies) {
    const item = byStrategy.get(strategy);
    const attempts = item.success + item.failed;
    const rate = attempts ? `${((item.success * 100) / attempts).toFixed(1)}%` : "—";
    cards.push(`
      <div class="resource-stat-card">
        <span>野外历练·${escapeHtml(strategy)}｜${escapeHtml(latestPeriod || "本期")}</span>
        <strong>${escapeHtml(rate)}</strong>
        <small>${escapeHtml(formatNumber(item.success))} 成 / ${escapeHtml(formatNumber(item.failed))} 败｜CD ${escapeHtml(formatNumber(item.cooldown))}</small>
      </div>
    `);
  }

  const rareRows = aggregateWildRareRows(periodRows);
  const yinNing = rareRows.find((row) => isYinNingResource(row.resource_name)) || {
    resource_name: "阴凝之晶",
    total_amount: 0,
    event_count: 0,
    unit: "",
    basis: "player",
  };
  cards.push(`
    <div class="resource-stat-card">
      <span>稀有｜阴凝之晶</span>
      <strong>${escapeHtml(formatResourceAmount(yinNing.total_amount, yinNing.unit))}</strong>
      <small>${escapeHtml(latestPeriod || "本期")}｜${escapeHtml(formatNumber(yinNing.event_count))} 次</small>
    </div>
  `);

  const scarceRows = rareRows
    .filter((row) => !isYinNingResource(row.resource_name))
    .sort((a, b) => (
      Number(a.total_amount || 0) - Number(b.total_amount || 0)
      || Number(a.event_count || 0) - Number(b.event_count || 0)
      || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
    ))
    .slice(0, 2);
  cards.push(...scarceRows.map((item) => `
    <div class="resource-stat-card">
      <span>低量稀有｜${escapeHtml(item.resource_name || "资源")}</span>
      <strong>${escapeHtml(formatResourceAmount(item.total_amount, item.unit))}</strong>
      <small>${escapeHtml(latestPeriod || "本期")}｜${escapeHtml(formatNumber(item.event_count))} 次</small>
    </div>
  `));
  return cards.join("");
}

function aggregateWildRareRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (row.source_type !== "wild_training") continue;
    if (row.resource_category !== "rare") continue;
    if (row.amount_kind === "loss") continue;
    const key = `${row.resource_name || ""}|${row.unit || ""}|${row.basis || ""}`;
    const prev = grouped.get(key) || {
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      total_amount: 0,
      event_count: 0,
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    grouped.set(key, prev);
  }
  return Array.from(grouped.values());
}

function aggregateRareResourceRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (row.resource_category !== "rare") continue;
    if (row.amount_kind === "loss") continue;
    const key = `${row.resource_name || ""}|${row.unit || ""}|${row.basis || ""}`;
    const prev = grouped.get(key) || {
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      total_amount: 0,
      event_count: 0,
      sources: new Set(),
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    prev.sources.add(resourceSourceLabel(row.source_type, row.source_name));
    grouped.set(key, prev);
  }
  return Array.from(grouped.values()).map((item) => ({
    ...item,
    sources: Array.from(item.sources).filter(Boolean),
  }));
}

function filterResourceRowsByPeriod(rows, period) {
  const source = rows || [];
  if (!period) return source;
  return source.filter((row) => String(row.period || "") === String(period));
}

function wildStrategyFromSourceName(sourceName) {
  const text = String(sourceName || "");
  if (text.includes("谨慎")) return "谨慎";
  if (text.includes("均衡")) return "均衡";
  if (text.includes("深入")) return "深入";
  return "";
}

function isYinNingResource(resourceName) {
  return String(resourceName || "").includes("阴凝");
}

function latestResourcePeriod(rows, eventSummary) {
  const periods = [...rows, ...eventSummary]
    .map((row) => String(row.period || ""))
    .filter(Boolean);
  if (!periods.length) return "";
  return periods.sort((a, b) => b.localeCompare(a, "zh-CN"))[0] || "";
}

function resourceSourceLabel(sourceType, sourceName) {
  if (sourceType === "wild_training") return sourceName || "野外历练";
  if (sourceType === "wind_xi") return "风希";
  if (sourceType === "jiyin") return "极阴";
  if (sourceType === "nanlong") return "南陇侯";
  if (sourceType === "dungeon") return sourceName ? `副本 · ${sourceName}` : "副本结算";
  if (sourceType === "tree_harvest") return sourceName || "灵树采摘";
  return sourceName || sourceType || "未知";
}

function parseResourceStatsSource(value) {
  const raw = String(value || "all");
  const [sourceType, ...rest] = raw.split("|");
  return {
    source_type: sourceType || "all",
    source_name: rest.join("|").trim(),
  };
}

function resourceBasisLabel(value) {
  if (value === "run") return "单次";
  if (value === "player") return "单人";
  return value || "事件";
}

function formatSuccessRate(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
}

function formatResourceAmount(value, unit) {
  const text = formatNumber(value);
  return unit ? `${text} ${unit}` : text;
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

function visibleMessages() {
  if (state.selectedChannels.size === 0) {
    return [];
  }
  // solo 模式数据已由 server 端 SQL 预过滤(mode=solo);前端只做频道过滤。
  // 「日志」modal 是另一条单独的全量数据流,不走这里。
  return state.messages.filter((message) => {
    const channels = message.channels || [message.channel];
    if (!channels.some((channel) => state.selectedChannels.has(channel))) {
      return false;
    }
    return messageMatchesSearch(message);
  });
}

function messageMatchesSearch(message) {
  const query = String(state.messageSearch || "").trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    message.title,
    message.summary,
    message.raw,
    message.source,
    message.channel,
    ...(message.channels || []),
    ...Object.entries(message.fields || {}).map(([key, value]) => `${key} ${formatFieldValue(value)}`),
    ...(message.tags || []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
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
  if (!card.reply_to_msg_id || !card.chat_id) return null;
  const parentId = `tg:${card.chat_id}:${card.reply_to_msg_id}`;
  return (
    state.messages.find((m) => m.id === parentId) ||
    state.messages.find(
      (m) =>
        Number(m.chat_id || 0) === Number(card.chat_id || 0) &&
        Number(m.msg_id || 0) === Number(card.reply_to_msg_id || 0)
    ) ||
    null
  );
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
  if (!message.reply_to_msg_id || !message.chat_id) return "";
  const parent = parentMessageOf(message);
  const parentId = `tg:${message.chat_id}:${message.reply_to_msg_id}`;
  if (parent) {
    const preview = clipGraphemes((parent.raw || parent.summary || "").trim().replace(/\s+/g, " "), 60) || "(无内容)";
    return `
      <div class="chat-reply-context" data-reply-jump="${escapeAttr(parentId)}" title="点击跳到原消息">
        <span class="arrow">↪</span>
        <span class="source">${escapeHtml(displaySource(parent.source))}</span>
        <span class="preview">${escapeHtml(preview)}</span>
      </div>
    `;
  }
  // 父消息不在当前 state(超出初始 200 条范围),仍可点击 — 点了会按需拉
  return `
    <div class="chat-reply-context" data-reply-jump="${escapeAttr(parentId)}" title="点击按需拉取并跳到原消息">
      <span class="arrow">↪</span>
      <span class="preview muted">回复消息 #${escapeHtml(String(message.reply_to_msg_id))}(点击载入)</span>
    </div>
  `;
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
  if (!channelFilters) {
    renderActiveChannelText();
    return;
  }
  const counts = channelMessageCounts();
  const latestByChannel = latestMessagesByChannel();
  channelFilters.replaceChildren(
    ...orderedChannelsForConversationList(latestByChannel).map((channel) => {
      const button = document.createElement("button");
      button.type = "button";
      const isActive = state.selectedChannels.has(channel.key);
      button.className = "channel-chip" + (isActive ? " active" : "");
      const latest = latestByChannel.get(channel.key) || null;
      button.title = channelTooltip(channel, latest);
      button.dataset.channelKey = channel.key;
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      const count = counts.get(channel.key) || 0;
      const preview = channelPreviewText(latest, channel);
      const time = latest ? formatChatTime(latest.time) : "";
      button.innerHTML = `
        <span class="channel-chip-icon" aria-hidden="true">${escapeHtml(channelIcon(channel.key, channel.label))}</span>
        <span class="channel-chip-main">
          <span class="channel-chip-top">
            <span class="channel-chip-label">${escapeHtml(channel.label)}</span>
            <span class="channel-chip-time">${escapeHtml(time)}</span>
          </span>
          <span class="channel-chip-preview">${escapeHtml(preview)}</span>
        </span>
        <span class="channel-chip-count">${count ? escapeHtml(String(count)) : ""}</span>
      `;
      button.addEventListener("click", (event) => {
        let next;
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          next = new Set(state.selectedChannels);
          if (state.selectedChannels.has(channel.key)) {
            next.delete(channel.key);
          } else {
            next.add(channel.key);
          }
        } else {
          next = new Set([channel.key]);
        }
        applyChannelSelection(next).catch((error) => {
          console.warn("[mini-web] channel selection failed:", error);
          showSkillToast(`频道加载失败: ${error.message || error}`, "err");
        });
      });
      return button;
    })
  );

  if (selectAllChannels) {
    selectAllChannels.textContent =
      state.selectedChannels.size === state.channels.length ? "重点" : "全部";
  }
  renderActiveChannelText();
}

function orderedChannelsForConversationList(latestByChannel = null) {
  const latestMap = latestByChannel || latestMessagesByChannel();
  const originalIndex = new Map(state.channels.map((channel, index) => [channel.key, index]));
  return [...state.channels].sort((a, b) => {
    const aLatest = latestMap.get(a.key);
    const bLatest = latestMap.get(b.key);
    const recency = compareMessagesByRecency(aLatest, bLatest);
    if (recency) return recency;
    return (originalIndex.get(a.key) || 0) - (originalIndex.get(b.key) || 0);
  });
}

function channelTooltip(channel, latest) {
  const parts = [channel.label || channel.key];
  if (channel.description) parts.push(channel.description);
  if (latest) {
    const source = displaySource(latest.source);
    const body = String(latest.summary || latest.raw || latest.title || "").replace(/\s+/g, " ").trim();
    parts.push(`${formatChatTime(latest.time) || ""} ${source}: ${clipGraphemes(body, 90)}`.trim());
  }
  return parts.filter(Boolean).join("\n");
}

function latestMessagesByChannel() {
  const candidates = state.channelSummaryMessages.length ? state.channelSummaryMessages : state.messages;
  const latest = new Map();
  for (const message of candidates) {
    const keys = message.channels && message.channels.length ? message.channels : [message.channel];
    for (const key of keys) {
      if (key && !latest.has(key)) {
        latest.set(key, message);
      }
    }
  }
  return latest;
}

function latestMessageForChannel(channelKey) {
  return latestMessagesByChannel().get(channelKey) || null;
}

function channelPreviewText(message, channel) {
  if (!message) {
    return channel.description || "等待消息";
  }
  const source = displaySource(message.source);
  const body = String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim();
  const limit = 56;
  const preview = clipGraphemes(body || "（空消息）", limit);
  return `${source}: ${preview}${countGraphemes(body) > limit ? "…" : ""}`;
}

function channelIcon(key, label) {
  const icons = {
    focus: "重",
    mine: "我",
    leader: "会",
    risk: "险",
    dungeon: "副",
    resource: "资",
    archive: "档",
    console: "台",
    training: "修",
    home: "府",
    world: "聊",
    system: "系",
  };
  return icons[key] || firstGrapheme(label || key || "?");
}

// 频道筛选:主界面展示的是“视图”,不是后端频道枚举。
// 低频的 archive/system/console/world 不直接露在主栏,需要时走“全部/记录”。
const QUICK_FILTER_PRESETS = [
  { key: "focus", label: "重点", icon: "!", channels: ["focus"], title: "需要优先处理的消息" },
  { key: "dungeon", label: "副本", icon: "#", channels: ["dungeon"], title: "副本开启、加入和队伍状态" },
  { key: "leader", label: "会长", icon: "◇", channels: ["leader"], title: "会长/情报源消息" },
  { key: "mine", label: "我的", icon: "@", channels: ["mine"], title: "当前角色相关消息" },
  { key: "__daily", label: "日常", icon: "↻", channels: ["training", "resource", "home"], title: "修炼、资源、洞府和日常玩法" },
  { key: "risk", label: "风险", icon: "!", channels: ["risk"], title: "举报、自证、禁言、虚弱和封禁", className: "risk", showWhenCount: true },
  { key: "__all", label: "全部", icon: "≡", channels: "__all", title: "显示全部频道", className: "all" },
];

function quickFilterIsAll() {
  return state.selectedChannels.size === state.channels.length;
}

function quickFilterActiveKey() {
  if (quickFilterIsAll()) return "__all";
  const selected = [...state.selectedChannels].sort();
  for (const preset of QUICK_FILTER_PRESETS) {
    if (!Array.isArray(preset.channels)) continue;
    const keys = quickFilterKnownChannels(preset).sort();
    if (keys.length && keys.length === selected.length && keys.every((key, index) => key === selected[index])) {
      return preset.key;
    }
  }
  return "";  // 自定义多选状态,啥都不亮
}

function renderQuickFilters() {
  const container = document.querySelector("#quickFilters");
  if (!container || !state.channels.length) return;
  const activeKey = quickFilterActiveKey();
  const counts = channelMessageCounts();
  const presets = QUICK_FILTER_PRESETS
    .map((preset) => {
      const channels = quickFilterKnownChannels(preset);
      return {
        ...preset,
        channels,
        count: quickFilterCount(preset, counts),
      };
    })
    .filter((preset) => {
      if (preset.key === "__all") return true;
      if (!preset.channels.length) return false;
      if (preset.showWhenCount) return preset.count > 0 || activeKey === preset.key;
      return true;
    });
  container.innerHTML = presets
    .map((p) => {
      const isActive = activeKey === p.key;
      const cls = [
        "quick-filter-chip",
        p.key === "__all" ? "all" : "",
        p.className || "",
        isActive ? "active" : "",
      ].filter(Boolean).join(" ");
      return `
        <button type="button" class="${cls}"
                data-quick-filter="${escapeAttr(p.key)}"
                title="${escapeAttr(p.title || p.label)}">
          <span class="quick-filter-icon" aria-hidden="true">${escapeHtml(p.icon)}</span>
          <span class="quick-filter-label">${escapeHtml(p.label)}</span>
          ${p.count ? `<span class="quick-filter-count">${escapeHtml(formatNumber(p.count))}</span>` : ""}
        </button>
      `;
    })
    .join("");
  container.querySelectorAll("[data-quick-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest("details")?.removeAttribute("open");
      applyQuickFilter(btn.dataset.quickFilter);
    });
  });
}

async function applyQuickFilter(key) {
  const preset = QUICK_FILTER_PRESETS.find((item) => item.key === key);
  let nextChannels;
  if (!preset || preset.channels === "__all") {
    nextChannels = state.channels.map((c) => c.key);
  } else if (activeQuickFilterKeyForSelection() === key) {
    nextChannels = ["focus"];
  } else {
    nextChannels = quickFilterKnownChannels(preset);
  }
  await applyChannelSelection(nextChannels);
}

function activeQuickFilterKeyForSelection() {
  return quickFilterActiveKey();
}

function quickFilterKnownChannels(preset) {
  if (!preset || preset.channels === "__all") {
    return state.channels.map((channel) => channel.key);
  }
  const known = new Set(state.channels.map((channel) => channel.key));
  return (preset.channels || []).filter((key) => known.has(key));
}

function quickFilterCount(preset, counts) {
  if (!preset || preset.key === "__all") return 0;
  return quickFilterKnownChannels(preset)
    .reduce((total, key) => total + Number(counts.get(key) || 0), 0);
}

function channelMessageCounts() {
  const counts = new Map();
  for (const channel of state.channels) {
    counts.set(channel.key, 0);
  }
  const sourceMessages = summarySignalMessages();
  for (const message of sourceMessages) {
    const keys = message.channels && message.channels.length ? message.channels : [message.channel];
    for (const key of keys) {
      if (counts.has(key)) {
        counts.set(key, counts.get(key) + 1);
      }
    }
  }
  return counts;
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
  const buttons = EMOJI_PALETTE.map((emoji) => `
    <button type="button" class="emoji-palette-button" data-emoji="${escapeAttr(emoji)}" title="插入 ${escapeAttr(emoji)}">${escapeHtml(emoji)}</button>
  `).join("");
  return `
    <div class="emoji-palette-buttons">${buttons}</div>
    <span class="emoji-palette-hint">系统表情: Windows 用 Win+.，macOS 用 Ctrl+Cmd+Space</span>
  `;
}

function bindEmojiPalette(container, getTextarea) {
  if (!container) return;
  container.innerHTML = emojiPaletteHtml();
  container.querySelectorAll("[data-emoji]").forEach((button) => {
    button.addEventListener("click", () => {
      const textarea = getTextarea ? getTextarea() : null;
      if (!textarea) return;
      insertTextAtCursor(textarea, button.dataset.emoji || "");
    });
  });
}

function insertTextAtCursor(textarea, text) {
  if (!textarea || !text) return;
  const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
  const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = `${before}${text}${after}`;
  const next = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(next, next);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderActiveChannelText() {
  let text = "";
  if (state.selectedChannels.size === 0) {
    text = "未选择频道";
  } else if (state.selectedChannels.size === state.channels.length) {
    text = "全部频道";
  } else {
    const labels = state.channels
      .filter((channel) => state.selectedChannels.has(channel.key))
      .map((channel) => channel.label);
    text = labels.join(" / ");
  }
  const query = String(state.messageSearch || "").trim();
  if (query) {
    text = `${text}｜搜索「${query}」`;
  }
  if (activeChannelText) activeChannelText.textContent = text;
  if (streamActiveChannelText) streamActiveChannelText.textContent = text;
}

function renderMessages() {
  const messages = visibleMessages();
  const collectorStatus = collectorLiveStatus();
  const searchSuffix = state.messageSearch ? "｜搜索中" : "";
  messageCount.textContent = `${messages.length} 条${searchSuffix}${collectorStatus ? `｜${collectorStatus}` : ""}`;
  renderActiveChannelText();
  renderLiveSituationBoard();
  renderWorldEventStrip();
  renderGameActionDock();

  if (messages.length === 0) {
    messageList.innerHTML = `<div class="chat-empty">${escapeHtml(emptyMessageHint())}</div>`;
    if (jumpToLatestButton) {
      jumpToLatestButton.hidden = true;
    }
    return;
  }

  // 聊天客户端顺序:旧消息在上,最新消息在底部发送栏上方。
  // 重建 DOM 时锚住当前可见消息;只有用户本来就在最新位置时才自动贴底。
  const scrollSnapshot = captureMessageScrollSnapshot();

  const groups = groupMessagesByDate([...messages].reverse());
  const fragment = document.createDocumentFragment();
  groups.forEach((group) => {
    const divider = document.createElement("div");
    divider.className = "chat-day-divider";
    divider.innerHTML = `<span>${escapeHtml(group.label)}</span>`;
    fragment.appendChild(divider);
    group.items.forEach((message) => {
      fragment.appendChild(renderChatMessageNode(message));
    });
  });
  messageList.replaceChildren(fragment);

  restoreMessageScrollSnapshot(scrollSnapshot);
}

function isMessageListNearLatest(threshold = 120) {
  if (!messageList) return true;
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= threshold;
}

function updateJumpToLatestVisibility() {
  if (!jumpToLatestButton || !messageList) return;
  jumpToLatestButton.hidden = isMessageListNearLatest();
}

function scrollMessageListToLatest({ behavior = "auto" } = {}) {
  if (!messageList) return;
  messageList.scrollTo({ top: messageList.scrollHeight, behavior });
  updateJumpToLatestVisibility();
}

function captureMessageScrollSnapshot() {
  if (!messageList) return { nearLatest: true };
  if (messageList.scrollHeight === 0 || isMessageListNearLatest(96)) {
    return { nearLatest: true };
  }

  const listRect = messageList.getBoundingClientRect();
  const topGuard = listRect.top + 1;
  const nodes = messageList.querySelectorAll("[data-message-id]");
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom >= topGuard) {
      return {
        nearLatest: false,
        anchorId: node.dataset.messageId || "",
        anchorOffset: rect.top - listRect.top,
        scrollTop: messageList.scrollTop,
      };
    }
  }
  return { nearLatest: false, scrollTop: messageList.scrollTop };
}

function restoreMessageScrollSnapshot(snapshot) {
  if (!messageList || !snapshot) return;
  if (snapshot.nearLatest) {
    scrollMessageListToLatest();
    return;
  }
  if (snapshot.anchorId) {
    const node = messageList.querySelector(`[data-message-id="${CSS.escape(snapshot.anchorId)}"]`);
    if (node) {
      const listRect = messageList.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      messageList.scrollTop += rect.top - listRect.top - snapshot.anchorOffset;
      updateJumpToLatestVisibility();
      return;
    }
  }
  messageList.scrollTop = Math.max(0, snapshot.scrollTop || 0);
  updateJumpToLatestVisibility();
}

function renderLiveSituationBoard() {
  if (!liveSituationBoard) return;
  const model = liveSituationModel();
  liveSituationBoard.innerHTML = `
    ${model.dungeonHero ? renderLiveDungeonHero(model.dungeonHero) : renderLiveMessageHero(model.primary)}
    <div class="live-situation-grid">
      ${model.dungeonSummary ? renderLiveDungeonSummaryTile(model.dungeonSummary) : renderLiveSituationTile("dungeon", "当前副本", model.dungeon, "暂无副本线索", "dungeon")}
      ${renderLiveSituationTile("risk", "风险 / 我的", model.mine, "暂无风险或 @ 我", "mine")}
      ${model.resourceSummary ? renderLiveResourceSummaryTile(model.resourceSummary) : renderLiveSituationTile("resource", "近期收益", model.resource, "暂无收益记录", "resource")}
      ${renderLiveCooldownTile(model.module)}
    </div>
  `;
  bindLiveSituationBoard();
}

function liveSituationModel() {
  const source = summarySignalMessages();
  const sorted = [...source]
    .filter((message) => message?.id)
    .sort(compareRankThenRecency(worldEventRank));
  const withAction = sorted.find((message) => (message.actions || []).some((item) => String(item.command || "").trim())) || null;
  const withActionChannels = withAction ? (withAction.channels || [withAction.channel]) : [];
  const mine = sorted.find((message) => {
    return isPersonalSignal(message);
  }) || null;
  const dungeon = sorted.find((message) => (message.channels || [message.channel]).includes("dungeon")) || null;
  const resource = sorted.find((message) => {
    const channels = message.channels || [message.channel];
    return channels.includes("resource") || channels.includes("training") || channels.includes("home");
  }) || null;
  const dungeonSummary = actionableDungeonSnapshot() || currentDungeonSnapshot();
  const dungeonIsLive = dungeonSummary && ["open", "choice", "active", "joined"].includes(dungeonSummary.statusKind);
  const dungeonHero = dungeonIsLive && !mine && (!withAction || withActionChannels.includes("dungeon"))
    ? dungeonSummary
    : null;
  const module = overviewModuleRows(Number(state.activeIdentityId || 0) || null)[0] || null;
  return {
    primary: mine || withAction || dungeon || resource || latestLeaderSnapshotMessage() || sorted[0] || null,
    dungeonSummary,
    dungeonHero,
    mine,
    dungeon,
    resource,
    resourceSummary: liveResourceSnapshot(),
    module,
  };
}

function renderLiveMessageHero(primary) {
  const primaryAction = (primary?.actions || []).find((item) => String(item.command || "").trim());
  const primaryPreview = primary
    ? liveMessagePreview(primary, 110)
    : "监听运行后，这里会汇总最新风险、副本、收益和关键回复。";
  const primaryMeta = primary
    ? `${formatChatTime(primary.time) || "最近"}｜${displaySource(primary.source)}`
    : collectorLiveStatus() || "等待消息箱";
  return `
    <article class="live-situation-hero ${primary ? escapeAttr(liveMessageKind(primary)) : "empty"}">
      <div class="live-situation-title">
        <span>当前态势</span>
        <strong>${escapeHtml(primary?.title || "等待游戏事件")}</strong>
        <small>${escapeHtml(primaryMeta)}</small>
      </div>
      <p>${escapeHtml(primaryPreview)}</p>
      <div class="live-situation-actions">
        ${primary ? `<button type="button" data-live-message="${escapeAttr(primary.id || "")}">查看原文</button>` : ""}
        ${primaryAction ? `<button type="button" data-live-action="${escapeAttr(primary.id || "")}">填入 ${escapeHtml(quickActionLabel(primaryAction))}</button>` : ""}
        <button type="button" data-live-panel="overview">打开概览</button>
      </div>
    </article>
  `;
}

function renderLiveDungeonHero(summary) {
  const title = dungeonSummaryDisplayLabel(summary);
  const advice = [summary.advice, summary.routeVerdict, summary.teamFit].filter(Boolean).join("｜");
  const primaryActions = visibleDungeonActions(summary).slice(0, 3);
  return `
    <article class="live-situation-hero dungeon-live ${escapeAttr(summary.statusKind || "")}">
      <div class="live-situation-title">
        <span>当前副本</span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(formatChatTime(summary.latestMessage?.time) || summary.latestMessage?.time || "最近")}</small>
      </div>
      <p>${escapeHtml(advice || summary.status || summary.latestStage || "副本线索已汇总，点击面板看原文和时间线。")}</p>
      <div class="live-situation-metrics">
        <span><b>阶段</b>${escapeHtml(summary.latestStage || "未读")}</span>
        <span><b>状态</b>${escapeHtml(summary.status || "副本")}</span>
        <span><b>人数</b>${escapeHtml(summary.capacity || (summary.joinSuccess.length ? `${summary.joinSuccess.length} 人` : "未读"))}</span>
      </div>
      <div class="live-situation-actions">
        ${primaryActions.map((action, index) => `
          <button type="button" data-live-dungeon-action="${index}" title="${escapeAttr(action.command || "")}">
            填入 ${escapeHtml(action.label || action.command || "动作")}
          </button>
        `).join("")}
        <button type="button" data-live-panel="dungeon">副本面板</button>
      </div>
    </article>
  `;
}

function currentDungeonSnapshot() {
  const summaries = ((state.worldSnapshot?.dungeon || {}).summaries || []).map(normalizeDungeonStatusSummary);
  return pickCurrentDungeonSummary(summaries);
}

function latestLeaderSnapshotMessage() {
  return ((state.worldSnapshot?.leader || {}).messages || [])[0] || null;
}

function snapshotPriorityMessages() {
  return ((state.worldSnapshot?.priority || {}).messages || []).filter((message) => {
    if (!message?.id) return false;
    if (isArchivedOnlySignal(message)) return false;
    const channels = message.channels || [message.channel];
    return channels.includes("risk") || channels.includes("focus") || (message.tags || []).includes("被@") || (message.tags || []).includes("回复我");
  });
}

function isArchivedOnlySignal(message) {
  const channels = message?.channels || [message?.channel];
  if (!channels.includes("archive")) return false;
  if (message?.severity === "risk" || channels.includes("risk")) return false;
  const tags = message?.tags || [];
  if (tags.includes("被@") || tags.includes("回复我") || tags.includes("我发出")) return false;
  return true;
}

function isPersonalSignal(message) {
  const channels = message?.channels || [message?.channel];
  const tags = message?.tags || [];
  if (message?.severity === "risk" || channels.includes("risk")) return true;
  if (tags.includes("被@") || tags.includes("回复我") || tags.includes("我发出")) return true;
  return channels.includes("mine") && !isArchivedOnlySignal(message);
}

function summarySignalMessages() {
  const base = state.channelSummaryMessages.length ? state.channelSummaryMessages : state.messages;
  const byId = new Map();
  for (const message of [...snapshotPriorityMessages(), ...base]) {
    if (!message?.id || byId.has(message.id)) continue;
    if (isArchivedOnlySignal(message)) continue;
    byId.set(message.id, message);
  }
  return Array.from(byId.values());
}

function liveResourceSnapshot() {
  const payload = state.worldSnapshot?.resource || null;
  if (!payload) return null;
  const rows = payload.rows || [];
  const eventSummary = payload.event_summary || [];
  const latestPeriod = latestResourcePeriod(rows, eventSummary);
  const periodEvents = filterResourceRowsByPeriod(eventSummary, latestPeriod);
  const periodRows = filterResourceRowsByPeriod(rows, latestPeriod);
  const wild = {
    success: 0,
    failed: 0,
    cooldown: 0,
  };
  for (const row of periodEvents) {
    if (row.source_type !== "wild_training") continue;
    wild.success += Number(row.success || 0) + Number(row.extra_success || 0);
    wild.failed += Number(row.failed || 0) + Number(row.basic_only || 0);
    wild.cooldown += Number(row.cooldown || 0);
  }
  const rareRows = aggregateRareResourceRows(periodRows)
    .filter((row) => row.total_amount > 0)
    .sort((a, b) => (
      Number(!isYinNingResource(a.resource_name)) - Number(!isYinNingResource(b.resource_name))
      || Number(a.total_amount || 0) - Number(b.total_amount || 0)
      || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
    ))
    .slice(0, 3);
  return {
    latestPeriod,
    eventCount: periodEvents.reduce((sum, row) => sum + Number(row.total || row.event_count || 0), 0),
    wild,
    rareRows,
  };
}

function renderLiveSituationTile(kind, label, message, emptyText, panel) {
  const meta = message ? `${formatChatTime(message.time) || "最近"}｜${displaySource(message.source)}` : "等待消息箱";
  const preview = message ? liveMessagePreview(message, 58) : emptyText;
  const fields = message?.fields || {};
  const dungeonId = fields["副本ID"] ? `#${fields["副本ID"]}` : "";
  const badge = kind === "dungeon" && dungeonId ? dungeonId : (message ? liveMessageKindLabel(message) : "空");
  return `
    <article class="live-situation-tile ${escapeAttr(kind)} ${message ? "" : "empty"}">
      <button type="button" ${message ? `data-live-message="${escapeAttr(message.id || "")}"` : `data-live-panel="${escapeAttr(panel)}"`}>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(message?.title || emptyText)}</strong>
        <small>${escapeHtml(meta)}</small>
        <em>${escapeHtml(preview)}</em>
      </button>
      <button type="button" class="live-situation-badge" data-live-panel="${escapeAttr(panel)}">${escapeHtml(badge)}</button>
    </article>
  `;
}

function renderLiveDungeonSummaryTile(summary) {
  const title = `${summary.dungeonName || "副本"}${summary.dungeonId ? ` #${summary.dungeonId}` : ""}`;
  const preview = [summary.advice, summary.routeVerdict, summary.latestStage, summary.openedBy].filter(Boolean).join("｜");
  return `
    <article class="live-situation-tile dungeon ${escapeAttr(summary.statusKind || "")}">
      <button type="button" data-live-panel="dungeon">
        <span>当前副本</span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(formatChatTime(summary.latestMessage?.time) || "最近")}｜${escapeHtml(summary.status || "副本")}</small>
        <em>${escapeHtml(preview || "副本状态已从消息箱汇总。")}</em>
      </button>
      <button type="button" class="live-situation-badge" data-live-panel="dungeon">${escapeHtml(summary.status || "副本")}</button>
    </article>
  `;
}

function renderLiveResourceSummaryTile(summary) {
  const attempts = summary.wild.success + summary.wild.failed;
  const rate = attempts ? `${Math.round((summary.wild.success * 100) / attempts)}%` : "暂无";
  const rareText = summary.rareRows.length
    ? summary.rareRows.map((row) => `${row.resource_name}${formatResourceAmount(row.total_amount, row.unit)}`).join(" / ")
    : "暂无稀有产物";
  return `
    <article class="live-situation-tile resource">
      <button type="button" data-live-panel="resource">
        <span>今日收益</span>
        <strong>野外成功率 ${escapeHtml(rate)}</strong>
        <small>${escapeHtml(summary.latestPeriod || "本期")}｜事件 ${escapeHtml(formatNumber(summary.eventCount))}</small>
        <em>${escapeHtml(rareText)}</em>
      </button>
      <button type="button" class="live-situation-badge" data-live-panel="resource">统计</button>
    </article>
  `;
}

function renderLiveCooldownTile(moduleRow) {
  if (!moduleRow) {
    return `
      <article class="live-situation-tile cooldown empty">
        <button type="button" data-live-panel="status">
          <span>关键冷却</span>
          <strong>暂无角色 CD</strong>
          <small>先选择身份</small>
          <em>发送或监听状态消息后会补全。</em>
        </button>
        <button type="button" class="live-situation-badge" data-live-panel="status">状态</button>
      </article>
    `;
  }
  return `
    <article class="live-situation-tile cooldown ${escapeAttr(moduleRow.view.cls)}">
      <button type="button" data-live-panel="status">
        <span>关键冷却</span>
        <strong>${escapeHtml(moduleRow.view.label)}</strong>
        <small>${escapeHtml(moduleRow.view.status)}｜${escapeHtml(moduleRow.view.time)}</small>
        <em>点开角色状态可看完整 CD 和资料来源。</em>
      </button>
      <button type="button" class="live-situation-badge" data-live-panel="status">${escapeHtml(moduleRow.view.icon)}</button>
    </article>
  `;
}

function bindLiveSituationBoard() {
  liveSituationBoard.querySelectorAll("[data-live-message]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.liveMessage || "";
      const message = id ? await findOrFetchMessage(id) : null;
      if (message) jumpToMessage(message);
    });
  });
  liveSituationBoard.querySelectorAll("[data-live-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.liveAction || "";
      const message = id ? await findOrFetchMessage(id) : null;
      const action = (message?.actions || []).find((item) => String(item.command || "").trim());
      if (!message || !action) return;
      fillDirectSendComposer(action.command, {
        identityId: action.identity_id,
        replyContext: directReplyContextFromAction(action, message),
        statusText: "已填入当前态势候选动作，请确认后发送。",
        statusKind: "info",
      });
      jumpToMessage(message);
    });
  });
  liveSituationBoard.querySelectorAll("[data-live-panel]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const panel = button.dataset.livePanel || "";
      if (panel === "overview") {
        openOverviewDetailPanel();
        return;
      }
      await openGameScenePanel(panel);
    });
  });
  liveSituationBoard.querySelectorAll("[data-live-dungeon-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const summary = liveSituationModel().dungeonSummary;
      const action = visibleDungeonActions(summary)[Number(button.dataset.liveDungeonAction || 0)];
      if (!action?.command) return;
      fillDirectSendComposer(action.command, {
        replyContext: directReplyContextFromAction(action),
        statusText: "已填入副本动作，请看原文后手动发送。",
        statusKind: "info",
      });
      const sourceId = action.source_message_id || summary?.latestMessage?.id || "";
      const message = sourceId ? await findOrFetchMessage(sourceId) : null;
      if (message) jumpToMessage(message);
    });
  });
}

function liveMessagePreview(message, limit) {
  return clipGraphemes(String(message?.summary || message?.raw || message?.title || "").replace(/\s+/g, " ").trim(), limit);
}

function liveMessageKind(message) {
  const meta = worldEventMeta(message);
  return meta.kind || "focus";
}

function liveMessageKindLabel(message) {
  const meta = worldEventMeta(message);
  return meta.label || "消息";
}

function renderWorldEventStrip() {
  if (!worldEventStrip) return;
  const slots = worldEventSlots();
  worldEventStrip.innerHTML = slots.map(({ def, message, count, snapshot }) => {
    const firstAction =
      snapshot?.action ||
      (message?.actions || []).find((item) => String(item.command || "").trim());
    const preview = clipGraphemes(
      String(snapshot?.preview || message?.summary || message?.raw || message?.title || def.emptyText || "").replace(/\s+/g, " ").trim(),
      78
    );
    const title = snapshot?.title || message?.title || def.emptyTitle;
    const subline = snapshot?.subline || (
      message
        ? `${formatChatTime(message.time) || ""}｜${displaySource(message.source)}`
        : def.emptySubline
    );
    const mainAttrs = message?.id
      ? `data-world-event-id="${escapeAttr(message.id || "")}"`
      : snapshot?.panel
        ? `data-world-event-panel="${escapeAttr(snapshot.panel)}"`
        : `data-world-event-channel="${escapeAttr(def.channel || "focus")}"`;
    return `
      <article class="world-event-card ${escapeAttr(def.kind)} ${message || snapshot ? "" : "empty"}"
               title="${escapeAttr(preview || title || "消息")}">
        <button type="button" class="world-event-main"
                ${mainAttrs}>
          <span class="world-event-kind">${escapeHtml(def.label)}</span>
          <strong>${escapeHtml(title || def.label)}</strong>
          <small>${escapeHtml(subline || "")}${count ? `｜${escapeHtml(formatNumber(count))} 条` : ""}</small>
          <em>${escapeHtml(preview || "暂无消息")}</em>
        </button>
        ${firstAction ? `
          <button type="button" class="world-event-action"
                  ${snapshot?.action ? `data-world-event-snapshot-action="${escapeAttr(def.key)}"` : `data-world-event-action="${escapeAttr(message.id || "")}"`}
                  title="${escapeAttr(String(firstAction.command || ""))}">
            填入
          </button>
        ` : ""}
      </article>
    `;
  }).join("");
  worldEventStrip.querySelectorAll("[data-world-event-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.worldEventId || "";
      if (!id) return;
      const message = await findOrFetchMessage(id);
      if (message) jumpToMessage(message);
    });
  });
  worldEventStrip.querySelectorAll("[data-world-event-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = button.dataset.worldEventAction || "";
      if (!id) return;
      const message = await findOrFetchMessage(id);
      const action = (message?.actions || []).find((item) => String(item.command || "").trim());
      if (!message || !action) return;
      fillDirectSendComposer(action.command, {
        identityId: action.identity_id,
        replyContext: directReplyContextFromAction(action, message),
        statusText: "已填入世界事件候选动作，请确认后发送。",
        statusKind: "info",
      });
      jumpToMessage(message);
    });
  });
  worldEventStrip.querySelectorAll("[data-world-event-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const channel = button.dataset.worldEventChannel || "focus";
      applyChannelSelection([channel]).catch((error) => showSkillToast(`频道加载失败: ${error.message || error}`, "err"));
    });
  });
  worldEventStrip.querySelectorAll("[data-world-event-panel]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openGameScenePanel(button.dataset.worldEventPanel || "");
    });
  });
  worldEventStrip.querySelectorAll("[data-world-event-snapshot-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const key = button.dataset.worldEventSnapshotAction || "";
      const snapshot = worldEventSlotSnapshot({ key }) || {};
      const action = snapshot.action || null;
      if (!action?.command) return;
      fillDirectSendComposer(action.command, {
        identityId: action.identity_id,
        replyContext: directReplyContextFromAction(action),
        statusText: "已填入事件带候选动作，请确认后发送。",
        statusKind: "info",
      });
      const message = action.source_message_id ? await findOrFetchMessage(action.source_message_id) : null;
      if (message) jumpToMessage(message);
    });
  });
}

function renderGameSceneBoard() {
  if (!gameSceneBoard) return;
  const scenes = gameSceneSummaries();
  gameSceneBoard.innerHTML = scenes.map((scene) => `
    <article class="game-scene-card ${escapeAttr(scene.kind)} ${scene.message ? "" : "empty"}">
      <button type="button" class="game-scene-main" data-scene-channel="${escapeAttr(scene.channel)}">
        <span class="game-scene-icon">${escapeHtml(scene.icon)}</span>
        <span class="game-scene-title">
          <strong>${escapeHtml(scene.title)}</strong>
          <small>${escapeHtml(scene.subtitle)}</small>
        </span>
        <span class="game-scene-count">${escapeHtml(formatNumber(scene.count))}</span>
        <em>${escapeHtml(scene.preview)}</em>
        ${scene.badges && scene.badges.length ? `
          <span class="game-scene-badges">
            ${scene.badges.map((badge) => `
              <span class="${escapeAttr(badge.kind || "")}">
                <b>${escapeHtml(badge.label)}</b>${escapeHtml(String(badge.value))}
              </span>
            `).join("")}
          </span>
        ` : ""}
      </button>
      ${scene.skillActions && scene.skillActions.length ? `
        <div class="game-scene-skill-actions">
          ${scene.skillActions.map((action) => `
            <button type="button" class="${escapeAttr(action.cls)}"
                    ${action.disabled ? "disabled" : ""}
                    data-scene-skill="${escapeAttr(action.key)}"
                    title="${escapeAttr(action.title)}">
              ${action.icon ? `<span>${escapeHtml(action.icon)}</span>` : ""}
              <strong>${escapeHtml(action.label)}</strong>
              ${action.meta ? `<small>${escapeHtml(action.meta)}</small>` : ""}
            </button>
          `).join("")}
        </div>
      ` : ""}
      ${scene.commandActions && scene.commandActions.length ? `
        <div class="game-scene-skill-actions game-scene-command-actions">
          ${scene.commandActions.map((action, index) => `
            <button type="button" class="${escapeAttr(action.cls || "")}"
                    data-scene-command-action="${index}"
                    title="${escapeAttr(action.command || "")}">
              <span>${escapeHtml(action.icon || "令")}</span>
              <strong>${escapeHtml(action.label || action.command || "动作")}</strong>
              ${action.meta ? `<small>${escapeHtml(action.meta)}</small>` : ""}
            </button>
          `).join("")}
        </div>
      ` : ""}
      <div class="game-scene-actions">
        ${scene.actions.map((action) => `
          <button type="button" data-scene-panel="${escapeAttr(action.panel)}">${escapeHtml(action.label)}</button>
        `).join("")}
      </div>
    </article>
  `).join("");
  gameSceneBoard.querySelectorAll("[data-scene-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const channel = button.dataset.sceneChannel || "focus";
      applyChannelSelection([channel]).catch((error) => showSkillToast(`频道加载失败: ${error.message || error}`, "err"));
    });
  });
  gameSceneBoard.querySelectorAll("[data-scene-panel]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await openGameScenePanel(button.dataset.scenePanel || "");
    });
  });
  gameSceneBoard.querySelectorAll("[data-scene-skill]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      fillSkillIntoComposer(button.dataset.sceneSkill || "", button);
    });
  });
  gameSceneBoard.querySelectorAll("[data-scene-command-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const action = gameSceneCommandActions({ key: "dungeon" })[Number(button.dataset.sceneCommandAction || 0)];
      if (!action?.command || !action.rawAction) return;
      const sourceId = action.rawAction.source_message_id || "";
      const sourceMessage = sourceId ? await findOrFetchMessage(sourceId) : null;
      fillDirectSendComposer(action.command, {
        replyContext: directReplyContextFromAction(action.rawAction, sourceMessage),
        statusText: "已填入副本动作，请确认原文后发送。",
        statusKind: "info",
      });
      if (sourceMessage) jumpToMessage(sourceMessage);
    });
  });
}

function gameSceneDefs() {
  return [
    {
      key: "home",
      kind: "home",
      icon: "府",
      title: "洞府",
      channel: "home",
      channels: ["home", "mine"],
      fallback: "洞府、角色回复和个人状态会汇入这里。",
      modules: ["pet_touch", "pet_warm", "pet_trial", "concubine_dream", "concubine_tianji", "concubine_heart"],
      actionSkills: ["concubine_status", "pet_touch", "pet_warm", "pet_trial", "concubine_dream", "concubine_tianji"],
      actions: [
        { label: "状态", panel: "status" },
        { label: "我的", panel: "mine" },
      ],
    },
    {
      key: "training",
      kind: "training",
      icon: "野",
      title: "历练",
      channel: "training",
      channels: ["training", "resource"],
      fallback: "野外历练、奇遇和资源结算会汇入这里。",
      modules: ["wild_training", "checkin", "tower", "deep_retreat", "retreat_shallow", "yuanying", "second_soul", "ranch"],
      actionSkills: ["wild_training", "deep_retreat", "tower", "checkin", "yuanying", "second_soul_train", "retreat_shallow", "ranch"],
      actions: [
        { label: "资源", panel: "resource" },
        { label: "记录", panel: "training" },
      ],
    },
    {
      key: "dungeon",
      kind: "dungeon",
      icon: "副",
      title: "副本",
      channel: "dungeon",
      channels: ["dungeon"],
      fallback: "副本开房、加入、卦象和推进会汇入这里。",
      modules: [],
      actionSkills: [],
      actions: [
        { label: "状态", panel: "dungeon" },
        { label: "攻略", panel: "guide" },
      ],
    },
    {
      key: "intel",
      kind: "leader",
      icon: "天",
      title: "天机",
      channel: "leader",
      channels: ["leader", "focus", "risk"],
      fallback: "会长、重点、风险和新玩法线索会汇入这里。",
      modules: ["stargazer_guide", "stargazer_soothe", "stargazer_collect", "tianti_climb", "tianti_wenxin", "tianti_gangfeng", "taiyi_cycle"],
      actionSkills: ["tianti_status", "tianti_climb", "tianti_wenxin", "tianti_gangfeng", "stargazer_panel", "stargazer_guide", "stargazer_soothe", "taiyi", "yindao", "node_search"],
      actions: [
        { label: "情报", panel: "intel" },
        { label: "健康", panel: "health" },
      ],
    },
  ];
}

function gameSceneSummaries() {
  const source = summarySignalMessages();
  return gameSceneDefs().map((def) => {
    const messages = source
      .filter((message) => gameSceneMatch(def, message))
      .sort(compareMessagesByRecency);
    const message = messages[0] || null;
    const snapshot = gameSceneSnapshot(def);
    if (snapshot) {
      return {
        ...def,
        ...snapshot,
        badges: snapshot.badges || gameSceneModuleBadges(def),
        skillActions: gameSceneSkillActions(def),
        commandActions: gameSceneCommandActions(def),
        count: Number(snapshot.count ?? messages.length ?? 0),
        message: snapshot.message || message || { id: "" },
      };
    }
    const subtitle = message
      ? `${formatChatTime(message.time) || "最近"}｜${displaySource(message.source)}`
      : "等待消息箱";
    const preview = message
      ? clipGraphemes(String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim(), 86)
      : def.fallback;
    return {
      ...def,
      count: messages.length,
      message,
      subtitle,
      preview: preview || def.fallback,
      badges: gameSceneModuleBadges(def),
      skillActions: gameSceneSkillActions(def),
      commandActions: gameSceneCommandActions(def),
    };
  });
}

function gameSceneSnapshot(def) {
  if (def.key === "home") {
    const identity = identityById(state.activeIdentityId);
    const patches = activeIdentityPatches();
    const patchMap = new Map(patches.map((item) => [item.key, item.value]));
    if (!identity && !patches.length) return null;
    const realm = patchMap.get("境界") || patchMap.get("灵根") || "角色资料";
    const sourceRows = identityProfileSourceRows(patches);
    return {
      subtitle: identity ? `${identity.label || identity.username || identity.send_as_id}` : "当前身份",
      preview: `${realm}｜资料来源 ${sourceRows.length || 0} 项`,
      count: sourceRows.length,
      badges: gameSceneModuleBadges(def),
      message: sourceRows.find((row) => row.sourceMessageId) ? { id: sourceRows.find((row) => row.sourceMessageId).sourceMessageId } : null,
    };
  }
  if (def.key === "training") {
    const resource = liveResourceSnapshot();
    if (!resource) return null;
    const attempts = resource.wild.success + resource.wild.failed;
    const rate = attempts ? `${Math.round((resource.wild.success * 100) / attempts)}%` : "暂无";
    const rare = resource.rareRows.length
      ? resource.rareRows.map((row) => `${row.resource_name}${formatResourceAmount(row.total_amount, row.unit)}`).join(" / ")
      : "暂无稀有";
    return {
      subtitle: `${resource.latestPeriod || "本期"}｜野外成功率 ${rate}`,
      preview: rare,
      count: resource.eventCount,
      badges: gameSceneModuleBadges(def, [{ label: "成功率", value: rate, kind: attempts ? "ok" : "muted" }]),
    };
  }
  if (def.key === "dungeon") {
    const summaries = ((state.worldSnapshot?.dungeon || {}).summaries || []).map(normalizeDungeonStatusSummary);
    const latestSummary = summaries[0] || null;
    const actionSummary = actionableDungeonSnapshot();
    const summary = actionSummary || pickCurrentDungeonSummary(summaries);
    if (!summary) return null;
    const title = dungeonSummaryDisplayLabel(summary);
    const latestDiffers = latestSummary && summary.key !== latestSummary.key;
    const actionCount = visibleDungeonActions(summary).length;
    const previewParts = [summary.advice, summary.routeVerdict, summary.latestStage, summary.openedBy].filter(Boolean);
    if (latestDiffers) {
      previewParts.unshift(`最新 ${dungeonSummaryDisplayLabel(latestSummary)} ${latestSummary.status || ""}`.trim());
    }
    return {
      title,
      subtitle: `${actionSummary ? "可操作" : (summary.status || "副本")}｜${formatChatTime(summary.latestMessage?.time) || "最近"}`,
      preview: previewParts.join("｜") || "副本状态已汇总。",
      count: Number((state.worldSnapshot?.dungeon || {}).total_summaries || summary.messageCount || 0),
      badges: [
        { label: "状态", value: summary.status || "副本", kind: ["open", "joined"].includes(summary.statusKind) ? "ok" : ["choice", "active"].includes(summary.statusKind) ? "warn" : "muted" },
        { label: "动作", value: actionCount, kind: actionCount ? "warn" : "muted" },
        latestDiffers ? { label: "最新", value: latestSummary.status || "线索", kind: "muted" } : null,
      ].filter(Boolean),
      message: summary.latestMessage || null,
    };
  }
  if (def.key === "intel") {
    const leaderMessages = ((state.worldSnapshot?.leader || {}).messages || []);
    if (!leaderMessages.length) return null;
    const first = leaderMessages[0];
    return {
      subtitle: `${formatChatTime(first.time) || "最近"}｜${displaySource(first.source)}`,
      preview: liveMessagePreview(first, 86) || "会长频道消息",
      count: leaderMessages.length,
      badges: gameSceneModuleBadges(def, [{ label: "情报", value: leaderMessages.length, kind: leaderMessages.length ? "ok" : "muted" }]),
      message: first,
    };
  }
  return null;
}

function gameSceneModuleBadges(def, extras = []) {
  const stats = gameSceneModuleStats(def?.modules || []);
  const badges = [];
  if (stats.total) {
    badges.push({ label: "就绪", value: stats.ready, kind: stats.ready ? "ok" : "muted" });
    if (stats.warn) badges.push({ label: "异常", value: stats.warn, kind: "warn" });
    if (stats.running) badges.push({ label: "进行", value: stats.running, kind: "running" });
    badges.push({ label: "冷却", value: stats.cooling, kind: stats.cooling ? "cooling" : "muted" });
  }
  return [...extras, ...badges].slice(0, 4);
}

function gameSceneModuleStats(keys) {
  const wanted = new Set((keys || []).filter(Boolean));
  if (!wanted.size) return { total: 0, ready: 0, warn: 0, running: 0, cooling: 0, unknown: 0 };
  const activeId = Number(state.activeIdentityId || 0) || null;
  if (!activeId) return { total: wanted.size, ready: 0, warn: 0, running: 0, cooling: 0, unknown: wanted.size };
  const rows = overviewModuleRows(activeId).filter((row) => wanted.has(row.spec.key));
  const stats = { total: wanted.size, ready: 0, warn: 0, running: 0, cooling: 0, unknown: 0 };
  for (const row of rows) {
    const cls = String(row.view?.cls || "unknown");
    if (cls === "ready") stats.ready += 1;
    else if (cls === "warn") stats.warn += 1;
    else if (cls === "running") stats.running += 1;
    else if (cls === "cooling") stats.cooling += 1;
    else stats.unknown += 1;
  }
  stats.unknown += Math.max(0, wanted.size - rows.length);
  return stats;
}

function gameSceneSkillActions(def) {
  const keys = Array.isArray(def?.actionSkills) ? def.actionSkills : [];
  if (!keys.length) return [];
  const activeId = Number(state.activeIdentityId || 0) || null;
  const now = Date.now() / 1000;
  const modulesByKey = activeId
    ? new Map((state.identityModuleStates.get(activeId) || []).map((item) => [item.module_key, item]))
    : new Map();
  const seen = new Set();
  return keys
    .map((key) => skillByKey(key))
    .filter(Boolean)
    .filter((skill) => {
      if (seen.has(skill.key)) return false;
      seen.add(skill.key);
      return skill.reply_mode !== "required" && String(skill.command || "").trim() && skillIsUnlocked(skill);
    })
    .map((skill) => {
      const moduleState = skill.cd_module ? modulesByKey.get(skill.cd_module) : null;
      const cdUntil = moduleState
        ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
        : 0;
      const cooling = cdUntil > now;
      const busy = state.skillBarBusyKeys.has(skill.key);
      const disabled = !activeId || busy || cooling;
      return {
        key: skill.key,
        label: skill.label || skill.command || skill.key,
        icon: skill.icon || "",
        meta: cooling ? `剩 ${fmtCountdown(cdUntil - now)}` : busy ? "发送中" : "填入",
        cls: [cooling ? "cooling" : "ready", busy ? "busy" : ""].filter(Boolean).join(" "),
        disabled,
        order: (cooling ? 2 : 0) + (busy ? 1 : 0),
        title: skill.note || skill.command || skill.label || "",
      };
    })
    .sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label), "zh-Hans-CN"))
    .slice(0, 4);
}

function gameSceneCommandActions(def) {
  if (def?.key !== "dungeon") return [];
  const summary = actionableDungeonSnapshot();
  if (!summary) return [];
  const dungeonLabel = dungeonSummaryDisplayLabel(summary);
  return visibleDungeonActions(summary)
    .slice(0, 4)
    .map((action) => ({
      label: action.label || action.command || "动作",
      command: action.command || "",
      icon: "副",
      meta: dungeonLabel,
      cls: "dungeon",
      rawAction: action,
    }));
}

function dungeonSummaryDisplayLabel(summary) {
  if (!summary) return "副本";
  return `${summary.dungeonName || "副本"}${summary.dungeonId ? ` #${summary.dungeonId}` : ""}`;
}

function actionableDungeonSnapshot() {
  const summaries = ((state.worldSnapshot?.dungeon || {}).summaries || []).map(normalizeDungeonStatusSummary);
  return summaries
    .filter((summary) => ["choice", "open", "active", "joined"].includes(summary.statusKind))
    .filter((summary) => visibleDungeonActions(summary).length > 0)
    .sort(compareActionableDungeonSummary)[0] || null;
}

function gameSceneMatch(def, message) {
  if (!message) return false;
  const channels = message.channels || [message.channel];
  return def.channels.some((channel) => channels.includes(channel));
}

async function openGameScenePanel(panel) {
  try {
    if (panel === "status") {
      openIdentityStatusModal();
      return;
    }
    if (panel === "mine") {
      await applyChannelSelection(["mine"]);
      return;
    }
    if (panel === "resource") {
      await openResourceStatsModal();
      return;
    }
    if (panel === "training") {
      await applyChannelSelection(["training"]);
      return;
    }
    if (panel === "dungeon") {
      await openDungeonStatusModal();
      return;
    }
    if (panel === "guide") {
      await openXutianOracleGuideModal();
      return;
    }
    if (panel === "intel") {
      await openLeaderIntelModal();
      return;
    }
    if (panel === "health") {
      await openHealthModal();
    }
  } catch (error) {
    showError(error);
  }
}

function renderQuestTracker() {
  if (!questTracker) return;
  const allItems = questTrackerItems();
  const items = allItems.slice(0, 4);
  if (!items.length) {
    questTracker.innerHTML = `
      <div class="quest-tracker-head">
        <span>任务追踪</span>
        <strong>暂无待处理动作</strong>
        <small>风险、@我和候选命令会出现在这里</small>
      </div>
    `;
    return;
  }
  questTracker.innerHTML = `
    <div class="quest-tracker-head">
      <span>任务追踪</span>
      <strong>${escapeHtml(formatNumber(allItems.length))} 条待看</strong>
      <small>只填入发送栏，不自动发送</small>
      ${allItems.length > items.length ? `<button type="button" data-quest-more>查看全部</button>` : ""}
    </div>
    <div class="quest-tracker-list">
      ${items.map(renderQuestTrackerItem).join("")}
    </div>
  `;
  questTracker.querySelectorAll("[data-quest-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openQuestTrackerItem(button.dataset.questView || "");
    });
  });
  questTracker.querySelectorAll("[data-quest-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [key, indexText] = String(button.dataset.questAction || "").split("::");
      await fillQuestTrackerAction(key, Number(indexText || 0), "任务动作");
    });
  });
  questTracker.querySelector("[data-quest-more]")?.addEventListener("click", () => {
    openOverviewDetailPanel();
  });
}

function questTrackerItems() {
  const source = summarySignalMessages();
  const seen = new Set();
  const items = source
    .filter((message) => {
      if (!message?.id || seen.has(message.id)) return false;
      seen.add(message.id);
      return questTrackerRank(message) < 90;
    })
    .sort(compareRankThenRecency(questTrackerRank));
  const moduleQuests = currentModuleQuestItems(items);
  const dungeonQuest = currentDungeonQuestItem(items);
  return [dungeonQuest, ...moduleQuests, ...items]
    .filter(Boolean)
    .sort(compareRankThenRecency(questTrackerRank));
}

function currentDungeonQuestItem(existingItems = []) {
  const summary = actionableDungeonSnapshot() || currentDungeonSnapshot();
  if (!summary || !["open", "choice", "active", "joined"].includes(summary.statusKind)) return null;
  const actions = visibleDungeonActions(summary);
  if (!actions.length) return null;
  const existingActionKeys = new Set(
    existingItems.flatMap((item) => (item.actions || []).map(questActionKey))
  );
  const missingActions = actions.filter((action) => !existingActionKeys.has(questActionKey(action)));
  if (!missingActions.length) return null;
  const title = dungeonSummaryDisplayLabel(summary);
  const preview = [summary.status, summary.advice, summary.routeVerdict, summary.latestStage]
    .filter(Boolean)
    .join("｜") || "副本快照里有待确认动作。";
  return {
    id: `snapshot:dungeon:${summary.key || summary.dungeonId || "current"}`,
    title,
    summary: preview,
    raw: preview,
    source: "副本快照",
    time: summary.latestMessage?.time || "",
    seq: Number(summary.latestSeq || summary.latestMessage?.seq || 0),
    channels: ["dungeon", "focus"],
    tags: ["副本", "快照", summary.status || ""].filter(Boolean),
    actions: missingActions,
    severity: summary.statusKind === "failed" ? "warning" : "normal",
    fields: {
      "副本名": summary.dungeonName || "",
      "副本ID": summary.dungeonId || "",
      "状态": summary.status || "",
      "阶段": summary.latestStage || "",
    },
    __questSnapshot: "dungeon",
    __dungeonKey: summary.key || summary.dungeonId || "current",
    __sourceMessageId: summary.latestMessage?.id || missingActions[0]?.source_message_id || "",
  };
}

function questActionKey(action) {
  return [
    String(action?.command || "").trim(),
    String(action?.source_message_id || ""),
    String(action?.reply_to_msg_id || ""),
  ].join("|");
}

function currentModuleQuestItems(existingItems = []) {
  const activeId = Number(state.activeIdentityId || 0) || null;
  if (!activeId) return [];
  const existingActionKeys = new Set(
    existingItems.flatMap((item) => (item.actions || []).map(questActionKey))
  );
  return overviewModuleRows(activeId)
    .map((row) => currentModuleQuestItem(row, activeId))
    .filter(Boolean)
    .filter((item) => {
      const action = (item.actions || [])[0];
      if (!action) return true;
      const key = questActionKey(action);
      if (existingActionKeys.has(key)) return false;
      existingActionKeys.add(key);
      return true;
    })
    .slice(0, 3);
}

function currentModuleQuestItem(row, activeId) {
  if (!row?.item) return null;
  if (!["warn", "ready"].includes(row.view?.cls)) return null;
  const skill = moduleQuestSkill(row);
  if (!skill || !skillIsUnlocked(skill)) return null;
  const command = String(skill.command || "").trim();
  if (!command || skill.reply_mode === "required") return null;
  const updatedAt = Number(row.item.updated_at || 0);
  const summary = [
    row.view.status,
    row.view.time,
    row.spec?.__groupTitle,
  ].filter(Boolean).join("｜");
  const action = {
    type: "copy",
    label: skill.label || command,
    command,
    send_mode: "copy",
    identity_id: activeId,
    skill_key: skill.key,
  };
  return {
    id: `snapshot:module:${activeId}:${row.spec.key}`,
    title: `${row.view.icon || ""} ${row.view.label || row.spec.key}`.trim(),
    summary,
    raw: summary,
    source: "状态机",
    time: updatedAt ? new Date(updatedAt * 1000).toISOString() : "",
    seq: 0,
    channels: ["focus"],
    tags: ["状态", row.spec?.__groupTitle || "", row.view.status || ""].filter(Boolean),
    actions: [action],
    severity: row.view.cls === "warn" ? "warning" : "normal",
    fields: {
      "模块": row.view.label || row.spec.key,
      "状态": row.view.status || "",
      "时间": row.view.time || "",
    },
    __questSnapshot: "module",
    __moduleKey: row.spec.key,
    __identityId: activeId,
  };
}

function moduleQuestSkill(row) {
  const spec = row?.spec || {};
  const status = String(row?.view?.status || "");
  const preferredKeys = [];
  if (status === "待结算" && spec.query) {
    preferredKeys.push(spec.query);
  }
  if (row?.view?.cls === "warn" && spec.query) {
    preferredKeys.push(spec.query);
  }
  preferredKeys.push(spec.skill, ...(spec.extraSkills || []), spec.query, spec.__groupQuery);
  for (const key of preferredKeys.filter(Boolean)) {
    const skill = skillByKey(key);
    if (skill && String(skill.command || "").trim()) return skill;
  }
  return null;
}

function questTrackerRank(message) {
  if (message?.__questSnapshot === "dungeon") return 2;
  if (message?.__questSnapshot === "module") return 3;
  const channels = message.channels || [message.channel];
  const tags = message.tags || [];
  if (message.severity === "risk" || channels.includes("risk")) return 1;
  if ((message.actions || []).some((action) => String(action.command || "").trim())) return 2;
  if (isPersonalSignal(message)) return 3;
  if (channels.includes("dungeon") && ["可加入", "需要抉择"].some((tag) => tags.includes(tag))) return 4;
  return 99;
}

function renderQuestTrackerItem(message) {
  const key = questTrackerItemKey(message);
  const actionEntries = (message.actions || [])
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => String(action.command || "").trim());
  const { kind, text: kindText } = questItemKind(message, actionEntries);
  const preview = clipGraphemes(
    String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim(),
    78
  );
  return `
    <article class="quest-card ${escapeAttr(kind)}">
      <button type="button" class="quest-card-main" data-quest-view="${escapeAttr(key)}">
        <span class="quest-kind">${escapeHtml(kindText)}</span>
        <strong>${escapeHtml(message.title || displaySource(message.source))}</strong>
        <small>${escapeHtml(formatChatTime(message.time) || "")}｜${escapeHtml(displaySource(message.source))}</small>
        <em>${escapeHtml(preview || "（空消息）")}</em>
      </button>
      <div class="quest-card-actions">
        ${actionEntries.slice(0, 2).map(({ action, index }) => `
          <button type="button" data-quest-action="${escapeAttr(`${key}::${index}`)}" title="${escapeAttr(String(action.command || ""))}">
            ${escapeHtml(quickActionLabel(action))}
          </button>
        `).join("")}
        <button type="button" data-quest-view="${escapeAttr(key)}">查看</button>
      </div>
    </article>
  `;
}

function questItemKind(message, actionEntries = null) {
  const channels = message?.channels || [message?.channel];
  const actions = actionEntries || (message?.actions || []).filter((action) => String(action.command || "").trim());
  if (message?.__questSnapshot === "dungeon") return { kind: "dungeon", text: "副本" };
  if (message?.__questSnapshot === "module") return { kind: "module", text: "状态" };
  if (message?.severity === "risk" || channels.includes("risk")) return { kind: "risk", text: "风险" };
  if (actions.length) return { kind: "action", text: "动作" };
  if (isPersonalSignal(message)) return { kind: "mine", text: "我的" };
  return { kind: "focus", text: "重点" };
}

function questTrackerItemKey(item) {
  if (!item) return "";
  if (item.__questSnapshot) {
    return `snapshot:${item.__questSnapshot}:${item.__dungeonKey || item.id || "current"}`;
  }
  return String(item.id || "");
}

function questTrackerItemByKey(key) {
  const normalized = String(key || "");
  return questTrackerItems().find((item) => questTrackerItemKey(item) === normalized) || null;
}

async function openQuestTrackerItem(key) {
  const item = questTrackerItemByKey(key);
  if (!item) return;
  if (item.__questSnapshot === "module") {
    openIdentityStatusModal();
    return;
  }
  if (item.__questSnapshot === "dungeon") {
    const sourceId = item.__sourceMessageId || item.actions?.[0]?.source_message_id || "";
    const message = sourceId ? await findOrFetchMessage(sourceId) : null;
    if (message) {
      jumpToMessage(message);
      return;
    }
    await openDungeonStatusModal();
    return;
  }
  const message = await findOrFetchMessage(item.id || key);
  if (message) jumpToMessage(message);
}

async function fillQuestTrackerAction(key, index, label) {
  const item = questTrackerItemByKey(key);
  const action = (item?.actions || [])[Number(index || 0)];
  if (!item || !action?.command) return;
  const sourceId = action.source_message_id || item.__sourceMessageId || "";
  const sourceMessage = sourceId ? await findOrFetchMessage(sourceId) : (item.__questSnapshot ? null : item);
  fillDirectSendComposer(action.command, {
    identityId: action.identity_id,
    replyContext: directReplyContextFromAction(action, sourceMessage || item),
    statusText: quickActionNeedsManualReview(action)
      ? `已填入${label}，请补全内容后发送。`
      : `已填入${label}，请确认后发送。`,
    statusKind: "info",
  });
  if (sourceMessage) jumpToMessage(sourceMessage);
}

function renderOverviewDetailPanel() {
  const activeId = Number(state.activeIdentityId || 0) || null;
  const identity = activeId ? identityById(activeId) : null;
  const patchMap = new Map(activeIdentityPatches().map((item) => [item.key, item.value]));
  const sourceRows = identityProfileSourceRows(activeIdentityPatches()).slice(0, 4);
  const name =
    patchMap.get("角色名") ||
    patchMap.get("道号") ||
    identity?.label ||
    identity?.username ||
    (activeId ? String(activeId) : "未选身份");
  const subtitle = [
    patchMap.get("境界"),
    String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
    patchMap.get("灵根"),
  ].filter(Boolean).join("｜") || "等待消息箱补全角色资料";
  const metrics = [
    ["战力", patchMap.get("综合战力") || "未读"],
    ["修为", patchMap.get("修为") || "未读"],
    ["身份", identity?.kind === "channel" ? "频道" : identity ? "账号" : "未选"],
  ];
  const moduleRows = overviewModuleRows(activeId).slice(0, 6);
  const quests = questTrackerItems();
  const scenes = gameSceneSummaries();
  return `
    <section class="overview-panel">
      <div class="overview-hero">
        <div class="cockpit-avatar overview-avatar">${escapeHtml(sourceInitial(String(name), "player"))}</div>
        <div>
          <span>当前角色</span>
          <strong>${escapeHtml(String(name))}</strong>
          <small>${escapeHtml(subtitle)}</small>
        </div>
      </div>
      <div class="overview-metrics">
        ${metrics.map(([label, value]) => cockpitMetric(label, value)).join("")}
      </div>
      <div class="overview-actions">
        <button type="button" data-overview-action="status">角色状态</button>
        <button type="button" data-overview-action="report">今日战报</button>
        <button type="button" data-overview-action="refresh">刷新</button>
      </div>

      <section class="overview-section">
        <div class="overview-section-head">
          <strong>关键冷却</strong>
          <span>${escapeHtml(moduleRows.length ? `${moduleRows.length} 项` : "暂无")}</span>
        </div>
        <div class="overview-module-list">
          ${moduleRows.length ? moduleRows.map(renderOverviewModuleRow).join("") : '<p class="empty inline">选择身份后显示关键 CD。</p>'}
        </div>
      </section>

      <section class="overview-section">
        <div class="overview-section-head">
          <strong>任务追踪</strong>
          <span>${escapeHtml(quests.length ? `${quests.length} 条全部显示` : "暂无")}</span>
        </div>
        <div class="overview-quest-list">
          ${quests.length ? quests.map(renderOverviewQuestRow).join("") : '<p class="empty inline">风险、@我和候选动作会出现在这里。</p>'}
        </div>
      </section>

      <section class="overview-section">
        <div class="overview-section-head">
          <strong>场景入口</strong>
          <span>修仙地图</span>
        </div>
        <div class="overview-scene-grid">
          ${scenes.map((scene) => `
            <button type="button" data-overview-scene-channel="${escapeAttr(scene.channel)}">
              <strong>${escapeHtml(scene.title)}</strong>
              <span>${escapeHtml(formatNumber(scene.count))} 条</span>
              <small>${escapeHtml(clipGraphemes(scene.preview || "", 46))}</small>
            </button>
          `).join("")}
        </div>
      </section>

      <section class="overview-section">
        <div class="overview-section-head">
          <strong>资料来源</strong>
          <span>${escapeHtml(sourceRows.length ? "可追溯" : "暂无")}</span>
        </div>
        <div class="overview-source-list">
          ${sourceRows.length ? sourceRows.map((row) => `
            <button type="button" data-overview-source="${escapeAttr(row.sourceMessageId || "")}" ${row.sourceMessageId ? "" : "disabled"}>
              <span>${escapeHtml(row.key)}</span>
              <strong>${escapeHtml(formatFieldValue(row.value))}</strong>
              <small>${escapeHtml(auditTimeLabel(row.updatedAt) || "未知时间")}</small>
            </button>
          `).join("") : '<p class="empty inline">发送或监听“我的灵根 / 战力”后会更新。</p>'}
        </div>
      </section>
    </section>
  `;
}

function overviewModuleRows(activeId) {
  if (!activeId) return [];
  const stateItems = state.identityModuleStates.get(activeId) || [];
  const byKey = new Map(stateItems.map((item) => [item.module_key, item]));
  const specs = identityStatusFlatSpecs();
  const rank = { warn: 0, ready: 1, running: 2, cooling: 3, unknown: 4 };
  return specs
    .map((spec) => ({ spec, item: byKey.get(spec.key), view: identityModuleView(spec, byKey.get(spec.key)) }))
    .sort((a, b) => (rank[a.view.cls] ?? 9) - (rank[b.view.cls] ?? 9) || (a.spec.__rank || 0) - (b.spec.__rank || 0));
}

function identityStatusFlatSpecs() {
  return IDENTITY_STATUS_GROUPS.flatMap((group, groupIndex) => (
    group.modules.map((spec, moduleIndex) => ({
      ...spec,
      __groupKey: group.key,
      __groupTitle: group.title,
      __groupQuery: group.query || "",
      __rank: groupIndex * 100 + moduleIndex,
    }))
  ));
}

function renderOverviewModuleRow(row) {
  return `
    <div class="overview-module-row ${escapeAttr(row.view.cls)}">
      <span>${escapeHtml(row.view.icon)}</span>
      <strong>${escapeHtml(row.view.label)}</strong>
      <small>${escapeHtml(row.view.status)}｜${escapeHtml(row.view.time)}</small>
    </div>
  `;
}

function renderOverviewQuestRow(message) {
  const key = questTrackerItemKey(message);
  const actionEntries = (message.actions || [])
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => String(action.command || "").trim());
  const { kind, text: kindText } = questItemKind(message, actionEntries);
  const preview = clipGraphemes(String(message.summary || message.raw || message.title || "").replace(/\s+/g, " "), 58);
  return `
    <article class="overview-quest-row ${escapeAttr(kind)}">
      <button type="button" data-overview-quest-view="${escapeAttr(key)}">
        <span class="overview-quest-kind ${escapeAttr(kind)}">${escapeHtml(kindText)}</span>
        <strong>${escapeHtml(message.title || displaySource(message.source))}</strong>
        <small>${escapeHtml(formatChatTime(message.time) || "")}｜${escapeHtml(displaySource(message.source))}</small>
        <span>${escapeHtml(preview || "（空消息）")}</span>
      </button>
      ${actionEntries[0] ? `<button type="button" data-overview-quest-action="${escapeAttr(`${key}::${actionEntries[0].index}`)}">${escapeHtml(quickActionLabel(actionEntries[0].action))}</button>` : ""}
    </article>
  `;
}

function bindOverviewDetailPanel() {
  detailPanel.querySelector('[data-overview-action="status"]')?.addEventListener("click", () => openIdentityStatusModal());
  detailPanel.querySelector('[data-overview-action="report"]')?.addEventListener("click", () => openWorldReportModal().catch((error) => showError(error)));
  detailPanel.querySelector('[data-overview-action="refresh"]')?.addEventListener("click", async () => {
    await Promise.all([refreshChatViewport(), loadIdentityPatches(), loadIdentityModuleStates()]);
    renderDetail().catch((error) => console.warn("[mini-web] refresh overview failed:", error));
  });
  detailPanel.querySelectorAll("[data-overview-scene-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const channel = button.dataset.overviewSceneChannel || "focus";
      closeWorkspacePanel({ rerenderList: false, clearSelection: true });
      applyChannelSelection([channel]).catch((error) => showSkillToast(`频道加载失败: ${error.message || error}`, "err"));
    });
  });
  detailPanel.querySelectorAll("[data-overview-source]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.overviewSource || "";
      if (!id) return;
      const message = await findOrFetchMessage(id);
      if (message) jumpToMessage(message);
    });
  });
  detailPanel.querySelectorAll("[data-overview-quest-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openQuestTrackerItem(button.dataset.overviewQuestView || "");
    });
  });
  detailPanel.querySelectorAll("[data-overview-quest-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [key, indexText] = String(button.dataset.overviewQuestAction || "").split("::");
      await fillQuestTrackerAction(key, Number(indexText || 0), "概览动作");
    });
  });
}

function worldEventSlotDefs() {
  return [
    {
      key: "mine",
      kind: "mine",
      label: "我的",
      channel: "mine",
      emptyTitle: "暂无个人回复",
      emptySubline: "回复 / 提及 / 风险",
      emptyText: "天尊回复我或有人提到我时显示在这里。",
    },
    {
      key: "dungeon",
      kind: "dungeon",
      label: "副本",
      channel: "dungeon",
      emptyTitle: "暂无副本线索",
      emptySubline: "开房 / 加入 / 推进",
      emptyText: "副本开启、卦象、抉择和战利品线索会显示在这里。",
    },
    {
      key: "resource",
      kind: "resource",
      label: "收益",
      channel: "resource",
      emptyTitle: "暂无收益记录",
      emptySubline: "野外 / 副本 / 奇遇",
      emptyText: "野外历练、副本掉落和奇遇资源会显示在这里。",
    },
    {
      key: "leader",
      kind: "leader",
      label: "情报",
      channel: "leader",
      emptyTitle: "暂无情报",
      emptySubline: "会长 / 天尊普通发言",
      emptyText: "新玩法线索、本人上号和会长发言会显示在这里。",
    },
    {
      key: "focus",
      kind: "focus",
      label: "重点",
      channel: "focus",
      emptyTitle: "等待消息箱",
      emptySubline: "关注关键词",
      emptyText: "采集到重点消息后会显示在这里。",
    },
  ];
}

function worldEventSlots() {
  const source = summarySignalMessages();
  const sorted = [...source].sort(compareRankThenRecency(worldEventRank));
  const used = new Set();
  return worldEventSlotDefs().map((def) => {
    const matches = sorted.filter((message) => worldEventSlotMatch(def, message));
    const snapshot = worldEventSlotSnapshot(def, matches);
    const message = matches.find((item) => !used.has(item.id)) || snapshot?.message || matches[0] || null;
    if (message?.id) used.add(message.id);
    return { def, message, count: Number(snapshot?.count ?? matches.length), snapshot };
  });
}

function worldEventSlotSnapshot(def, matches = []) {
  if (!def) return null;
  if (def.key === "dungeon") {
    const summary = actionableDungeonSnapshot() || currentDungeonSnapshot();
    if (!summary) return null;
    const title = dungeonSummaryDisplayLabel(summary);
    return {
      title,
      subline: `${summary.status || "副本"}｜${formatChatTime(summary.latestMessage?.time) || "最近"}`,
      preview: [summary.advice, summary.routeVerdict, summary.latestStage, summary.openedBy].filter(Boolean).join("｜") || "副本状态已从消息箱汇总。",
      panel: "dungeon",
      count: Number((state.worldSnapshot?.dungeon || {}).total_summaries || summary.messageCount || matches.length || 0),
      message: summary.latestMessage || null,
      action: visibleDungeonActions(summary)[0] || null,
    };
  }
  if (def.key === "resource") {
    const resource = liveResourceSnapshot();
    if (!resource) return null;
    const attempts = resource.wild.success + resource.wild.failed;
    const rate = attempts ? `${Math.round((resource.wild.success * 100) / attempts)}%` : "暂无";
    const rare = resource.rareRows.length
      ? resource.rareRows.map((row) => `${row.resource_name}${formatResourceAmount(row.total_amount, row.unit)}`).join(" / ")
      : "暂无稀有产物";
    return {
      title: "今日收益",
      subline: `${resource.latestPeriod || "本期"}｜野外成功率 ${rate}`,
      preview: rare,
      panel: "resource",
      count: resource.eventCount || matches.length || 0,
    };
  }
  if (def.key === "leader") {
    const message = latestLeaderSnapshotMessage();
    if (!message) return null;
    return {
      title: message.title || "情报",
      subline: `${formatChatTime(message.time) || "最近"}｜${displaySource(message.source)}`,
      preview: liveMessagePreview(message, 78),
      panel: "intel",
      count: ((state.worldSnapshot?.leader || {}).messages || []).length || matches.length || 0,
      message,
    };
  }
  return null;
}

function worldEventSlotMatch(def, message) {
  if (!message) return false;
  const channels = message.channels || [message.channel];
  const tags = message.tags || [];
  if (def.key === "mine") {
    return isPersonalSignal(message);
  }
  if (def.key === "dungeon") return channels.includes("dungeon");
  if (def.key === "resource") return channels.includes("resource") || channels.includes("training") || channels.includes("home");
  if (def.key === "leader") return channels.includes("leader") || tags.includes("会长");
  if (def.key === "focus") return channels.includes("focus");
  return false;
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

function worldEventCandidates() {
  const source = summarySignalMessages();
  const seen = new Set();
  return source
    .filter((message) => {
      if (!message || !message.id || seen.has(message.id)) return false;
      seen.add(message.id);
      return worldEventRank(message) < 90;
    })
    .sort(compareRankThenRecency(worldEventRank));
}

function worldEventRank(message) {
  const channels = message.channels || [message.channel];
  const tags = message.tags || [];
  if (message.severity === "risk" || channels.includes("risk")) return 1;
  if (isPersonalSignal(message)) return 2;
  if (channels.includes("dungeon")) return 3;
  if (channels.includes("leader") || tags.includes("会长")) return 4;
  if (channels.includes("resource") || channels.includes("training") || channels.includes("home")) return 5;
  if ((message.actions || []).length) return 6;
  if (channels.includes("focus")) return 8;
  return 99;
}

function worldEventMeta(message) {
  const channels = message.channels || [message.channel];
  const tags = message.tags || [];
  if (message.severity === "risk" || channels.includes("risk")) return { kind: "risk", label: "风险" };
  if (isPersonalSignal(message)) return { kind: "mine", label: "我的" };
  if (channels.includes("dungeon")) return { kind: "dungeon", label: "副本" };
  if (channels.includes("leader") || tags.includes("会长")) return { kind: "leader", label: "会长" };
  if (channels.includes("resource")) return { kind: "resource", label: "资源" };
  if (channels.includes("training")) return { kind: "training", label: "修炼" };
  if (channels.includes("home")) return { kind: "home", label: "洞府" };
  if ((message.actions || []).length) return { kind: "action", label: "候选" };
  return { kind: "focus", label: "重点" };
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
  const row = document.createElement("article");
  const kind = messageKind(message);
  const isExpanded = state.expandedMessages.has(message.id);
  row.className = [
    "chat-message",
    `kind-${kind}`,
    message.id === state.selectedMessageId ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  row.dataset.messageId = message.id;

  const contextHtml = renderChatContextMeta(message);

  const { html: textHtml, truncated } = renderChatBodyText(message, isExpanded);
  const riskBadge =
    kind === "risk"
      ? `<span class="chat-risk-badge" title="风险消息，需要人工查看">! 需要关注</span>`
      : "";
  const sourceText = displaySource(message.source);
  const sourceClass = isNumericSource(message.source) ? "chat-source numeric" : "chat-source";
  const replyContext = renderReplyContext(message);

  const canReply = Number(message.chat_id || 0) !== 0 && Number(message.msg_id || 0) > 0;
  row.innerHTML = `
    <button type="button" class="chat-avatar-btn" data-chat-action="detail" aria-label="查看消息详情">
      <span class="chat-avatar" aria-hidden="true">${escapeHtml(sourceInitial(message.source, kind))}</span>
    </button>
    <div class="chat-body">
      <div class="chat-head-row">
        <button type="button" class="chat-head" data-chat-action="select">
          <strong class="${sourceClass}">${escapeHtml(sourceText)}</strong>
          <span class="chat-time">${escapeHtml(formatChatTime(message.time))}</span>
          ${riskBadge}
        </button>
        <div class="chat-message-actions">
          <button type="button" class="chat-detail-button" data-chat-action="detail" aria-label="查看消息详情"
                  title="查看原文、字段和候选动作">详</button>
          <button type="button" class="chat-reply-button" data-chat-action="reply" ${canReply ? "" : "disabled"}
                  aria-label="回复这条消息"
                  title="${canReply ? "回复这条 Telegram 消息" : "这条卡片缺少 Telegram msg_id,不能回复"}">回</button>
        </div>
      </div>
      ${replyContext}
      <div class="chat-text" data-chat-action="select">${textHtml}</div>
      ${truncated ? `<button type="button" class="chat-toggle" data-chat-action="toggle">${isExpanded ? "收起全文" : "展开全文"}</button>` : ""}
      ${renderChatQuickActions(message)}
      ${contextHtml}
    </div>
  `;

  row.addEventListener("click", async (event) => {
    const quickAction = event.target.closest('[data-chat-action="quick-action"]');
    if (quickAction) {
      event.stopPropagation();
      selectMessageForComposer(message, { rerenderList: true });
      const index = Number(quickAction.dataset.actionIndex || 0);
      await handleChatQuickAction(message, index, quickAction);
      return;
    }
    const detail = event.target.closest('[data-chat-action="detail"]');
    if (detail) {
      event.stopPropagation();
      setWorkspaceSelectedMessage(message, { rerenderList: true });
      return;
    }
    const reply = event.target.closest('[data-chat-action="reply"]');
    if (reply) {
      event.stopPropagation();
      if (!reply.disabled) {
        selectMessageForComposer(message, { rerenderList: true });
        setDirectSendReplyFromMessage(message);
      }
      return;
    }
    const toggle = event.target.closest('[data-chat-action="toggle"]');
    if (toggle) {
      event.stopPropagation();
      if (state.expandedMessages.has(message.id)) {
        state.expandedMessages.delete(message.id);
      } else {
        state.expandedMessages.add(message.id);
      }
      renderMessages();
      return;
    }
    const jump = event.target.closest("[data-reply-jump]");
    if (jump) {
      event.stopPropagation();
      const targetId = jump.dataset.replyJump;
      let parent = state.messages.find((m) => m.id === targetId);
      if (!parent) {
        // 不在 state 里,按需拉一条进来
        jump.classList.add("loading");
        parent = await fetchMessageById(targetId);
        jump.classList.remove("loading");
        if (!parent) {
          console.warn("[mini-web] 父消息不存在或已被清理:", targetId);
          return;
        }
      }
      jumpToMessage(parent);
      return;
    }
    selectMessageForComposer(message, { rerenderList: true });
  });
  return row;
}

function renderChatContextMeta(message) {
  const badges = visibleMessageBadges(message);
  const actionCount = (message.actions || []).length;
  const items = [
    message.title ? `<span class="chat-title-pill">${escapeHtml(message.title)}</span>` : "",
    ...badges.map((tag) => `<span class="chat-tag">${escapeHtml(tag)}</span>`),
    actionCount ? `<span class="chat-action-pill">${actionCount} 个候选</span>` : "",
  ].filter(Boolean);
  return items.length ? `<div class="chat-enhance">${items.join("")}</div>` : "";
}

function visibleMessageBadges(message) {
  const tags = (message.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean);
  const channels = message.channels || [message.channel];
  const important = new Set();
  if (message.severity === "risk" || channels.includes("risk")) {
    important.add("风险");
  }
  if (isPersonalSignal(message)) {
    important.add("我的");
  }
  for (const tag of tags) {
    if (["被@", "回复我", "会长", "我发出", "失败", "解散", "可加入", "加入", "风险"].includes(tag)) {
      important.add(tag === "我发出" ? "我的" : tag);
    } else if (tag.startsWith("关键词:")) {
      important.add(tag);
    }
  }
  return Array.from(important).slice(0, 3);
}

function renderChatQuickActions(message) {
  const actions = (message.actions || []).filter((action) => String(action.command || "").trim());
  if (!actions.length) return "";
  const maxVisible = 4;
  const buttons = actions.slice(0, maxVisible).map((action, index) => {
    const label = quickActionLabel(action);
    const command = String(action.command || "").trim();
    const replyText = action.reply_to_msg_id ? `回复 #${action.reply_to_msg_id}` : "直接发送";
    return `
      <button type="button" class="chat-quick-action" data-chat-action="quick-action"
              data-action-index="${index}" title="${escapeAttr(`${replyText}: ${command}`)}">
        ${escapeHtml(label)}
      </button>
    `;
  }).join("");
  const more = actions.length > maxVisible
    ? `<span class="chat-quick-more">+${actions.length - maxVisible}</span>`
    : "";
  return `<div class="chat-quick-actions">${buttons}${more}</div>`;
}

function quickActionLabel(action) {
  const rawLabel = String(action.label || "").trim();
  const command = String(action.command || "").trim();
  const cleaned = rawLabel
    .replace(/^复制\s*/, "")
    .replace(/[（(]回复[）)]/g, "")
    .trim();
  if (cleaned && cleaned.length <= 12) return cleaned;
  return command.replace(/^[.。]/, "").trim() || "回复";
}

function quickActionNeedsManualReview(action) {
  const command = String(action.command || "").trim();
  // 自证命令通常还需要口令 + 答案,不能裸发 ".自证"。
  return command === ".自证" || command === "。自证";
}

async function handleChatQuickAction(message, index, button) {
  const action = (message.actions || [])[index];
  if (!action) return;
  fillDirectSendComposer(action.command, {
    replyContext: directReplyContextFromAction(action, message),
    statusText: quickActionNeedsManualReview(action)
      ? "已填入快捷动作，请补全内容后发送。"
      : "已填入快捷动作，请确认后发送。",
    statusKind: "info",
  });
  if (button) {
    const originalText = button.textContent;
    button.textContent = "已填入";
    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1200);
  }
}

function displaySource(source) {
  const clean = String(source || "").trim();
  if (!clean) {
    return "未知发送者";
  }
  if (isNumericSource(clean)) {
    return `用户 ${clean}`;
  }
  return clean;
}

function isNumericSource(source) {
  const clean = String(source || "").trim();
  return clean !== "" && NUMERIC_SOURCE_RE.test(clean);
}

function renderChatBodyText(message, isExpanded) {
  const raw = String(message.raw || "").trim();
  const fallback = String(message.summary || message.title || "").trim();
  const text = raw || fallback || "（空消息）";
  const lines = text.split("\n");
  const graphemeLength = countGraphemes(text);
  const tooLong =
    graphemeLength > MESSAGE_PREVIEW_CHAR_LIMIT || lines.length > MESSAGE_PREVIEW_LINE_LIMIT;

  if (!tooLong || isExpanded) {
    return { html: renderTelegramTextHtml(text, message), truncated: tooLong };
  }

  const previewLines = lines.slice(0, MESSAGE_PREVIEW_LINE_LIMIT);
  let preview = previewLines.join("\n");
  if (countGraphemes(preview) > MESSAGE_PREVIEW_CHAR_LIMIT) {
    preview = clipGraphemes(preview, MESSAGE_PREVIEW_CHAR_LIMIT);
  }
  return { html: `${renderTelegramTextHtml(preview, message)}<span class="chat-text-ellipsis">…</span>`, truncated: true };
}

function groupMessagesByDate(messages) {
  const groups = [];
  let current = null;
  messages.forEach((message) => {
    const label = formatDayLabel(message.time);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(message);
  });
  return groups;
}

function formatDayLabel(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "时间未知";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  const now = new Date();
  const diffDays = daysBetween(date, now);
  if (diffDays === 0) {
    return "今天";
  }
  if (diffDays === 1) {
    return "昨天";
  }
  if (diffDays === 2) {
    return "前天";
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function daysBetween(date, now) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function formatChatTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function messageKind(message) {
  const channels = message.channels || [message.channel];
  const source = String(message.source || "");
  if (message.severity === "risk" || channels.includes("risk")) {
    return "risk";
  }
  if (isPersonalSignal(message)) {
    return "mine";
  }
  if (message.sender_is_bot || channels.includes("system") || source.includes("韩天尊") || source.includes("天尊")) {
    return "bot";
  }
  return "player";
}

function sourceInitial(source, kind) {
  const clean = String(source || "").replace(/^@/, "").trim();
  if (kind === "risk") {
    return "！";
  }
  if (clean.includes("韩天尊") || clean.includes("天尊")) {
    return "天";
  }
  if (!clean) {
    return "?";
  }
  return firstGrapheme(clean).toUpperCase();
}

async function renderDetail() {
  if (state.detailMode === "overview") {
    detailState.textContent = "概览";
    detailPanel.innerHTML = renderOverviewDetailPanel();
    bindOverviewDetailPanel();
    return;
  }
  if (state.detailMode !== "message") {
    return;
  }
  const message = state.messages.find((item) => item.id === state.selectedMessageId);
  if (!message || !visibleMessages().some((item) => item.id === message.id)) {
    setWorkspacePanelOpen(false);
    detailState.textContent = "未选择";
    detailPanel.innerHTML = `
      <div class="detail-empty-state">
        <strong>未选中消息</strong>
        <p>从消息流选一条消息。</p>
        <div>
          <span>原文</span>
          <span>候选</span>
          <span>回复</span>
        </div>
      </div>
    `;
    return;
  }
  if (message.compact) {
    detailState.textContent = "载入中";
    detailPanel.innerHTML = '<div class="detail-empty-state loading"><strong>正在载入原文</strong><p>从消息箱补齐 Telegram 原文和结构化字段。</p></div>';
    const fullMessage = await ensureFullMessage(message);
    if (fullMessage && !fullMessage.compact) {
      await renderDetail();
    }
    return;
  }

  const isRisk = message.severity === "risk";
  detailState.textContent = isRisk ? "风险" : actionCountLabel(message);
  const enhancedHtml = renderEnhancedBlock(message);
  const actionsHtml = renderDetailActions(message);
  const focusInsightHtml = renderFocusInsight(message);
  const heading = String(message.title || "").trim() || "Telegram 消息";
  const summary = String(message.summary || "").trim();
  const rawText = String(message.raw || "").trim();
  const rawPreview = clipGraphemes((rawText || summary || heading).replace(/\s+/g, " "), 180);
  const actionCount = (message.actions || []).length;
  const canReply = Number(message.chat_id || 0) !== 0 && Number(message.msg_id || 0) > 0;

  detailPanel.innerHTML = `
    <section class="detail-selected-message ${isRisk ? "risk" : ""}">
      <div class="detail-selected-meta">
        <strong>${escapeHtml(displaySource(message.source))}</strong>
        <span>${escapeHtml(formatChatTime(message.time) || message.time || "时间未知")}</span>
      </div>
      <p>${escapeHtml(rawPreview || "（空消息）")}</p>
    </section>

    <div class="detail-action-console">
      <button type="button" class="action-primary" data-detail-message-action="reply" ${canReply ? "" : "disabled"}>回复这条</button>
      <button type="button" class="action-secondary" data-detail-message-action="fill-source">引用原文</button>
      <button type="button" class="action-tertiary" data-detail-message-action="copy-text">复制原文</button>
    </div>

    ${isRisk ? `<p class="detail-risk-hint">风险消息只做提醒和草稿，不自动发送。请看原文后在底部发送栏确认。</p>` : ""}

    <section class="detail-action-stage ${actionCount ? "" : "empty"}">
      <div class="detail-stage-head">
        <div>
          <strong>可执行候选</strong>
          <span>点击只填入底部输入栏，不会自动发送</span>
        </div>
        <em>${escapeHtml(actionCount ? `${actionCount} 个` : "无")}</em>
      </div>
      ${actionsHtml}
      <div id="outboxPlanPanel" class="outbox-plan-wrap"></div>
    </section>

    <details class="detail-fold">
      <summary>结构化信息</summary>
      <div class="detail-fold-body">${enhancedHtml}</div>
    </details>

    <details class="detail-fold ${isRisk ? "risk-open" : ""}" ${isRisk ? "open" : ""}>
      <summary>Telegram 原文</summary>
      <pre class="raw-text">${renderTelegramTextHtml(rawText || "（未抓取到原文）", message)}</pre>
    </details>

    <details class="detail-fold detail-focus-fold">
      <summary>分流原因 / 降噪</summary>
      <div class="detail-fold-body">${focusInsightHtml}</div>
    </details>
  `;

  bindDetailActions(message);
}

function renderFocusInsight(message) {
  const reasons = focusReasonList(message);
  const reasonsHtml = reasons.length
    ? `<div class="focus-reason-list">${reasons.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
    : '<p class="empty inline">这条消息当前不在重点流。</p>';
  const toolsHtml = renderFocusTools(message);
  return `
    <div class="detail-focus-section">
      <h5>入重点原因</h5>
      ${reasonsHtml}
      ${toolsHtml}
    </div>
  `;
}

function actionCountLabel(message) {
  const count = (message?.actions || []).length;
  return count ? `${count} 个候选` : "上下文";
}

function renderFocusTools(message) {
  if (!canFocusArchiveMessage(message)) return "";
  const senderId = Number(message.sender_id || 0);
  const muted = isFocusMutedSenderId(senderId);
  const muteLabel = muted ? "取消重点静音此人" : "重点流静音此人";
  const hint = muted
    ? "此 sender 的普通玩家消息已从重点流移到归档。"
    : "只影响普通玩家噪音；@我、我的发送、风险、动作和天尊回复我仍会显示。";
  return `
    <div class="detail-focus-tools">
      <button type="button" class="action-tertiary" data-detail-action="focus-archive-exact">归档这句话</button>
      <button type="button" class="action-tertiary" data-detail-action="focus-archive-contains">归档包含短语</button>
      <button type="button" class="action-tertiary" data-detail-action="focus-mute-toggle">${escapeHtml(muteLabel)}</button>
      <span>${escapeHtml(hint)} sender_id=${escapeHtml(String(senderId))}</span>
    </div>
  `;
}

function focusReasonList(message) {
  if (Array.isArray(message.filter_reasons) && message.filter_reasons.length) {
    return Array.from(new Set(message.filter_reasons.map((item) => String(item || "").trim()).filter(Boolean)));
  }
  const reasons = [];
  const channels = message.channels || [message.channel];
  const tags = message.tags || [];
  if (!channels.includes("focus")) return reasons;
  if (tags.includes("我发出")) reasons.push("我的发送");
  if (tags.includes("回复我")) reasons.push("天尊回复我");
  if (tags.includes("被@")) reasons.push("被 @");
  if (tags.includes("会长")) reasons.push("会长 / 情报源");
  if (message.severity === "risk" || channels.includes("risk")) reasons.push("风险消息");
  (tags || []).forEach((tag) => {
    if (String(tag).startsWith("关键词:")) reasons.push(`关键词命中：${String(tag).slice(4)}`);
  });
  if ((message.actions || []).length) reasons.push("有动作草稿");
  if (channels.includes("dungeon")) reasons.push("副本消息");
  if (channels.includes("resource")) reasons.push("资源 / 背包消息");
  if (channels.includes("training")) reasons.push("修炼状态消息");
  if (channels.includes("home")) reasons.push("洞府 / 家园消息");
  if (messageKind(message) === "player" && !reasons.length) reasons.push("普通玩家消息策略");
  if (!tags.some((tag) => String(tag).startsWith("重点排除:") || String(tag).startsWith("重点静音:"))) {
    reasons.push("未被排除规则命中");
  }
  return Array.from(new Set(reasons));
}

function canFocusArchiveMessage(message) {
  const senderId = Number(message?.sender_id || 0);
  if (!Number.isFinite(senderId) || senderId === 0) return false;
  if (messageKind(message) !== "player") return false;
  if ((message.channels || []).includes("mine")) return false;
  if ((message.actions || []).length) return false;
  if (message.severity === "risk" || (message.channels || []).includes("risk")) return false;
  if ((message.tags || []).some((tag) => ["被@", "回复我", "会长", "我发出"].includes(String(tag)))) return false;
  return true;
}

function isFocusMutedSenderId(senderId) {
  const ids = ((state.settings || {}).focus_muted_sender_ids || []).map((id) => Number(id));
  return ids.includes(Number(senderId));
}

// 卡片专用 renderer 注册表 — 按 message.title 派发,落不到具体 renderer 就走通用 fields grid。
// 新增「页游化」卡片只需在这里加一行 + 写对应 render 函数。
const cardRenderers = {
  "战力评估": renderBattlePowerCard,
  "角色信息": renderProfileCard,
  "深度闭关总结": renderDeepRetreatSummaryCard,
  "闭关成功": renderRetreatSuccessCard,
  "试炼古塔战报": renderTowerTrialCard,
  "储物袋快照": renderInventoryCard,
  "第二元神归位": renderSecondSoulCard,
  "登天阶面板": renderTiantiPanelCard,
  "观星台面板": renderStargazerPanelCard,
  "星盘显化": renderStargazerResultCard,
  "天机阁快报": renderStargazerResultCard,
  "小世界面板": renderSmallWorldPanelCard,
  "侍妾面板": renderConcubinePanelCard,
  "灵树面板": renderTreePanelCard,
  "灵树采摘": renderTreeHarvestCard,
  "抚摸法宝": renderPetPanelCard,
  "温养器灵": renderPetPanelCard,
  "器灵试炼": renderPetPanelCard,
  "引动大道": renderTaiyiPanelCard,
  "空间节点": renderTaiyiPanelCard,
  "定星成功": renderTaiyiPanelCard,
  "虚天殿开启": renderDungeonCard,
  "风险提醒": renderRiskCard,
};

function renderEnhancedBlock(message) {
  const title = String(message.title || "").trim();
  const renderer = cardRenderers[title];
  if (renderer) {
    try {
      return renderer(message);
    } catch (err) {
      console.warn("[card-render]", title, err);
      // 渲染器自己挂了,退回 fields grid,别让整面板白屏
      return renderDetailFields(message.fields);
    }
  }
  if ((message.channels || []).includes("dungeon")) {
    return renderDungeonCard(message);
  }
  if (shouldRenderGenericGameplayCard(message)) {
    return renderGenericGameplayCard(message);
  }
  return renderDetailFields(message.fields);
}

function shouldRenderGenericGameplayCard(message) {
  const fields = message.fields || {};
  if (!Object.keys(fields).some((key) => isPresentValue(fields[key]))) return false;
  const channels = message.channels || [message.channel];
  return ["home", "training", "resource", "system", "mine", "risk"].some((channel) => channels.includes(channel));
}

function richHero(icon, label, value) {
  return `
    <div class="rich-hero">
      <div class="rich-hero-icon">${icon}</div>
      <div class="rich-hero-text">
        <span class="rich-hero-label">${escapeHtml(label)}</span>
        <strong class="rich-hero-value">${escapeHtml(value)}</strong>
      </div>
    </div>
  `;
}

function richChips(pairs) {
  // pairs: [["灵根", "天灵根(火)"], ...]
  const html = pairs
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `<span class="rich-chip"><span class="rich-chip-k">${escapeHtml(k)}</span>${escapeHtml(String(v))}</span>`)
    .join("");
  return html ? `<div class="rich-chips">${html}</div>` : "";
}

function renderBattlePowerCard(message) {
  const f = message.fields || {};
  const power = f["综合战力"] ? formatFieldValue(f["综合战力"]) : "—";
  const realm = f["境界"] ? formatFieldValue(f["境界"]) : "未知";
  return `
    <div class="card-rich card-rich-stat">
      ${richHero("⚔️", "综合战力", power)}
      ${richChips([["境界", realm]])}
    </div>
  `;
}

function renderProfileCard(message) {
  const f = message.fields || {};
  const root = f["灵根"] ? formatFieldValue(f["灵根"]) : "—";
  const sect = f["宗门"] ? formatFieldValue(f["宗门"]) : "散修";
  const owner = String(message.source || "").trim() || "本尊";
  return `
    <div class="card-rich card-rich-profile">
      ${richHero("📜", "天命玉牒", owner)}
      ${richChips([["灵根", root], ["宗门", sect]])}
    </div>
  `;
}

function richStatGrid(pairs) {
  // pairs: [["修行有成","22 次"], ...]
  const cells = pairs
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(
      ([k, v]) => `
        <div class="rich-stat-cell">
          <span class="rich-stat-cell-k">${escapeHtml(k)}</span>
          <span class="rich-stat-cell-v">${escapeHtml(String(v))}</span>
        </div>`
    )
    .join("");
  return cells ? `<div class="rich-stat-grid">${cells}</div>` : "";
}

function richCollapsibleList(label, items, maxVisible = 4) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const head = items.slice(0, maxVisible);
  const tail = items.slice(maxVisible);
  const headHtml = head.map((it) => `<li>${escapeHtml(String(it))}</li>`).join("");
  const tailHtml = tail.length
    ? `<ul class="rich-list rich-list-collapsed" hidden>${tail
        .map((it) => `<li>${escapeHtml(String(it))}</li>`)
        .join("")}</ul>
       <button type="button" class="rich-collapse-toggle" data-rich-collapse="1">展开剩余 ${tail.length} 条</button>`
    : "";
  return `
    <div class="rich-progress">
      <div class="rich-progress-head"><span>${escapeHtml(label)}</span></div>
      <ul class="rich-list">${headHtml}</ul>
      ${tailHtml}
    </div>
  `;
}

function richProgress(label, current, max, suffix = "") {
  const c = Number(current) || 0;
  const m = Number(max) || 0;
  const pct = m > 0 ? Math.min(100, Math.max(0, (c / m) * 100)) : 0;
  return `
    <div class="rich-progress">
      <div class="rich-progress-head">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(`${c} / ${m}${suffix ? " " + suffix : ""}`)}</span>
      </div>
      <div class="rich-progress-bar"><span class="rich-progress-fill" style="width:${pct.toFixed(1)}%"></span></div>
    </div>
  `;
}

function renderDeepRetreatSummaryCard(message) {
  const f = message.fields || {};
  const gain = f["修为变化"] ? formatFieldValue(f["修为变化"]) : "—";
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("📿", "深度闭关 · 修为变化", gain)}
      ${richStatGrid([
        ["结算时长", f["结算时长"] || ""],
        ["神魂吐纳", f["神魂吐纳"] || ""],
        ["修行有成", f["修行有成"] || ""],
        ["心神不宁", f["心神不宁"] || ""],
        ["走火入魔", f["走火入魔"] || ""],
        ["天降奇遇", f["天降奇遇"] || ""],
      ])}
      ${f["状态加持"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">状态加持</span>${escapeHtml(String(f["状态加持"]))}</span></div>` : ""}
      ${richCollapsibleList("奇遇详情", f["奇遇详情"] || [], 4)}
    </div>
  `;
}

function renderRetreatSuccessCard(message) {
  const f = message.fields || {};
  const total = f["本次总收益"] ? formatFieldValue(f["本次总收益"]) : "—";
  const realm = f["当前境界"] ? formatFieldValue(f["当前境界"]) : "";
  const cooldown = f["调息冷却"] ? formatFieldValue(f["调息冷却"]) : "";
  const progress = f["修为进度"] && typeof f["修为进度"] === "object" ? f["修为进度"] : null;
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🧘", "本次总收益", total)}
      ${richStatGrid([
        ["基础修为", f["基础修为"] || ""],
        ["灵脉加成", f["灵脉加成"] || ""],
        ["阵法加成", f["阵法加成"] || ""],
        ["当前境界", realm],
        ["调息冷却", cooldown],
      ])}
      ${progress ? richProgress("当前修为", progress.current, progress.max) : ""}
      ${f["奇遇"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">奇遇</span>${escapeHtml(String(f["奇遇"]))}</span></div>` : ""}
    </div>
  `;
}

function renderTowerTrialCard(message) {
  const f = message.fields || {};
  const floors = f["闯过层数"] ? formatFieldValue(f["闯过层数"]) : "—";
  const detailFloors = Array.isArray(f["逐层详情"]) ? f["逐层详情"] : [];
  const floorRows = detailFloors
    .map((fl) => {
      const outcome = String(fl.outcome || "");
      const cls = outcome === "败北" ? "out-fail" : outcome === "险胜" ? "out-win" : "out-crush";
      return `<li><span class="tower-floor-num">第 ${escapeHtml(String(fl.floor))} 层</span> <span class="tower-floor-realm">${escapeHtml(String(fl.realm))} / ${escapeHtml(String(fl.kind))}</span> <span class="tower-floor-outcome ${cls}">${escapeHtml(outcome)}</span></li>`;
    })
    .join("");
  return `
    <div class="card-rich card-rich-tower">
      ${richHero("⚔️", "试炼古塔 · 闯过", floors)}
      ${richStatGrid([
        ["修为增长", f["修为增长"] || ""],
        ["塔印", f["塔印"] || ""],
        ["同境界超过", f["同境界超过"] || ""],
      ])}
      ${f["本次构筑"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">构筑</span>${escapeHtml(String(f["本次构筑"]))}</span></div>` : ""}
      ${f["塔相轨迹"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">塔相</span>${escapeHtml(String(f["塔相轨迹"]))}</span></div>` : ""}
      ${f["触发奇遇"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">奇遇</span>${escapeHtml(String(f["触发奇遇"]))}</span></div>` : ""}
      ${f["遭遇词缀"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">词缀</span>${escapeHtml(String(f["遭遇词缀"]))}</span></div>` : ""}
      ${richCollapsibleList("收获", f["收获列表"] || [], 4)}
      ${floorRows ? `<div class="rich-progress"><div class="rich-progress-head"><span>逐层概要</span></div><ul class="tower-floor-list">${floorRows}</ul></div>` : ""}
    </div>
  `;
}

function renderInventoryCard(message) {
  const summary = String(message.summary || "已识别背包/资源类消息").trim();
  return `
    <div class="card-rich card-rich-loot">
      ${richHero("📦", "储物袋", "已识别")}
      <p class="muted" style="margin:0;font-size:12px;">${escapeHtml(summary)}</p>
      ${richChips([["类型", "资源快照"]])}
    </div>
  `;
}

function renderSecondSoulCard(message) {
  const summary = String(message.summary || "第二元神已结束修炼。").trim();
  return `
    <div class="card-rich card-rich-soul">
      ${richHero("🔮", "第二元神", "归位")}
      <p class="muted" style="margin:0;font-size:12px;">${escapeHtml(summary)}</p>
      ${richChips([["阶段", "回归窍中温养"], ["建议", "去 actions 区抉择 / 修炼"]])}
    </div>
  `;
}

function renderTiantiPanelCard(message) {
  const f = message.fields || {};
  const raw = String(message.raw || "");
  const stepProgress =
    f["阶进度数值"] ||
    parseProgressObject(f["阶进度"]) ||
    parseProgressObject(rawMatch(raw, /当前(?:云阶)?进度[:：]\s*(\d+\s*\/\s*\d+)/));
  const gangfeng = f["罡风淬体"] || rawMatch(raw, /罡风淬体[:：]\s*([^\n。]+)/);
  const currentStep = rawMatch(raw, /踏上了第\s*(\d+)\s*阶/) || rawMatch(raw, /第\s*(\d+)\s*阶云阶/);
  const gain = rawMatch(raw, /本次获得\s*([^。\n]+)/);
  const extra = rawLineValue(raw, "额外收获");
  const heroValue = stepProgress ? `${stepProgress.current} / ${stepProgress.max} 阶` : (currentStep ? `第 ${currentStep} 阶` : "凌霄云阶");
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🪜", "登天阶", heroValue)}
      ${richStatGrid([
        ["当前阶数", currentStep ? `第 ${currentStep} 阶` : ""],
        ["周天", f["周天"] || ""],
        ["罡风淬体", gangfeng || ""],
        ["问心", f["问心"] || ""],
        ["登阶冷却", f["登阶冷却"] || ""],
        ["本次获得", gain || ""],
        ["额外收获", extra || ""],
      ])}
      ${stepProgress ? richProgress("云阶进度", stepProgress.current, stepProgress.max, "阶") : ""}
    </div>
  `;
}

function renderStargazerPanelCard(message) {
  const f = message.fields || {};
  const slots = Array.isArray(f["引星盘"]) ? f["引星盘"] : [];
  const slotLines = slots.map((slot) => `${slot.idx || "?"} 号：${slot.status || ""}`);
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🔭", "观星台", f["引星盘总数"] ? `${f["引星盘总数"]} 座` : `${slots.length || 0} 座`)}
      ${richStatGrid([
        ["引星盘总数", f["引星盘总数"] || ""],
        ["可用星盘", slots.filter((slot) => /可|空|未/.test(String(slot.status || ""))).length || ""],
      ])}
      ${richCollapsibleList("引星盘状态", slotLines, 6)}
    </div>
  `;
}

function renderStargazerResultCard(message) {
  const f = message.fields || {};
  const result = f["演化结果"] || f["下次事件"] || message.summary || "天机演化";
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🌌", message.title || "天机", String(result))}
      ${richStatGrid([
        ["下次事件", f["下次事件"] || ""],
        ["天命所归", f["天命所归"] || ""],
        ["演化结果", f["演化结果"] || ""],
      ])}
      ${richChips([["来源", displaySource(message.source)]])}
    </div>
  `;
}

function renderSmallWorldPanelCard(message) {
  const f = message.fields || {};
  const faith = parseProgressObject(f["信仰"]);
  const prayer = f["凡人祈愿"] || rawLineValue(message.raw, "凡人祈愿");
  const wait = f["下次祈愿"] || rawMatch(message.raw, /下一次祈愿感应需等待[:：]\s*([^)）\n]+)/);
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🌍", "小世界", f["主人"] ? `${f["主人"]}` : "凡间状态")}
      ${richStatGrid([
        ["待收香火", f["待收香火"] || ""],
        ["香火库存", f["香火库存"] || ""],
        ["凡人祈愿", prayer || ""],
        ["下次祈愿", wait || ""],
      ])}
      ${faith ? richProgress("信仰", faith.current, faith.max) : ""}
      ${richChips([["原则", "祈愿优先，香火只是刷新工具"]])}
    </div>
  `;
}

function renderConcubinePanelCard(message) {
  const f = message.fields || {};
  const fragments = parseProgressObject(f["拼片"]);
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🌙", f["类型"] || "侍妾", f["侍妾"] || "未识别")}
      ${richStatGrid([
        ["状态", f["状态"] || ""],
        ["情缘值", f["情缘值"] || ""],
        ["当前誓约", f["当前誓约"] || ""],
        ["入梦寻图", f["入梦寻图冷却"] || ""],
        ["共历心劫", f["共历心劫冷却"] || ""],
        ["天机代卜", f["天机代卜冷却"] || ""],
      ])}
      ${fragments ? richProgress("虚天残图拼片", fragments.current, fragments.max) : ""}
    </div>
  `;
}

function renderTreePanelCard(message) {
  const raw = String(message.raw || "");
  const progress = parseProgressObject(rawMatch(raw, /进度[:：][\s\S]*?(\d+(?:\.\d+)?)%/), 100);
  const trend = rawLineValue(raw, "倾向");
  const current = rawLineValue(raw, "你的当前状态");
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🌲", "灵眼之树", rawLineValue(raw, "阶段") || "落云宗灵树")}
      ${richStatGrid([
        ["环境", rawLineValue(raw, "环境") || ""],
        ["阶段", rawLineValue(raw, "阶段") || ""],
        ["倾向", trend || ""],
        ["灵纹", rawLineValue(raw, "灵纹") || ""],
        ["本轮走向", rawLineValue(raw, "本轮走向") || ""],
        ["我的状态", current || ""],
      ])}
      ${progress ? richProgress("成熟进度", progress.current, progress.max, "%") : ""}
      ${rawLineValue(raw, "若此刻成熟") ? richChips([["成熟收益", rawLineValue(raw, "若此刻成熟")]]) : ""}
    </div>
  `;
}

function renderTreeHarvestCard(message) {
  const f = message.fields || {};
  return `
    <div class="card-rich card-rich-loot">
      ${richHero("🌰", "灵树采摘", f["采摘果实"] || "已采摘")}
      ${richStatGrid([
        ["果实", f["采摘果实"] || ""],
        ["修为增长", f["修为增长"] || ""],
      ])}
    </div>
  `;
}

function renderPetPanelCard(message) {
  const f = message.fields || {};
  const raw = String(message.raw || "");
  const resonance = rawLineValue(raw, "当前共鸣");
  const bonus = rawLineValue(raw, "当前总加成");
  const cost = rawLineValue(raw, "- 消耗") || rawLineValue(raw, "消耗");
  return `
    <div class="card-rich card-rich-loot">
      ${richHero("🗡️", message.title || "器灵", message.summary || "已记录")}
      ${richStatGrid([
        ["默契", f["默契"] != null ? `+${f["默契"]}` : rawLineValue(raw, "- 默契提升")],
        ["经验", f["经验"] != null ? `+${f["经验"]}` : rawLineValue(raw, "- 经验提升")],
        ["当前共鸣", resonance || ""],
        ["总加成", bonus || ""],
        ["消耗", cost || ""],
      ])}
      ${richChips([["类型", (message.tags || []).join(" / ")]])}
    </div>
  `;
}

function renderTaiyiPanelCard(message) {
  const f = message.fields || {};
  const value = f["节点"] || f["五行"] || message.summary || "太一记录";
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🧭", message.title || "太一", String(value))}
      ${richStatGrid([
        ["五行", f["五行"] || ""],
        ["空间节点", f["节点"] || ""],
      ])}
      ${richChips([["状态", message.summary || ""], ["提醒", "只展示，不自动发搜寻 / 定星"]])}
    </div>
  `;
}

function rawMatch(raw, regex) {
  const m = regex.exec(String(raw || ""));
  return m ? String(m[1] || "").trim() : "";
}

function rawLineValue(raw, label) {
  const escaped = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]+)`).exec(String(raw || ""));
  return m ? m[1].trim() : "";
}

function parseProgressObject(value, implicitMax = 0) {
  if (!value) return null;
  if (typeof value === "object" && Number(value.current) >= 0 && Number(value.max) > 0) {
    return { current: Number(value.current), max: Number(value.max) };
  }
  const text = String(value);
  const pair = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
  if (pair) {
    return { current: Number(pair[1]), max: Number(pair[2]) };
  }
  const single = /(\d+(?:\.\d+)?)/.exec(text);
  if (single && implicitMax > 0) {
    return { current: Number(single[1]), max: Number(implicitMax) };
  }
  return null;
}

function renderDungeonCard(message) {
  const f = message.fields || {};
  const tags = message.tags || [];
  const title = String(message.title || "副本消息").trim();
  const dungeonName = String(f["副本名"] || "").trim()
    || (/加入副本|副本房间/.test(title) ? "副本" : title.replace(/(开启|推进)$/, ""))
    || "副本";
  const dungeonId = f["副本ID"] ? String(f["副本ID"]).trim() : "—";
  const stage = f["阶段"] ? String(f["阶段"]).trim() : "";
  const status = String(f["状态"] || "").trim()
    || (tags.includes("失败") ? "加入失败" : tags.includes("解散") ? "已解散" : tags.includes("可加入") ? "可加入" : tags.includes("加入") ? "已加入" : "副本消息");
  const heroValue = dungeonId !== "—" ? `#${dungeonId}` : (stage || status);
  const paths = Array.isArray(f["可选路径"]) ? f["可选路径"] : [];
  const successExamples = Array.isArray(f["历史顺例"]) ? f["历史顺例"] : [];
  const failureExamples = Array.isArray(f["历史反例"]) ? f["历史反例"] : [];
  const summary = String(message.summary || "").trim();
  return `
    <div class="card-rich card-rich-dungeon">
      ${richHero("🛡️", `${dungeonName} · ${status}`, heroValue)}
      ${summary ? `<p class="muted" style="margin:0;font-size:12px;">${escapeHtml(summary)}</p>` : ""}
      ${richStatGrid([
        ["副本ID", dungeonId !== "—" ? dungeonId : ""],
        ["阶段", stage],
        ["卦象", f["卦象"] || ""],
        ["行运建议", f["行运建议"] || ""],
        ["路策判定", f["路策判定"] || ""],
        ["开门人", f["开门人"] || ""],
        ["人数上限", f["人数上限"] || ""],
        ["失败原因", f["失败原因"] || ""],
      ])}
      ${richChips([
        ["依据", f["建议依据"] || ""],
        ["置信", f["建议置信"] || ""],
        ["队伍契合", f["队伍契合"] || ""],
        ["路线", f["路线"] || ""],
        ["阵策", f["阵策"] || ""],
        ["静场令", f["静场令"] || ""],
        ["消耗道具", f["消耗道具"] || ""],
        ["操作", (message.actions || []).length ? "下方按钮手动发送" : ""],
      ])}
      ${richCollapsibleList("可选路径", paths, 3)}
      ${richCollapsibleList("历史顺例", successExamples, 3)}
      ${richCollapsibleList("历史反例", failureExamples, 3)}
    </div>
  `;
}

function renderRiskCard(message) {
  const summary = String(message.summary || "检测到高危消息,需要玩家手动处理。").trim();
  const f = message.fields || {};
  const handling = f["处理方式"] ? formatFieldValue(f["处理方式"]) : "人工查看原文";
  return `
    <div class="card-rich card-rich-risk">
      ${richHero("⚠️", "风险提醒", "需人工介入")}
      <p style="margin:0;font-size:12.5px;color:#fecaca;">${escapeHtml(summary)}</p>
      ${richChips([["处理方式", handling]])}
    </div>
  `;
}

function renderGenericGameplayCard(message) {
  const f = message.fields || {};
  const title = String(message.title || "修仙事件").trim();
  const icon = genericGameplayIcon(message);
  const heroValue = String(
    f["状态"] ||
    f["阶段"] ||
    f["结果"] ||
    f["当前境界"] ||
    f["副本名"] ||
    f["玩法"] ||
    clipGraphemes(String(message.summary || "").replace(/\s+/g, " ").trim(), 24) ||
    "已记录"
  );
  const entries = Object.entries(f).filter(([, value]) => isPresentValue(value));
  const primary = entries.slice(0, 10);
  const rest = entries.slice(10).map(([key, value]) => `${key}: ${formatFieldValue(value)}`);
  const chips = [
    ["来源", displaySource(message.source)],
    ["频道", genericGameplayChannelLabel(message)],
    ["动作", (message.actions || []).length ? `${message.actions.length} 个候选` : ""],
  ];
  const summary = String(message.summary || "").trim();
  return `
    <div class="card-rich card-rich-generic ${escapeAttr(genericGameplayClass(message))}">
      ${richHero(icon, title, heroValue)}
      ${summary ? `<p class="rich-card-summary">${escapeHtml(summary)}</p>` : ""}
      ${richStatGrid(primary.map(([key, value]) => [key, formatFieldValue(value)]))}
      ${richChips(chips)}
      ${richCollapsibleList("更多字段", rest, 4)}
    </div>
  `;
}

function genericGameplayIcon(message) {
  const title = String(message.title || "");
  const channels = message.channels || [message.channel];
  if (/灵树|小世界|侍妾|器灵|法宝|灵兽|观星|星盘|定星|空间节点/.test(title) || channels.includes("home")) return "🏡";
  if (/闭关|元婴|元神|修炼|闯塔|登天阶|悟道/.test(title) || channels.includes("training")) return "🧘";
  if (/储物袋|资源|交易|货摊|战利品|野外/.test(title) || channels.includes("resource")) return "📦";
  if (channels.includes("risk")) return "⚠️";
  return "✨";
}

function genericGameplayClass(message) {
  const title = String(message.title || "");
  const channels = message.channels || [message.channel];
  if (/灵树|小世界|侍妾|器灵|法宝|灵兽|观星|星盘|定星|空间节点/.test(title) || channels.includes("home")) return "home";
  if (/闭关|元婴|元神|修炼|闯塔|登天阶|悟道/.test(title) || channels.includes("training")) return "training";
  if (/储物袋|资源|交易|货摊|战利品|野外/.test(title) || channels.includes("resource")) return "resource";
  if (channels.includes("risk")) return "risk";
  return "system";
}

function genericGameplayChannelLabel(message) {
  const channels = message.channels || [message.channel];
  const known = new Map((state.channels || []).map((channel) => [channel.key, channel.label]));
  return channels.map((channel) => known.get(channel) || channel).slice(0, 3).join(" / ");
}

function renderDetailFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, value]) => isPresentValue(value));
  if (entries.length === 0) {
    return '<p class="empty inline">解析器没有从这条消息中识别出结构化字段,可以直接看 Telegram 原文。</p>';
  }
  const items = entries
    .map(
      ([key, value]) => `
        <div>
          <span>${escapeHtml(key)}</span>
          <strong>${escapeHtml(formatFieldValue(value))}</strong>
        </div>
      `
    )
    .join("");
  return `<div class="field-grid">${items}</div>`;
}

function isPresentValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string" && value.trim() === "") {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function formatFieldValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => formatFieldValue(item)).join("、");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => isPresentValue(v))
      .map(([k, v]) => `${k}：${formatFieldValue(v)}`)
      .join("，");
  }
  return String(value);
}

function renderDetailActions(message) {
  const actions = message.actions || [];
  if (actions.length === 0) {
    return '<p class="empty inline">这条消息没有解析出候选回复。需要操作时，直接在底部发送栏输入。</p>';
  }
  const cards = actions
    .map((action, index) => {
      const context = renderActionContextLine(action);
      const notice = state.draftNoticeByMessageId.get(`${message.id}:${index}`);
      const command = String(action.command || "").trim();
      return `
        <div class="action-draft" data-action-index="${index}">
          <div class="action-draft-head">
            <strong>${escapeHtml(quickActionLabel(action) || action.label || "动作")}</strong>
            ${context ? `<small>${escapeHtml(context)}</small>` : ""}
          </div>
          <button type="button" class="action-draft-command" data-action-button="compose"
                  data-action-index="${index}" title="填到底部输入栏确认发送">${escapeHtml(command)}</button>
          <div class="action-draft-buttons">
            <button type="button" class="action-primary" data-action-button="compose"
                    data-action-index="${index}">填入发送栏</button>
            <button type="button" class="action-secondary" data-action-button="copy" data-action-index="${index}">复制</button>
            <details class="action-draft-more">
              <summary>更多</summary>
              <div>
                <button type="button" class="action-tertiary" data-action-button="enqueue" data-action-index="${index}">入草稿箱</button>
                <button type="button" class="action-tertiary" data-action-button="plan" data-action-index="${index}">发送计划</button>
              </div>
            </details>
          </div>
          ${notice ? `<p class="action-draft-notice ${notice.kind}">${escapeHtml(notice.text)}</p>` : ""}
        </div>
      `;
    })
    .join("");
  return `<div class="action-list">${cards}</div>`;
}

function renderActionContextLine(action) {
  const parts = [];
  if (action.chat_id !== undefined && action.chat_id !== null) {
    parts.push(`群 ${action.chat_id}`);
  }
  if (action.reply_to_msg_id !== undefined && action.reply_to_msg_id !== null) {
    parts.push(`回复 ${action.reply_to_msg_id}`);
  }
  if (action.identity_id !== undefined && action.identity_id !== null) {
    parts.push(`身份 ${action.identity_id}`);
  }
  if (action.account_local_id) {
    parts.push(`账号 ${action.account_local_id}`);
  }
  return parts.join("｜");
}

function bindDetailActions(message) {
  const actions = message.actions || [];
  detailPanel.querySelector('[data-detail-message-action="reply"]')?.addEventListener("click", () => {
    setDirectSendReplyFromMessage(message);
  });
  detailPanel.querySelector('[data-detail-message-action="copy-text"]')?.addEventListener("click", async (event) => {
    const text = String(message.raw || message.summary || message.title || "").trim();
    if (!text) {
      showSkillToast("这条消息没有可复制文本", "err");
      return;
    }
    await copyCommandToClipboard(text, event.currentTarget);
  });
  detailPanel.querySelector('[data-detail-message-action="fill-source"]')?.addEventListener("click", () => {
    const text = String(message.raw || "").trim();
    if (!text) {
      showSkillToast("这条消息没有原文", "err");
      return;
    }
    fillDirectSendComposer(text, {
      replyContext: null,
      statusText: "已把原文填入发送框，请确认后发送。",
      statusKind: "info",
    });
  });
  detailPanel.querySelector('[data-detail-action="focus-archive-exact"]')?.addEventListener("click", () => {
    openFocusArchiveModal(message, "exact");
  });
  detailPanel.querySelector('[data-detail-action="focus-archive-contains"]')?.addEventListener("click", () => {
    openFocusArchiveModal(message, "contains");
  });
  detailPanel.querySelector('[data-detail-action="focus-mute-toggle"]')?.addEventListener("click", async (event) => {
    await toggleFocusMuteSender(message, event.currentTarget);
  });
  detailPanel.querySelectorAll('[data-rich-collapse="1"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const list = btn.previousElementSibling;
      if (!list) return;
      const hidden = list.hasAttribute("hidden");
      if (hidden) {
        list.removeAttribute("hidden");
        btn.textContent = "收起";
      } else {
        list.setAttribute("hidden", "");
        btn.textContent = `展开剩余 ${list.children.length} 条`;
      }
    });
  });
  detailPanel.querySelectorAll("[data-action-button]").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.actionIndex || 0);
      const action = actions[index];
      if (!action) {
        return;
      }
      const kind = button.dataset.actionButton;
      const planPanel = detailPanel.querySelector("#outboxPlanPanel");
      const noticeKey = `${message.id}:${index}`;
      try {
        if (kind === "compose") {
          fillDirectSendComposer(action.command, {
            identityId: action.identity_id,
            replyContext: directReplyContextFromAction(action, message),
            statusText: "已填入输入框，请确认内容后发送。",
            statusKind: "info",
          });
          return;
        }
        if (kind === "copy") {
          await copyCommandToClipboard(action.command, button);
          return;
        }
        if (kind === "plan") {
          button.disabled = true;
          const plan = await planOutboxAction(action);
          renderOutboxPlan(plan, action, planPanel);
          return;
        }
        if (kind === "enqueue") {
          button.disabled = true;
          const result = await createOutboxDraft(action, message.id);
          if (result.ok && result.draft) {
            state.draftNoticeByMessageId.set(noticeKey, {
              kind: "ok",
              text: `已入队草稿 ${result.draft.id || ""}，可在草稿箱里人工确认或删除。`,
            });
          } else {
            state.draftNoticeByMessageId.set(noticeKey, {
              kind: "warn",
              text: result.error || "入队草稿失败",
            });
          }
          renderDetail();
          return;
        }
      } catch (error) {
        if (kind === "plan") {
          renderOutboxPlanError(error, planPanel);
        } else {
          state.draftNoticeByMessageId.set(noticeKey, {
            kind: "warn",
            text: error.message || "操作失败",
          });
          renderDetail();
        }
      } finally {
        if (kind !== "copy") {
          button.disabled = false;
        }
      }
    });
  });
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
  await window.MiniwebViews.outbox.openDraftsModal({
    copyCommandToClipboard,
    deleteOutboxDraft,
    fetchMessageById,
    findMessageById: (sourceId) => state.messages.find((item) => item.id === sourceId),
    getDrafts: () => state.outboxDrafts || [],
    loadOutboxDrafts,
    selectMessage: (message) => setWorkspaceSelectedMessage(message, { rerenderList: true }),
  });
}

function channelLabel(key) {
  return state.channels.find((channel) => channel.key === key)?.label || key;
}

function renderOutboxPlan(plan, action, container) {
  if (!container) {
    return;
  }
  if (!plan.ok) {
    renderOutboxPlanError(new Error(plan.error || "发送计划生成失败"), container);
    return;
  }

  const missingText = (plan.missing || []).map(missingLabel).join("、");
  const statusText = plan.resolved ? "已解析" : `待补齐：${missingText || "上下文"}`;
  const statusClass = plan.resolved ? "ok" : "warn";
  container.innerHTML = `
    <div class="outbox-plan">
      <div class="outbox-plan-head">
        <h5>发送计划</h5>
        <span class="status-pill ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <div class="plan-grid">
        <div><span>命令</span><code>${escapeHtml(plan.command)}</code></div>
        <div><span>目标</span><strong>${escapeHtml(planTargetLabel(plan))}</strong></div>
        <div><span>回复</span><strong>${escapeHtml(plan.reply_to_msg_id ?? "不回复特定消息")}</strong></div>
        <div><span>身份</span><strong>${escapeHtml(planIdentityLabel(plan))}</strong></div>
        <div><span>账号</span><strong>${escapeHtml(planAccountLabel(plan))}</strong></div>
        <div><span>发送</span><strong>${plan.can_send ? "可人工确认发送" : "仅复制/计划"}</strong></div>
      </div>
      <div class="plan-controls">
        <label>
          <span>改用身份</span>
          <select data-plan-field="identity_id">
            ${renderPlanIdentityOptions(plan.identity_id)}
          </select>
        </label>
        <label>
          <span>改用账号</span>
          <select data-plan-field="account_local_id">
            ${renderPlanAccountOptions(plan.account_local_id)}
          </select>
        </label>
      </div>
      <div class="form-actions outbox-actions">
        <button type="button" data-plan-action="copy">复制命令</button>
        <button type="button" data-plan-action="replan">重新解析</button>
      </div>
      <p>${escapeHtml(plan.note || "动作只生成手动计划，不会自动发送。")}</p>
    </div>
  `;
  bindOutboxPlanControls(container, action);
}

function renderOutboxPlanError(error, container) {
  if (!container) {
    return;
  }
  container.innerHTML = `
    <div class="outbox-plan">
      <div class="outbox-plan-head">
        <h5>发送计划</h5>
        <span class="status-pill risk">失败</span>
      </div>
      <p class="error">${escapeHtml(error.message)}</p>
    </div>
  `;
}

function bindOutboxPlanControls(container, action) {
  const copyButton = container.querySelector('[data-plan-action="copy"]');
  const replanButton = container.querySelector('[data-plan-action="replan"]');
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(action.command);
        copyButton.textContent = "已复制";
        setTimeout(() => {
          copyButton.textContent = "复制命令";
        }, 1200);
      } catch (error) {
        copyButton.textContent = "复制失败";
      }
    });
  }
  if (replanButton) {
    replanButton.addEventListener("click", async () => {
      replanButton.disabled = true;
      try {
        const nextAction = actionWithPlanOverrides(action, container);
        const plan = await planOutboxAction(nextAction);
        renderOutboxPlan(plan, nextAction, container);
      } catch (error) {
        renderOutboxPlanError(error, container);
      } finally {
        replanButton.disabled = false;
      }
    });
  }
}

function actionWithPlanOverrides(action, container) {
  const nextAction = { ...action };
  const identityValue = container.querySelector('[data-plan-field="identity_id"]')?.value || "";
  const accountValue = container.querySelector('[data-plan-field="account_local_id"]')?.value || "";
  if (identityValue) {
    nextAction.identity_id = Number(identityValue);
  } else {
    delete nextAction.identity_id;
  }
  if (accountValue) {
    nextAction.account_local_id = accountValue;
  } else {
    delete nextAction.account_local_id;
  }
  return nextAction;
}

function renderPlanIdentityOptions(selectedId) {
  const selected = selectedId !== undefined && selectedId !== null ? String(selectedId) : "";
  const options = state.identities
    .map((identity) => {
      const value = String(identity.send_as_id);
      const label = `${identity.label || identity.username || value}｜${value}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `<option value="" ${selected ? "" : "selected"}>不指定身份</option>${options}`;
}

function renderPlanAccountOptions(selectedLocalId) {
  const selected = String(selectedLocalId || "");
  const options = state.accounts
    .map((account) => {
      const value = account.local_id;
      const label = `${account.label || value}｜${value}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `<option value="" ${selected ? "" : "selected"}>按身份绑定/不指定</option>${options}`;
}

function missingLabel(key) {
  const labels = {
    identity: "身份",
    account: "发送账号",
    target_chat: "目标群",
  };
  return labels[key] || key;
}

function planTargetLabel(plan) {
  if (plan.chat_id !== undefined && plan.chat_id !== null) {
    return `群 ${plan.chat_id}`;
  }
  if (plan.target_chat) {
    return plan.target_chat;
  }
  return "未解析";
}

function planIdentityLabel(plan) {
  if (plan.identity) {
    return `${plan.identity.label || plan.identity.username || plan.identity.send_as_id}｜${plan.identity.send_as_id}`;
  }
  if (plan.identity_id !== undefined && plan.identity_id !== null) {
    return `未登记身份 ${plan.identity_id}`;
  }
  return "未指定";
}

function planAccountLabel(plan) {
  if (plan.account) {
    return `${plan.account.label || plan.account.local_id}｜${plan.account.local_id}`;
  }
  if (plan.account_local_id) {
    return `未保存账号 ${plan.account_local_id}`;
  }
  return "未指定";
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

function renderSettings(settings) {
  state.detailMode = "message";
  const botIds = (settings.game_bot_ids || []).join("\n");
  const savedSecrets = settings.saved_secrets || {};
  const dialogOptions = renderDialogOptions(settings.target_chat);
  const topicOptions = renderTopicOptions(settings.target_topic_id);
  const accountCount = state.accounts.length;
  const accountLimit = state.accountLimit || 0;
  const identityCount = state.identities.length;
  const identityLimit = state.identityLimit || 0;
  const dialog = openModal({
    title: "接入配置",
    body: `
    <form id="settingsForm" class="settings-form">
      <div class="detail-block">
        <h4>Telegram 接入</h4>
        <p>默认接入配置保存在本地 SQLite，暂不做加密。采集监听只需要一个账号，用来把游戏群消息写入本地消息箱。</p>
        <p>登录状态：${escapeHtml(settings.login_status || "idle")} ${settings.login_account_id ? `｜账号 ${escapeHtml(settings.login_account_id)}` : ""}</p>
        ${settings.login_message ? `<p>${escapeHtml(settings.login_message)}</p>` : ""}
        <p id="listenerStatusText">监听状态：${escapeHtml(settings.listener_status || "stopped")} ${settings.listener_message ? `｜${escapeHtml(settings.listener_message)}` : ""}</p>
        <p>多账号：${accountCount}${accountLimit ? ` / ${accountLimit}` : ""} 个已保存</p>
        <p>游戏身份：${identityCount}${identityLimit ? ` / ${identityLimit}` : ""} 个已保存</p>
        ${state.settingsNotice ? `<p class="settings-notice">${escapeHtml(state.settingsNotice)}</p>` : ""}
      </div>

      <div class="form-grid">
        <label>
          <span>API ID</span>
          <input name="api_id" inputmode="numeric" value="${escapeAttr(settings.api_id)}" placeholder="Telegram API ID" />
        </label>
        <label>
          <span>API Hash</span>
          <input
            name="api_hash"
            value=""
            placeholder="${savedSecrets.api_hash ? "已保存，留空不变；重新填写则覆盖" : "Telegram API Hash"}"
            autocomplete="off"
          />
        </label>
        <label>
          <span>手机号</span>
          <input name="phone" value="${escapeAttr(settings.phone)}" placeholder="+8613800138000" />
        </label>
        <label>
          <span>Session 名称</span>
          <input name="session_name" value="${escapeAttr(settings.session_name)}" placeholder="miniweb_session" />
        </label>
      </div>

      <div class="picker-grid">
        <div class="picker-field">
          <div class="picker-head">
            <span>目标群 / 频道</span>
            <button type="button" data-telegram-action="load-dialogs">读取群 / 频道</button>
          </div>
          <select data-select-target="target_chat">
            <option value="">未选择</option>
            ${dialogOptions}
          </select>
          <input name="target_chat" value="${escapeAttr(settings.target_chat)}" placeholder="可手动填写 -100... 或 @username" />
        </div>

        <div class="picker-field">
          <div class="picker-head">
            <span>话题</span>
            <button type="button" data-telegram-action="load-topics">读取话题</button>
          </div>
          <select data-select-target="target_topic_id">
            <option value="">全部话题 / 不限制</option>
            ${topicOptions}
          </select>
          <input name="target_topic_id" inputmode="numeric" value="${escapeAttr(settings.target_topic_id)}" placeholder="可留空，也可手动填写话题 ID" />
        </div>
      </div>

      <label class="stacked-field">
        <span>已知天尊 sender IDs</span>
        <textarea name="game_bot_ids" rows="6" placeholder="-1003983937918&#10;7900199668">${escapeHtml(botIds)}</textarea>
      </label>

      <div class="form-grid">
        <label>
          <span>代理类型</span>
          <select name="proxy_type">
            <option value="" ${settings.proxy_type ? "" : "selected"}>不使用</option>
            <option value="http" ${settings.proxy_type === "http" ? "selected" : ""}>HTTP</option>
            <option value="socks5" ${settings.proxy_type === "socks5" ? "selected" : ""}>SOCKS5</option>
          </select>
        </label>
        <label>
          <span>代理 host:port</span>
          <input name="proxy_host" value="${escapeAttr(settings.proxy_host)}" placeholder="127.0.0.1:7890" />
        </label>
        <label>
          <span>代理用户名</span>
          <input name="proxy_username" value="${escapeAttr(settings.proxy_username)}" />
        </label>
        <label>
          <span>代理密码</span>
          <input
            name="proxy_password"
            type="password"
            value=""
            placeholder="${savedSecrets.proxy_password ? "已保存，留空不变；重新填写则覆盖" : ""}"
            autocomplete="off"
          />
        </label>
      </div>

      <div class="form-actions">
        <button type="button" data-login-action="start">发送验证码</button>
        <button type="button" data-login-action="cancel">取消登录</button>
        <button type="submit">保存配置</button>
      </div>

      <div class="detail-block notify-section">
        <h4>🔔 通知设置</h4>
        <p class="muted" style="font-size:12px;">关键事件(风险/突破/奇遇 prompt 等)可推送到独立的 Telegram bot。
        后续会加 Bark / 钉钉 / 浏览器 push。</p>
        <label class="toggle-field">
          <input type="checkbox" name="notify_enabled" ${settings.notify_enabled ? "checked" : ""} />
          <span>启用通知</span>
        </label>
        <div class="form-grid">
          <label>
            <span>Telegram Bot Token</span>
            <input
              name="notify_tg_bot_token"
              value=""
              placeholder="${savedSecrets.notify_tg_bot_token ? "已保存,留空不变" : "BotFather 拿到的 token,形如 123:ABC..."}"
              autocomplete="off"
            />
          </label>
          <label>
            <span>Telegram Chat ID</span>
            <input name="notify_tg_chat_id" value="${escapeAttr(settings.notify_tg_chat_id || '')}" placeholder="接收方的 chat ID(私聊 = user_id;群 = -100xxx)" />
          </label>
        </div>
        <div class="notify-event-grid" id="notifyEventGrid">
          <p class="muted" style="font-size:11px;">加载中…</p>
        </div>
        <div class="form-actions">
          <button type="button" data-notify-action="test">发测试通知</button>
        </div>
        <p id="notifyTestResult" class="muted" style="font-size:12px;"></p>
      </div>

      <div class="login-verify">
        <label>
          <span>验证码</span>
          <input name="login_code" placeholder="Telegram 验证码" />
        </label>
        <label>
          <span>两步验证密码</span>
          <input name="login_password" type="password" placeholder="需要时填写" />
        </label>
        <button type="button" data-login-action="verify">验证登录</button>
      </div>
    </form>

    <div class="detail-block account-manager">
      <div class="manager-head">
        <div>
          <h4>Telegram 账号</h4>
          <p>每个账号是一份 Telegram session,只读它说话。同时只能选一个账号采集消息进消息箱,其他账号留作以备身份归属用。</p>
        </div>
        <button type="button" class="primary" data-account-action="open-new">+ 登录账号</button>
      </div>
      <div id="accountList" class="account-list slim">
        ${renderAccountList()}
      </div>
    </div>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  const root = dialog.querySelector(".modal-body") || dialog;

  loadListenerStatus()
    .then((listener) => {
      const target = root.querySelector("#listenerStatusText");
      if (target) {
        target.textContent = `监听状态：${listener.status} ${listener.message || ""}`;
      }
    })
    .catch(() => {});

  // 加载通知事件列表 + 绑测试按钮
  _hydrateNotifySection(settings, root);

  root.querySelector("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const saved = await saveCurrentSettingsFromForm(event.currentTarget);
      state.settingsNotice = "配置已保存";
      renderSettings(saved);
      showSkillToast("接入配置已保存", "ok");
    } catch (error) {
      showError(error);
    }
  });

  root.querySelectorAll("[data-select-target]").forEach((select) => {
    select.addEventListener("change", () => {
      const form = root.querySelector("#settingsForm");
      const input = form.querySelector(`[name="${select.dataset.selectTarget}"]`);
      if (input) {
        input.value = select.value;
      }
      if (select.dataset.selectTarget === "target_chat") {
        state.telegramTopics = [];
        const topicInput = form.querySelector('[name="target_topic_id"]');
        const topicSelect = form.querySelector('[data-select-target="target_topic_id"]');
        if (topicInput && topicSelect) {
          topicInput.value = "";
          topicSelect.value = "";
        }
      }
    });
  });

  root.querySelectorAll("[data-telegram-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const form = root.querySelector("#settingsForm");
      button.disabled = true;
      try {
        await saveCurrentSettingsFromForm(form);
        if (button.dataset.telegramAction === "load-dialogs") {
          state.settingsNotice = "正在读取当前账号可见的群 / 频道...";
          await loadTelegramDialogs();
          state.settingsNotice = state.telegramDialogs.length
            ? `已读取 ${state.telegramDialogs.length} 个群 / 频道，请从下拉框选择。`
            : "没有读取到可用群 / 频道。";
        } else if (button.dataset.telegramAction === "load-topics") {
          const targetChat = new FormData(form).get("target_chat");
          if (!String(targetChat || "").trim()) {
            throw new Error("请先选择目标群 / 频道");
          }
          state.settingsNotice = "正在读取该群的话题...";
          await loadTelegramTopics(targetChat);
          state.settingsNotice = state.telegramTopics.length
            ? `已读取 ${state.telegramTopics.length} 个话题，请从下拉框选择。`
            : "该群没有读取到话题，或不是话题群。";
        }
        const latest = await loadSettings();
        renderSettings(latest);
      } catch (error) {
        state.settingsNotice = error.message;
        const latest = state.settings || settings;
        renderSettings(latest);
      }
    });
  });

  root.querySelectorAll("[data-login-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const form = root.querySelector("#settingsForm");
      try {
        if (button.dataset.loginAction === "start") {
          await saveCurrentSettingsFromForm(form);
          const result = await postJson("/api/login/start", {});
          if (!result.ok) {
            throw new Error(result.error || "发送验证码失败");
          }
        } else if (button.dataset.loginAction === "verify") {
          const result = await postJson("/api/login/verify", {
            code: new FormData(form).get("login_code"),
            password: new FormData(form).get("login_password"),
          });
          if (!result.ok && result.status !== "need_2fa") {
            throw new Error(result.error || "登录验证失败");
          }
        } else if (button.dataset.loginAction === "cancel") {
          const result = await postJson("/api/login/cancel", {});
          if (!result.ok) {
            throw new Error(result.error || "取消失败");
          }
        }
        const latest = await loadSettings();
        renderSettings(latest);
      } catch (error) {
        showError(error);
      }
    });
  });

  bindAccountControls(root);
}

function renderAccountList() {
  if (!state.accounts.length) {
    return `<p class="empty inline">还没有 Telegram 账号。点右上角「+ 登录账号」把账号挂上来,把消息搬进消息箱。</p>`;
  }
  const running = state.listenerSummary?.running || {};
  const collector = state.listenerSummary?.collector || "";
  return state.accounts
    .map((account) => {
      const listener = running[account.local_id] || {};
      const listenerStatus = listener.status || account.listener_status || "stopped";
      const isCollecting = collector === account.local_id || listenerStatus === "running" || listenerStatus === "starting" || listenerStatus === "reconnecting";
      const loginStatus = account.login_status || "idle";
      const loginPill = renderAccountStatusPill(loginStatus);
      const collectPill = isCollecting
        ? (listenerStatus === "reconnecting"
          ? '<span class="status-pill warn">重连中</span>'
          : '<span class="status-pill ok">采集中</span>')
        : listenerStatus === "error"
          ? `<span class="status-pill risk">采集出错</span>`
          : '<span class="status-pill">未采集</span>';
      const subtitle = [
        account.phone || "未填手机号",
        account.account_id ? `account_id ${account.account_id}` : "",
      ]
        .filter(Boolean)
        .join("｜");
      return `
        <article class="account-row" data-account-id="${escapeAttr(account.local_id)}">
          <span class="account-row-dot ${isCollecting ? "live" : loginStatus === "done" ? "ok" : loginStatus === "error" ? "warn" : "idle"}" aria-hidden="true"></span>
          <div class="account-row-body">
            <div class="account-row-title">
              <strong>${escapeHtml(account.label || account.local_id)}</strong>
              <span class="account-row-meta">${escapeHtml(subtitle)}</span>
            </div>
            <div class="account-row-pills">
              ${loginPill}
              ${collectPill}
            </div>
          </div>
          <div class="account-row-actions">
            <label class="switch" title="切到这个账号采集消息;同时只能一个">
              <input type="checkbox" data-account-action="toggle-collect" data-account-id="${escapeAttr(account.local_id)}" ${isCollecting ? "checked" : ""} />
              <span></span>
            </label>
            <button type="button" data-account-action="open-edit" data-account-id="${escapeAttr(account.local_id)}">${loginStatus === "done" ? "编辑" : "登录"}</button>
            <button type="button" class="danger-link" data-account-action="delete" data-account-id="${escapeAttr(account.local_id)}" title="删除账号">删除</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAccountStatusPill(status) {
  if (status === "done") {
    return '<span class="status-pill ok">已登录</span>';
  }
  if (status === "waiting_code" || status === "need_2fa") {
    return `<span class="status-pill warn">${status === "need_2fa" ? "需要 2FA" : "等验证码"}</span>`;
  }
  if (status === "error") {
    return '<span class="status-pill risk">登录出错</span>';
  }
  return '<span class="status-pill">未登录</span>';
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

// 修炼状态二级菜单 — 跟身份绑定:深度闭关/元婴/第二元神 倒计时 chip
const CULTIVATION_MODULE_SPECS = [
  { key: "deep_retreat", icon: "📿", label: "深度闭关", note: "8h CD",
    fire_skill: "deep_retreat", query_skill: "deep_retreat_query" },
  { key: "yuanying",     icon: "🔮", label: "元婴",     note: "元婴初期+",
    fire_skill: "yuanying", query_skill: "yuanying_status" },
  { key: "second_soul",  icon: "🪞", label: "第二元神", note: "训练 / 抉择",
    fire_skill: "second_soul_train", query_skill: "second_soul_status" },
];

function renderCultivationModules() {
  renderCultivationModal();
  renderGameCockpit();
}

function renderCultivationModulesInto(container) {
  if (!container) return;
  const activeId = state.activeIdentityId;
  if (!activeId) {
    container.innerHTML = '<p class="empty">选一个身份后,这里显示模块状态。</p>';
    return;
  }
  const moduleStates = state.identityModuleStates.get(Number(activeId)) || [];
  const byKey = new Map(moduleStates.map((m) => [m.module_key, m]));
  const now = Date.now() / 1000;
  container.innerHTML = CULTIVATION_MODULE_SPECS.map((spec) => {
    const ms = byKey.get(spec.key);
    let timerText = "—";
    let timerCls = "muted";
    if (ms) {
      const summary = ms.summary || {};
      const st = ms.state || {};
      const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
      const ready = summary.ready === true || (nextAt > 0 && nextAt <= now) || nextAt === 0;
      if (ready) {
        timerText = "已就绪";
        timerCls = "ready";
      } else {
        const remaining = nextAt - now;
        timerText = `剩 ${fmtCountdown(remaining)}`;
        timerCls = "cooling";
        const startTs = moduleStartTs(st);
        const total = Math.max(1, nextAt - startTs);
        // 进度条占满,fill 占已经过的比例
        const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
        return _cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs);
      }
    }
    return _cultivationCardHtml(spec, timerText, timerCls, 0, 0, 0);
  }).join("");
  container.querySelectorAll("[data-cult-fire]").forEach((btn) => {
    btn.addEventListener("click", () => fillSkillIntoComposer(btn.dataset.cultFire, btn));
  });
  container.querySelectorAll("[data-cult-query]").forEach((btn) => {
    btn.addEventListener("click", () => fillSkillIntoComposer(btn.dataset.cultQuery, btn));
  });
}

function renderCultivationModal() {
  const container = modalRoot?.querySelector("#cultivationModalModules");
  if (!container) return;
  renderCultivationModulesInto(container);
}

function openCultivationModal() {
  const active = identityById(state.activeIdentityId);
  const titleSuffix = active ? `｜${active.label || active.username || active.send_as_id}` : "";
  const dialog = openModal({
    title: `修炼状态${titleSuffix}`,
    body: `
      <section class="modal-section cultivation-menu-modal">
        <div id="cultivationModalModules" class="cultivation-modules">
          <p class="empty">正在载入...</p>
        </div>
      </section>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  renderCultivationModal();
}

function _cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs) {
  const fireDisabled = timerCls === "cooling" ? "disabled" : "";
  return `
    <div class="cult-card ${timerCls}" data-module="${spec.key}">
      <div class="cult-card-head">
        <span class="cult-icon">${spec.icon}</span>
        <span class="cult-label">${escapeHtml(spec.label)}</span>
        <span class="cult-timer ${timerCls}"
              data-cult-timer="1"
              data-next-at="${nextAt}"
              data-start-at="${startTs}">${escapeHtml(timerText)}</span>
      </div>
      <div class="cult-card-bar"><div class="cult-card-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="cult-card-actions">
        <button type="button" data-cult-fire="${escapeAttr(spec.fire_skill)}" ${fireDisabled}>${spec.icon} 出手</button>
        <button type="button" class="secondary" data-cult-query="${escapeAttr(spec.query_skill)}">🔍 查询</button>
      </div>
    </div>
  `;
}

function tickCultivationModules() {
  const timers = document.querySelectorAll("[data-cult-timer]");
  if (!timers.length) return;
  const now = Date.now() / 1000;
  let needRerender = false;
  timers.forEach((el) => {
    const nextAt = Number(el.dataset.nextAt || 0);
    if (nextAt === 0) return;
    const remaining = nextAt - now;
    if (remaining <= 0) {
      needRerender = true;
      return;
    }
    el.textContent = `剩 ${fmtCountdown(remaining)}`;
    // 也 tick 进度条
    const card = el.closest(".cult-card");
    if (card) {
      const fill = card.querySelector(".cult-card-bar-fill");
      const startTs = Number(el.dataset.startAt || 0);
      const total = Math.max(1, nextAt - startTs);
      const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    }
  });
  if (needRerender) renderCultivationModules();
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
  const timers = document.querySelectorAll('[data-status-timer="1"]');
  if (!timers.length) return;
  const nowSec = Date.now() / 1000;
  let shouldRerender = false;
  timers.forEach((timer) => {
    const nextAt = Number(timer.dataset.nextAt || 0);
    const startAt = Number(timer.dataset.startAt || 0);
    const remaining = nextAt - nowSec;
    if (remaining <= 0) {
      shouldRerender = true;
      return;
    }
    timer.textContent = `剩 ${fmtCountdown(remaining)}`;
    const card = timer.closest(".identity-status-card");
    const fill = card?.querySelector(".identity-status-bar span");
    if (fill) {
      const total = Math.max(1, nextAt - startAt);
      const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      fill.style.width = `${pct.toFixed(1)}%`;
    }
  });
  if (shouldRerender) {
    const body = modalRoot?.querySelector("#identityStatusBody");
    if (body) {
      body.innerHTML = renderIdentityStatusBody();
      bindIdentityStatusBody(modalRoot);
    }
  }
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
  const data = new FormData(form);
  // 收集通知事件勾选(notify_card_titles 是 multi-checkbox)
  const notifyTitles = Array.from(
    form.querySelectorAll('input[name="notify_card_titles"]:checked')
  ).map((el) => el.value);
  return saveSettings({
    api_id: data.get("api_id"),
    api_hash: data.get("api_hash"),
    phone: data.get("phone"),
    session_name: data.get("session_name"),
    target_chat: data.get("target_chat"),
    target_topic_id: data.get("target_topic_id"),
    game_bot_ids: String(data.get("game_bot_ids") || "")
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
    proxy_type: data.get("proxy_type"),
    proxy_host: data.get("proxy_host"),
    proxy_username: data.get("proxy_username"),
    proxy_password: data.get("proxy_password"),
    notify_enabled: !!form.querySelector('input[name="notify_enabled"]:checked'),
    notify_tg_bot_token: data.get("notify_tg_bot_token"),
    notify_tg_chat_id: data.get("notify_tg_chat_id"),
    notify_card_titles: notifyTitles,
  });
}

// 通知设置 — 拉所有可选卡片标题作 checkbox,绑「发测试通知」按钮
async function _hydrateNotifySection(settings, root = document) {
  const grid = root.querySelector("#notifyEventGrid");
  if (!grid) return;
  const enabled = new Set(settings.notify_card_titles || []);
  try {
    const data = await fetchJson("/api/notify/card-titles");
    const titles = data.titles || [];
    // 按几个语义组排列(顺序硬编码以便阅读;新增的 title 也会一并展示)
    const groups = [
      { name: "🚨 高危", keys: ["风险提醒", "天道审判"] },
      { name: "🎯 prompt", keys: ["玄骨考校", "天机考验", "极阴祖师", "南陇侯", "共历心劫", "第二元神归位"] },
      { name: "🎉 里程碑", keys: ["境界突破", "赐予道号", "试炼古塔战报", "深度闭关总结", "闭关成功"] },
      { name: "📦 副本/物品", keys: ["虚天殿开启", "加入副本成功", "加入副本失败", "副本房间解散", "储物袋快照", "灵树采摘"] },
    ];
    const used = new Set();
    let html = "";
    for (const g of groups) {
      const present = g.keys.filter((k) => titles.includes(k));
      if (!present.length) continue;
      present.forEach((k) => used.add(k));
      html += `<div class="notify-group"><span class="notify-group-name">${escapeHtml(g.name)}</span>`;
      for (const k of present) {
        html += `<label class="notify-event"><input type="checkbox" name="notify_card_titles" value="${escapeAttr(k)}" ${enabled.has(k) ? "checked" : ""} /> <span>${escapeHtml(k)}</span></label>`;
      }
      html += "</div>";
    }
    const leftover = titles.filter((k) => !used.has(k));
    if (leftover.length) {
      html += `<div class="notify-group"><span class="notify-group-name">其它</span>`;
      for (const k of leftover) {
        html += `<label class="notify-event"><input type="checkbox" name="notify_card_titles" value="${escapeAttr(k)}" ${enabled.has(k) ? "checked" : ""} /> <span>${escapeHtml(k)}</span></label>`;
      }
      html += "</div>";
    }
    grid.innerHTML = html || '<p class="muted">没有可订阅事件</p>';
  } catch (err) {
    grid.innerHTML = `<p class="muted">事件列表加载失败:${escapeHtml(String(err))}</p>`;
  }

  root.querySelectorAll('[data-notify-action="test"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const resultEl = root.querySelector("#notifyTestResult");
      btn.disabled = true;
      if (resultEl) resultEl.textContent = "正在发送测试...";
      try {
        // 先保存当前表单(token/chat 等可能未提交)
        const form = btn.closest("form");
        if (form) await saveCurrentSettingsFromForm(form);
        const data = await postJson("/api/notify/test", {});
        if (data.ok) {
          if (resultEl) resultEl.textContent = `✅ 测试通知已发(${(data.results || []).map((r) => r.channel).join(",")})`;
        } else {
          const errs = (data.results || []).filter((r) => !r.ok).map((r) => `${r.channel}: ${r.error}`).join("; ") || data.error || "未知错误";
          if (resultEl) resultEl.textContent = `❌ ${errs}`;
        }
      } catch (err) {
        if (resultEl) resultEl.textContent = `❌ ${err.message || err}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
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
  const active = identityById(state.activeIdentityId);
  if (active && identityCanSend(active)) {
    return Number(active.send_as_id);
  }
  const firstSelf = (state.identities || []).find((identity) => identityCanSend(identity));
  if (firstSelf) {
    return Number(firstSelf.send_as_id);
  }
  return Number((active || (state.identities || [])[0] || {}).send_as_id || 0);
}

function manualSendIdentityOptions(selectedId) {
  const selected = Number(selectedId || 0);
  return (state.identities || []).map((identity) => {
    const id = Number(identity.send_as_id || 0);
    const canSend = identityCanSend(identity);
    return `
      <option value="${escapeAttr(String(id))}" ${id === selected ? "selected" : ""} ${canSend ? "" : "disabled"}>
        ${escapeHtml(identityOptionLabel(identity))}
      </option>
    `;
  }).join("");
}

function directSendSelectedIdentityId() {
  const activeId = Number(state.activeIdentityId || 0);
  if (activeId && state.directSendLastActiveId !== activeId) {
    state.directSendLastActiveId = activeId;
    state.directSendIdentityId = activeId;
  }
  if (state.directSendIdentityId && identityById(state.directSendIdentityId)) {
    return Number(state.directSendIdentityId);
  }
  const fallback = activeId || defaultManualIdentityId();
  state.directSendIdentityId = fallback || null;
  return Number(fallback || 0);
}

function renderDirectSendComposer() {
  if (!directSendComposer || !directSendIdentitySelect || !directSendSubmit) return;
  renderDirectSendReplyContext();
  renderDirectSendSelectionContext();
  renderDirectSendActionHints();
  if (!state.identities.length) {
    directSendIdentitySelect.innerHTML = '<option value="">先登录账号</option>';
    directSendIdentitySelect.disabled = true;
    directSendSubmit.disabled = true;
    if (directSendIdentityLine) directSendIdentityLine.textContent = "未登录";
    return;
  }

  const selectedId = directSendSelectedIdentityId();
  directSendIdentitySelect.innerHTML = manualSendIdentityOptions(selectedId);
  directSendIdentitySelect.value = String(selectedId || "");
  directSendIdentitySelect.disabled = false;

  const identity = identityById(selectedId);
  const canSend = identity && identityCanSend(identity);
  directSendSubmit.disabled = !canSend;
  if (directSendIdentityLine) {
    if (!identity) {
      directSendIdentityLine.textContent = "未选身份";
    } else {
      const name = identity.label || identity.username || identity.send_as_id;
      directSendIdentityLine.textContent = canSend ? `当前: ${name}` : `当前身份暂不能发送: ${name}`;
    }
  }
  resizeDirectSendInput();
}

function setDirectSendStatus(text, kind = "info") {
  if (!directSendStatus) return;
  directSendStatus.textContent = text;
  directSendStatus.className = `direct-send-status ${kind}`;
  directSendStatus.hidden = false;
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

function manualMessagePreview(message) {
  if (!message) return "";
  const raw = String(message.raw || message.summary || message.title || "").trim();
  const compact = clipGraphemes(raw.replace(/\s+/g, " "), 120);
  const source = displaySource(message.source);
  const msgId = message.msg_id ? `#${message.msg_id}` : message.id || "";
  return `${source} ${msgId}${compact ? `：${compact}` : ""}`;
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

if (directSendIdentitySelect) {
  directSendIdentitySelect.addEventListener("change", () => {
    state.directSendIdentityId = Number(directSendIdentitySelect.value || 0) || null;
    renderDirectSendComposer();
  });
}

if (directSendInput) {
  resizeDirectSendInput();
  directSendInput.addEventListener("input", resizeDirectSendInput);
  directSendInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDirectComposerMessage();
    }
  });
}

if (directSendSubmit) {
  directSendSubmit.addEventListener("click", () => {
    sendDirectComposerMessage();
  });
}

if (emojiPickerButton && directSendEmojiPalette) {
  bindEmojiPalette(directSendEmojiPalette, () => directSendInput);
  emojiPickerButton.addEventListener("click", () => {
    emojiPickerButton.closest("details")?.removeAttribute("open");
    const shouldOpen = directSendEmojiPalette.hidden;
    directSendEmojiPalette.hidden = !shouldOpen;
    emojiPickerButton.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    if (shouldOpen && directSendSkillPanel) {
      directSendSkillPanel.hidden = true;
      openSkillMenuButton?.setAttribute("aria-expanded", "false");
    }
    if (!directSendEmojiPalette.hidden) {
      focusDirectSendInput();
    }
  });
}

if (openSkillMenuButton) {
  openSkillMenuButton.addEventListener("click", async () => {
    try {
      openSkillMenuButton.closest("details")?.removeAttribute("open");
      if (!directSendSkillPanel) {
        await Promise.all([loadAccounts(), loadIdentities()]);
        if (!state.skills.length) await loadSkills();
        openSkillMenuModal();
        return;
      }
      const shouldOpen = directSendSkillPanel.hidden;
      if (!shouldOpen) {
        directSendSkillPanel.hidden = true;
        openSkillMenuButton.setAttribute("aria-expanded", "false");
        focusDirectSendInput();
        return;
      }
      await Promise.all([loadAccounts(), loadIdentities()]);
      if (!state.skills.length) await loadSkills();
      if (directSendEmojiPalette) {
        directSendEmojiPalette.hidden = true;
        emojiPickerButton?.setAttribute("aria-expanded", "false");
      }
      directSendSkillPanel.hidden = false;
      openSkillMenuButton.setAttribute("aria-expanded", "true");
      renderSkillBar();
      focusDirectSendInput();
    } catch (error) {
      showError(error);
    }
  });
}

if (openCultivationButton) {
  openCultivationButton.addEventListener("click", async () => {
    try {
      openCultivationButton.closest("details")?.removeAttribute("open");
      await Promise.all([loadAccounts(), loadIdentities()]);
      openCultivationModal();
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
  renderSkillPanel(skillBarTabs, skillBarChips, skillBarIdentity, renderSkillBar);
}

function renderSkillMenuModal() {
  const tabs = modalRoot?.querySelector("#skillMenuTabs");
  const chips = modalRoot?.querySelector("#skillMenuChips");
  const identity = modalRoot?.querySelector("#skillMenuIdentity");
  renderSkillPanel(tabs, chips, identity, renderSkillMenuModal);
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

const HOTBAR_ROWS = 2;
const HOTBAR_VISIBLE_SLOTS = 10;

function hotbarSkillGroups() {
  const preferred = ["日常", "玩法", "查询", "法宝", "副本"];
  const available = state.skillGroups || [];
  const seen = new Set();
  return [...preferred, ...available].filter((group) => {
    if (!group || seen.has(group)) return false;
    seen.add(group);
    return available.includes(group);
  });
}

function hotbarSkillScore(skill) {
  const groupScore = {
    "日常": 1,
    "玩法": 2,
    "查询": 3,
    "法宝": 4,
    "副本": 5,
  }[skill.group] || 9;
  const label = `${skill.label || ""}${skill.key || ""}${skill.command || ""}`;
  const important = [
    ["深度闭关", 1],
    ["野外历练", 2],
    ["点卯", 3],
    ["闯塔", 4],
    ["元婴", 5],
    ["第二元神", 6],
    ["抚摸", 7],
    ["温养", 8],
    ["我的", 9],
    ["战力", 10],
  ];
  const hit = important.find(([word]) => label.includes(word));
  return groupScore * 100 + (hit ? hit[1] : 50);
}

function quickActionHotbarSkills() {
  const groups = new Set(hotbarSkillGroups());
  return (state.skills || [])
    .filter((skill) => groups.has(skill.group))
    .filter((skill) => skill.reply_mode !== "required")
    .filter((skill) => String(skill.command || "").trim())
    .filter((skill) => skillIsUnlocked(skill))
    .sort((a, b) => hotbarSkillScore(a) - hotbarSkillScore(b) || String(a.label || "").localeCompare(String(b.label || ""), "zh-Hans-CN"));
}

function renderQuickActionHotbar() {
  if (!quickActionHotbar) return;
  const activeId = state.activeIdentityId;
  const rankedSkills = quickActionHotbarSkills();
  const hasMore = rankedSkills.length > HOTBAR_VISIBLE_SLOTS;
  const skills = hasMore ? rankedSkills.slice(0, HOTBAR_VISIBLE_SLOTS - 1) : rankedSkills.slice(0, HOTBAR_VISIBLE_SLOTS);
  const renderedCount = skills.length + (hasMore ? 1 : 0);
  quickActionHotbar.style.setProperty("--hotbar-columns", String(Math.max(1, Math.ceil(renderedCount / HOTBAR_ROWS))));
  if (!renderedCount) {
    quickActionHotbar.innerHTML = `
      <span class="quick-action-hotbar-empty">${activeId ? "暂无可用快捷指令" : "选择身份后显示常用操作"}</span>
    `;
    return;
  }
  const modulesByKey = activeId
    ? new Map((state.identityModuleStates.get(Number(activeId)) || []).map((it) => [it.module_key, it]))
    : new Map();
  const now = Date.now() / 1000;
  quickActionHotbar.innerHTML = skills.map((skill) => {
    const moduleState = skill.cd_module ? modulesByKey.get(skill.cd_module) : null;
    const cdUntil = moduleState
      ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
      : 0;
    const cooling = cdUntil > now;
    const busy = state.skillBarBusyKeys.has(skill.key);
    const disabled = !activeId || busy || cooling;
    const cls = [
      "skill-chip",
      "hotbar-skill",
      cooling ? "cooling" : "",
      busy ? "busy" : "",
    ].filter(Boolean).join(" ");
    const cdText = cooling ? fmtCountdown(cdUntil - now) : "";
    return `
      <button type="button" class="${cls}" ${disabled ? "disabled" : ""}
              data-skill-key="${escapeAttr(skill.key)}" title="${escapeAttr(skill.note || skill.command || skill.label || "")}">
        ${skill.icon ? `<span class="skill-chip-icon">${skill.icon}</span>` : ""}
        <span class="skill-chip-label">${escapeHtml(skill.label || skill.command)}</span>
        ${cdText ? `<span class="skill-chip-cd">${escapeHtml(cdText)}</span>` : ""}
      </button>
    `;
  }).join("");
  if (hasMore) {
    quickActionHotbar.insertAdjacentHTML("beforeend", `
      <button type="button" class="skill-chip hotbar-more" data-hotbar-more title="打开全部快捷指令">
        <span class="skill-chip-icon">＋</span>
        <span class="skill-chip-label">更多</span>
      </button>
    `);
  }
  quickActionHotbar.querySelectorAll("[data-skill-key]").forEach((btn) => {
    btn.addEventListener("click", () => fillSkillIntoComposer(btn.dataset.skillKey, btn));
  });
  quickActionHotbar.querySelector("[data-hotbar-more]")?.addEventListener("click", () => {
    openSkillMenuModal();
  });
}

function openSkillMenuModal() {
  const dialog = openModal({
    title: "快捷指令",
    body: `
      <section class="modal-section skill-menu-modal">
        <div class="skill-bar-head">
          <div class="skill-bar-tabs" id="skillMenuTabs"></div>
          <div class="skill-bar-meta">
            <span id="skillMenuIdentity" class="skill-bar-identity">未选身份</span>
          </div>
        </div>
        <div id="skillMenuChips" class="skill-bar-chips"></div>
      </section>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  renderSkillMenuModal();
}

function renderSkillPanel(tabsEl, chipsEl, identityEl, rerender) {
  if (!tabsEl || !chipsEl) return;
  // tabs
  tabsEl.innerHTML = state.skillGroups.map((g) => {
    const cls = g === state.skillBarTab ? "skill-bar-tab active" : "skill-bar-tab";
    return `<button type="button" class="${cls}" data-skill-tab="${escapeAttr(g)}">${escapeHtml(g)}</button>`;
  }).join("");
  tabsEl.querySelectorAll("[data-skill-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.skillBarTab = btn.dataset.skillTab;
      rerender();
    });
  });
  // identity meta
  const activeId = state.activeIdentityId;
  const identity = activeId ? (state.identities || []).find((i) => i.send_as_id === activeId) : null;
  if (identityEl) {
    if (identity) {
      identityEl.textContent = `身份: ${identity.label || identity.username || activeId}`;
      identityEl.classList.remove("empty");
    } else {
      identityEl.textContent = "未选身份(点左边身份列表)";
      identityEl.classList.add("empty");
    }
  }
  // chips
  const tabSkills = (state.skills || [])
    .filter((s) => s.group === state.skillBarTab)
    .filter((s) => skillIsUnlocked(s));
  if (!tabSkills.length) {
    const sect = currentIdentitySect();
    const hint = sect
      ? `「${state.skillBarTab}」组里没有跟你宗门(${sect})/境界匹配的技能`
      : `「${state.skillBarTab}」组里没有技能`;
    chipsEl.innerHTML = `<span class="muted">${escapeHtml(hint)}</span>`;
    return;
  }
  const modulesByKey = activeId
    ? new Map((state.identityModuleStates.get(Number(activeId)) || []).map((it) => [it.module_key, it]))
    : new Map();
  const now = Date.now() / 1000;
  chipsEl.innerHTML = tabSkills.map((skill) => {
    const isReply = skill.reply_mode === "required";
    const moduleState = skill.cd_module ? modulesByKey.get(skill.cd_module) : null;
    const cdUntil = moduleState
      ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
      : 0;
    const cooling = cdUntil > now;
    const busy = state.skillBarBusyKeys.has(skill.key);
    // reply 类不能从底栏填入(没 reply 上下文),只能从消息卡的 action 走。
    const disabled = !activeId || isReply || busy || cooling;
    const cls = [
      "skill-chip",
      isReply ? "reply" : "",
      cooling ? "cooling" : "",
      busy ? "busy" : "",
    ].filter(Boolean).join(" ");
    const cdText = cooling ? `剩 ${fmtCountdown(cdUntil - now)}` : "";
    const title = isReply
      ? (skill.note || "需要回复指定消息发送 — 在消息卡的 actions 区点对应按钮")
      : (skill.note || skill.command);
    return `
      <button type="button" class="${cls}" ${disabled ? "disabled" : ""}
              data-skill-key="${escapeAttr(skill.key)}" title="${escapeAttr(title)}">
        ${skill.icon ? `<span class="skill-chip-icon">${skill.icon}</span>` : ""}
        <span class="skill-chip-label">${escapeHtml(skill.label)}</span>
        ${cdText ? `<span class="skill-chip-cd">${escapeHtml(cdText)}</span>` : ""}
        ${isReply ? '<span class="skill-chip-cd" style="color:#fbbf24;">回复</span>' : ""}
      </button>
    `;
  }).join("");
  chipsEl.querySelectorAll("[data-skill-key]").forEach((btn) => {
    btn.addEventListener("click", () => fillSkillIntoComposer(btn.dataset.skillKey, btn));
  });
}

function fillSkillIntoComposer(skillKey, button = null) {
  const skill = (state.skills || []).find((item) => item.key === skillKey);
  if (!skill) {
    showSkillToast("找不到快捷指令", "err");
    return;
  }
  const command = String(skill.command || "").trim();
  if (!command) {
    showSkillToast("这条快捷指令没有命令文本", "err");
    return;
  }
  fillDirectSendComposer(command, {
    identityId: state.activeIdentityId,
    replyContext: null,
    statusText: `已填入快捷指令：${skill.label || command}`,
    statusKind: "info",
  });
  if (directSendSkillPanel && !directSendSkillPanel.hidden) {
    directSendSkillPanel.hidden = true;
    openSkillMenuButton?.setAttribute("aria-expanded", "false");
  }
  if (button) {
    const originalText = button.querySelector(".skill-chip-label")?.textContent || button.textContent;
    const label = button.querySelector(".skill-chip-label");
    if (label) label.textContent = "已填入";
    window.setTimeout(() => {
      if (label) label.textContent = originalText;
    }, 1000);
  }
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
