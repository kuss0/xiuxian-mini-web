// MINIWEB-MODULE: Cockpit renderer
// 游戏驾驶舱渲染
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { escapeHtml, formatNumber } = window.MiniwebFormat;
  const logger = window.MiniwebLogger || console;

  /**
   * 渲染游戏驾驶舱
   */
  function renderGameCockpit() {
    const cockpit = document.querySelector("#gameCockpit");
    if (!cockpit) return;

    const activeIdentity = getActiveIdentity();
    if (!activeIdentity) {
      cockpit.innerHTML = '<div class="empty-state">请先选择身份</div>';
      return;
    }

    cockpit.innerHTML = `
      <div class="cockpit-header">
        ${renderCockpitIdentity()}
      </div>
      <div class="cockpit-body">
        ${renderCockpitModules()}
        ${renderCockpitInbox()}
      </div>
      <div class="cockpit-footer">
        ${renderGameActionDock()}
      </div>
    `;

    logger.debug('Game cockpit rendered');
  }

  /**
   * 获取活跃身份
   */
  function getActiveIdentity() {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return null;
    return (state.identities || []).find(id => Number(id.id) === activeId);
  }

  /**
   * 渲染驾驶舱身份信息
   */
  function renderCockpitIdentity() {
    const identity = getActiveIdentity();
    if (!identity) return '';

    const level = identity.level || 0;
    const realm = identity.realm || '未知';

    return `
      <div class="cockpit-identity">
        <div class="identity-name">${escapeHtml(identity.name || '')}</div>
        <div class="identity-stats">
          <span class="stat">等级 ${level}</span>
          <span class="stat">${escapeHtml(realm)}</span>
        </div>
      </div>
    `;
  }

  /**
   * 渲染驾驶舱模块
   */
  function renderCockpitModules() {
    const moduleStates = getActiveIdentityModuleStates();
    if (!moduleStates || moduleStates.length === 0) {
      return '<div class="empty-state">暂无模块状态</div>';
    }

    return `
      <div class="cockpit-modules">
        ${moduleStates.map(renderModuleChip).join('')}
      </div>
    `;
  }

  /**
   * 获取活跃身份的模块状态
   */
  function getActiveIdentityModuleStates() {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return [];

    const stateMap = state.identityModuleStates || new Map();
    const entry = stateMap.get(activeId);
    return entry?.modules || [];
  }

  /**
   * 渲染模块芯片
   */
  function renderModuleChip(module) {
    const status = module.status || 'unknown';
    const statusClass = {
      'active': 'status-active',
      'cooldown': 'status-cooldown',
      'ready': 'status-ready',
    }[status] || 'status-unknown';

    return `
      <div class="module-chip ${statusClass}">
        <span class="module-name">${escapeHtml(module.name || '')}</span>
        ${module.cooldown ? `<span class="module-cooldown">${escapeHtml(module.cooldown)}</span>` : ''}
      </div>
    `;
  }

  /**
   * 渲染驾驶舱收件箱
   */
  function renderCockpitInbox() {
    const messages = getRecentMessages(5);

    return `
      <div class="cockpit-inbox">
        <div class="inbox-header">最近消息</div>
        <div class="inbox-list">
          ${messages.length > 0
            ? messages.map(renderInboxMessage).join('')
            : '<div class="empty-state">暂无消息</div>'}
        </div>
      </div>
    `;
  }

  /**
   * 获取最近消息
   */
  function getRecentMessages(limit = 5) {
    return (state.messages || []).slice(0, limit);
  }

  /**
   * 渲染收件箱消息
   */
  function renderInboxMessage(message) {
    const preview = (message.text || '').slice(0, 50);
    return `
      <div class="inbox-message" onclick="selectMessage('${message.id}')">
        <span class="message-channel">${escapeHtml(message.channel || '')}</span>
        <span class="message-preview">${escapeHtml(preview)}</span>
      </div>
    `;
  }

  /**
   * 渲染游戏操作栏
   */
  function renderGameActionDock() {
    const actions = [
      { key: 'cultivate', label: '修炼', icon: '🧘' },
      { key: 'explore', label: '探索', icon: '🗺️' },
      { key: 'battle', label: '战斗', icon: '⚔️' },
      { key: 'trade', label: '交易', icon: '💰' },
    ];

    return `
      <div class="action-dock">
        ${actions.map(action => `
          <button class="action-btn" onclick="handleGameAction('${action.key}')">
            <span class="action-icon">${action.icon}</span>
            <span class="action-label">${escapeHtml(action.label)}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  /**
   * 渲染主要焦点条
   */
  function renderGamePrimaryStrip() {
    const strip = document.querySelector("#gamePrimaryStrip");
    if (!strip) return;

    const focusMessage = getPrimaryFocusMessage();
    if (!focusMessage) {
      strip.innerHTML = '<div class="empty-state">暂无焦点消息</div>';
      return;
    }

    strip.innerHTML = `
      <div class="primary-strip">
        <div class="strip-header">
          <span class="strip-channel">${escapeHtml(focusMessage.channel || '')}</span>
          <span class="strip-time">${escapeHtml(focusMessage.time || '')}</span>
        </div>
        <div class="strip-content">${escapeHtml(focusMessage.text || '')}</div>
      </div>
    `;

    logger.debug('Primary strip rendered');
  }

  /**
   * 获取主要焦点消息
   */
  function getPrimaryFocusMessage() {
    const messages = state.messages || [];
    return messages.find(m => m.channel === 'focus') || messages[0];
  }

  // 导出
  window.MiniwebCockpitRenderer = {
    renderGameCockpit,
    renderCockpitIdentity,
    renderCockpitModules,
    renderCockpitInbox,
    renderGameActionDock,
    renderGamePrimaryStrip,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('cockpitRenderer', window.MiniwebCockpitRenderer);
  }

  logger.info('Cockpit renderer initialized');
})();
