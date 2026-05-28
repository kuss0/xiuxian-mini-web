// MINIWEB-MODULE: Event handlers
// 统一事件处理
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const logger = window.MiniwebLogger || console;
  const errorHandler = window.MiniwebErrorHandler;

  /**
   * 选择消息
   */
  function selectMessage(messageId) {
    state.selectedMessageId = messageId;
    state.detailMode = 'message';

    // 更新 UI
    if (window.renderMessages) window.renderMessages();
    if (window.renderDetail) window.renderDetail();
    if (window.setWorkspacePanelOpen) window.setWorkspacePanelOpen(true);

    logger.debug('Message selected:', messageId);
  }

  /**
   * 选择身份
   */
  function selectIdentity(identityId) {
    const numId = Number(identityId);
    if (state.activeIdentityId === numId) return;

    state.activeIdentityId = numId;

    // 更新 UI
    if (window.renderSidebarIdentityList) window.renderSidebarIdentityList();
    if (window.renderGameCockpit) window.renderGameCockpit();
    if (window.renderDirectSendComposer) window.renderDirectSendComposer();

    // 加载身份补丁
    if (window.MiniwebIdentityLoader) {
      window.MiniwebIdentityLoader.loadIdentityPatches({ reset: true });
    }

    logger.debug('Identity selected:', identityId);
  }

  /**
   * 切换频道
   */
  function toggleChannel(channelKey) {
    const selected = state.selectedChannels || new Set();

    if (selected.has(channelKey)) {
      selected.delete(channelKey);
    } else {
      selected.add(channelKey);
    }

    state.selectedChannels = selected;

    // 重新加载消息
    if (window.loadMessages) {
      window.loadMessages({ incremental: false });
    }

    // 更新 UI
    if (window.renderChannelFilters) window.renderChannelFilters();

    logger.debug('Channel toggled:', channelKey, 'selected:', selected.size);
  }

  /**
   * 设置快速过滤器
   */
  function setQuickFilter(filterKey) {
    state.selectedChannels = new Set([filterKey]);

    // 重新加载消息
    if (window.loadMessages) {
      window.loadMessages({ incremental: false });
    }

    // 更新 UI
    if (window.renderChannelFilters) window.renderChannelFilters();

    logger.debug('Quick filter set:', filterKey);
  }

  /**
   * 关闭详情面板
   */
  function closeDetail() {
    if (window.setWorkspacePanelOpen) {
      window.setWorkspacePanelOpen(false);
    }
    logger.debug('Detail panel closed');
  }

  /**
   * 打开设置
   */
  function openSettings() {
    if (window.openModal) {
      window.openModal('settings');
    }
    logger.debug('Settings opened');
  }

  /**
   * 打开账号设置
   */
  function openAccountSettings() {
    if (window.openModal) {
      window.openModal('account-settings');
    }
    logger.debug('Account settings opened');
  }

  /**
   * 刷新数据
   */
  async function refreshData() {
    logger.info('Refreshing data...');

    try {
      await Promise.all([
        window.loadMessages?.({ incremental: false }),
        window.loadChannels?.(),
        window.MiniwebAccountLoader?.loadAccounts(),
        window.MiniwebIdentityLoader?.loadIdentities(),
      ]);

      if (window.MiniwebToast) {
        window.MiniwebToast.success('刷新成功');
      }

      logger.info('Data refreshed successfully');
    } catch (error) {
      errorHandler.handle(error, {
        type: window.MiniwebErrorTypes.NETWORK,
        context: 'refreshData',
        userMessage: '刷新失败，请重试',
      });
    }
  }

  /**
   * 设置工作区面板状态
   */
  function setWorkspacePanelOpen(open) {
    const panel = document.querySelector("#workspacePanel");
    if (!panel) return;

    if (open) {
      panel.classList.add('open');
    } else {
      panel.classList.remove('open');
    }

    logger.debug('Workspace panel:', open ? 'opened' : 'closed');
  }

  /**
   * 更新账号操作守卫
   */
  function updateAccountActionGuards() {
    const accounts = state.accounts || [];
    const hasAccount = accounts.length > 0;

    // 更新所有需要账号的按钮状态
    document.querySelectorAll('[data-requires-account]').forEach(btn => {
      btn.disabled = !hasAccount;
    });

    logger.debug('Account action guards updated, has account:', hasAccount);
  }

  /**
   * 更新当前账号行
   */
  function updateCurrentAccountLine() {
    if (window.MiniwebSidebarRenderer) {
      window.MiniwebSidebarRenderer.renderCurrentAccountLine();
    }
  }

  // 导出到全局
  window.selectMessage = selectMessage;
  window.selectIdentity = selectIdentity;
  window.toggleChannel = toggleChannel;
  window.setQuickFilter = setQuickFilter;
  window.closeDetail = closeDetail;
  window.openSettings = openSettings;
  window.openAccountSettings = openAccountSettings;
  window.refreshData = refreshData;
  window.setWorkspacePanelOpen = setWorkspacePanelOpen;
  window.updateAccountActionGuards = updateAccountActionGuards;
  window.updateCurrentAccountLine = updateCurrentAccountLine;

  // 导出模块
  window.MiniwebEventHandlers = {
    selectMessage,
    selectIdentity,
    toggleChannel,
    setQuickFilter,
    closeDetail,
    openSettings,
    openAccountSettings,
    refreshData,
    setWorkspacePanelOpen,
    updateAccountActionGuards,
    updateCurrentAccountLine,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('eventHandlers', window.MiniwebEventHandlers);
  }

  logger.info('Event handlers initialized');
})();
