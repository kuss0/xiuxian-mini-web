// MINIWEB-MODULE: Message controller
// 消息加载、刷新和管理
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { fetchJson } = window.MiniwebApi;
  const { mergeMessagesById } = window.MiniwebMessageUtils;

  /**
   * 加载消息审计
   * @param {Object} options - 选项
   * @param {boolean} options.silent - 静默模式
   * @param {boolean} options.deep - 深度审计
   * @returns {Promise<Object>} 审计结果
   */
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

    // 触发 UI 更新
    if (window.renderGameCockpit) window.renderGameCockpit();
    if (window.updateGlobalBanner) window.updateGlobalBanner();

    return payload;
  }

  /**
   * 加载世界快照
   * @param {Object} options - 选项
   * @param {boolean} options.silent - 静默模式
   * @returns {Promise<Object>} 世界快照
   */
  async function loadWorldSnapshot({ silent = false } = ) {
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

      // 触发 UI 更新
      if (window.renderLiveSituationBoard) window.renderLiveSituationBoard();
      if (window.renderWorldEventStrip) window.renderWorldEventStrip();
      if (window.renderGameSceneBoard) window.renderGameSceneBoard();
      if (window.renderQuestTracker) window.renderQuestTracker();
      if (window.renderGameActionDock) window.renderGameActionDock();

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

  /**
   * 加载频道列表
   * @returns {Promise<void>}
   */
  async function loadChannels() {
    const payload = await fetchJson("/api/channels");
    state.channels = payload.channels;
    state.selectedChannels = state.channels.some((channel) => channel.key === "focus")
      ? new Set(["focus"])
      : new Set(state.channels.map((channel) => channel.key));

    if (window.renderChannelFilters) window.renderChannelFilters();
  }

  /**
   * 加载频道摘要
   * @param {Object} options - 选项
   * @param {boolean} options.incremental - 增量加载
   * @returns {Promise<void>}
   */
  async function loadChannelSummary({ incremental = false } = {}) {
    const params = new URLSearchParams({
      channels: Array.from(state.selectedChannels || []).join(","),
      limit: String(state.channelSummaryLimit || 200),
    });
    if (incremental && state.latestMessageSeq) {
      params.set("since_seq", String(state.latestMessageSeq));
    }
    const payload = await fetchJson(`/api/channel-summary?${params.toString()}`);

    if (incremental) {
      state.messages = mergeMessagesById(state.messages, payload.messages);
    } else {
      state.messages = payload.messages || [];
    }

    const latest = state.messages[0];
    if (latest?.seq) {
      state.latestMessageSeq = latest.seq;
    }

    if (window.renderMessageList) window.renderMessageList();
  }

  /**
   * 刷新聊天视图
   * @param {Object} options - 选项
   * @param {boolean} options.incremental - 增量刷新
   * @returns {Promise<void>}
   */
  async function refreshChatViewport({ incremental = false } = {}) {
    await loadChannelSummary({ incremental });
  }

  /**
   * 加载消息
   * @param {Object} options - 选项
   * @param {boolean} options.incremental - 增量加载
   * @returns {Promise<void>}
   */
  async function loadMessages({ incremental = false } = {}) {
    await refreshChatViewport({ incremental });
  }

  /**
   * 刷新消息（快捷方法）
   * @returns {Promise<void>}
   */
  async function refreshMessages() {
    return loadMessages({ incremental: true });
  }

  /**
   * 确保消息完整（补全 compact 消息）
   * @param {Object} message - 消息对象
   * @returns {Promise<Object>} 完整消息
   */
  async function ensureFullMessage(message) {
    if (!message?.compact || !message?.id) {
      return message;
    }

    try {
      const fullMessage = await fetchJson(`/api/messages/${message.id}`);

      // 更新 state 中的消息
      const index = state.messages.findIndex(m => m.id === message.id);
      if (index !== -1) {
        state.messages[index] = fullMessage;
      }

      return fullMessage;
    } catch (err) {
      console.warn("[mini-web] failed to load full message:", err);
      return message;
    }
  }

  window.MiniwebMessageController = {
    loadMessageAudit,
    loadWorldSnapshot,
    loadChannels,
    loadChannelSummary,
    refreshChatViewport,
    loadMessages,
    refreshMessages,
    ensureFullMessage,
  };

  console.log('[mini-web] Message controller loaded');
})();
