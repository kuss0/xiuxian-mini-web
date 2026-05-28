// MINIWEB-MODULE: Settings loader
// 设置和配置加载管理
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { fetchJson } = window.MiniwebApi;
  const logger = window.MiniwebLogger || console;
  const errorHandler = window.MiniwebErrorHandler;

  /**
   * 加载设置
   * @returns {Promise<Object>} 设置数据
   */
  async function loadSettings() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/settings");
        state.settings = payload.settings;

        // 触发 UI 更新
        if (window.updateGlobalBanner) window.updateGlobalBanner();

        logger.debug('Settings loaded');
        return state.settings;
      },
      { context: 'loadSettings', fallback: {} }
    );
  }

  /**
   * 加载草稿箱
   * @returns {Promise<Array>} 草稿列表
   */
  async function loadOutboxDrafts() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/outbox/drafts?status=draft");
        state.outboxDrafts = payload.drafts || [];
        logger.debug('Outbox drafts loaded:', state.outboxDrafts.length);
        return state.outboxDrafts;
      },
      { context: 'loadOutboxDrafts', fallback: [] }
    );
  }

  /**
   * 加载技能列表
   * @returns {Promise<void>}
   */
  async function loadSkills() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/skills");
        state.skills = payload.skills || [];

        // 触发 UI 更新
        if (window.renderSkillViews) window.renderSkillViews();

        logger.debug('Skills loaded:', state.skills.length);
      },
      { context: 'loadSkills', showToast: false }
    );
  }

  /**
   * 加载定时任务
   * @param {Object} options - 选项
   * @param {boolean} options.silent - 静默模式
   * @returns {Promise<void>}
   */
  async function loadScheduledMessages(options = {}) {
    const { silent = false } = options;

    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/scheduled-messages");
        state.scheduledMessages = payload.messages || [];

        // 触发 UI 更新
        if (window.renderScheduleRail) window.renderScheduleRail();

        logger.debug('Scheduled messages loaded:', state.scheduledMessages.length);
      },
      { context: 'loadScheduledMessages', showToast: !silent }
    );
  }

  // 导出
  window.MiniwebSettingsLoader = {
    loadSettings,
    loadOutboxDrafts,
    loadSkills,
    loadScheduledMessages,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('settingsLoader', window.MiniwebSettingsLoader);
  }

  logger.info('Settings loader initialized');
})();
