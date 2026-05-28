// MINIWEB-MODULE: Account loader
// 账号和监听器加载管理
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { fetchJson } = window.MiniwebApi;
  const logger = window.MiniwebLogger || console;
  const errorHandler = window.MiniwebErrorHandler;

  /**
   * 加载账号列表
   * @returns {Promise<Object>} 账号数据
   */
  async function loadAccounts() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/accounts");
        state.accounts = payload.accounts || [];
        state.accountLimit = payload.max_accounts || 0;
        state.listenerSummary = payload.listener || null;

        // 触发 UI 更新
        if (window.renderSidebarIdentityList) window.renderSidebarIdentityList();
        if (window.renderDirectSendComposer) window.renderDirectSendComposer();
        if (window.renderGameCockpit) window.renderGameCockpit();
        if (window.updateCurrentAccountLine) window.updateCurrentAccountLine();
        if (window.updateAccountActionGuards) window.updateAccountActionGuards();

        logger.debug('Accounts loaded:', payload.accounts?.length || 0);
        return payload;
      },
      { context: 'loadAccounts', fallback: { accounts: [], max_accounts: 0 } }
    );
  }

  /**
   * 加载发现的 Bots
   * @returns {Promise<void>}
   */
  async function loadDiscoveredBots() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/discovered-bots");
        state.discoveredBots = payload.bots || [];
        logger.debug('Discovered bots loaded:', state.discoveredBots.length);
      },
      { context: 'loadDiscoveredBots', showToast: false }
    );
  }

  // 导出
  window.MiniwebAccountLoader = {
    loadAccounts,
    loadDiscoveredBots,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('accountLoader', window.MiniwebAccountLoader);
  }

  logger.info('Account loader initialized');
})();
