// MINIWEB-MODULE: Message renderer
// 消息列表渲染
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { escapeHtml, clipGraphemes } = window.MiniwebFormat;
  const logger = window.MiniwebLogger || console;

  /**
   * 渲染消息列表
   */
  function renderMessages() {
    const messageList = document.querySelector("#messageList");
    if (!messageList) return;

    const messages = state.messages || [];

    if (messages.length === 0) {
      messageList.innerHTML = '<div class="empty-state">暂无消息</div>';
      return;
    }

    // 使用虚拟滚动（如果可用）
    if (window.MiniwebVirtualScroll && messages.length > 100) {
      window.MiniwebVirtualScroll.render(messageList, messages, renderMessageCard);
    } else {
      messageList.innerHTML = messages.map(renderMessageCard).join('');
    }

    // 更新消息计数
    const messageCount = document.querySelector("#messageCount");
    if (messageCount) {
      messageCount.textContent = messages.length;
    }

    logger.debug('Messages rendered:', messages.length);
  }

  /**
   * 渲染单个消息卡片
   * @param {Object} message - 消息对象
   * @returns {string} HTML 字符串
   */
  function renderMessageCard(message) {
    const isSelected = state.selectedMessageId === message.id;
    const preview = clipGraphemes(message.text || '', 180);

    return `
      <div class="message-card ${isSelected ? 'selected' : ''}"
           data-message-id="${message.id}"
           onclick="selectMessage('${message.id}')">
        <div class="message-header">
          <span class="message-channel">${escapeHtml(message.channel || '')}</span>
          <span class="message-time">${escapeHtml(message.time || '')}</span>
        </div>
        <div class="message-preview">${escapeHtml(preview)}</div>
      </div>
    `;
  }

  /**
   * 渲染频道过滤器
   */
  function renderChannelFilters() {
    const channelFilters = document.querySelector("#channelFilters");
    if (!channelFilters) return;

    const channels = state.channels || [];
    const selected = state.selectedChannels || new Set();

    channelFilters.innerHTML = channels.map(channel => `
      <label class="channel-filter">
        <input type="checkbox"
               value="${escapeHtml(channel.key)}"
               ${selected.has(channel.key) ? 'checked' : ''}
               onchange="toggleChannel('${escapeHtml(channel.key)}')">
        <span>${escapeHtml(channel.name || channel.key)}</span>
      </label>
    `).join('');

    logger.debug('Channel filters rendered:', channels.length);
  }

  /**
   * 渲染快速过滤器
   */
  function renderQuickFilters() {
    const quickFilters = document.querySelector("#quickFilters");
    if (!quickFilters) return;

    const filters = [
      { key: 'focus', label: '重点' },
      { key: 'risk', label: '风险' },
      { key: 'leader', label: '领导' },
    ];

    quickFilters.innerHTML = filters.map(filter => `
      <button class="quick-filter-btn"
              onclick="setQuickFilter('${filter.key}')">
        ${escapeHtml(filter.label)}
      </button>
    `).join('');
  }

  // 导出
  window.MiniwebMessageRenderer = {
    renderMessages,
    renderMessageCard,
    renderChannelFilters,
    renderQuickFilters,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('messageRenderer', window.MiniwebMessageRenderer);
  }

  logger.info('Message renderer initialized');
})();
