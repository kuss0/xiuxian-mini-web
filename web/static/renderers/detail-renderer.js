// MINIWEB-MODULE: Detail renderer
// 详情面板渲染
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { escapeHtml } = window.MiniwebFormat;
  const logger = window.MiniwebLogger || console;

  /**
   * 渲染详情面板
   */
  function renderDetail() {
    const panel = document.querySelector("#detailPanel");
    if (!panel) return;

    const mode = state.detailMode || 'message';

    switch (mode) {
      case 'message':
        renderMessageDetail(panel);
        break;
      case 'identity':
        renderIdentityDetail(panel);
        break;
      case 'dungeon':
        renderDungeonDetail(panel);
        break;
      default:
        panel.innerHTML = '<div class="empty-state">未知详情类型</div>';
    }

    logger.debug('Detail panel rendered, mode:', mode);
  }

  /**
   * 渲染消息详情
   */
  function renderMessageDetail(panel) {
    const messageId = state.selectedMessageId;
    if (!messageId) {
      panel.innerHTML = '<div class="empty-state">请选择一条消息</div>';
      return;
    }

    const message = (state.messages || []).find(m => m.id === messageId);
    if (!message) {
      panel.innerHTML = '<div class="empty-state">消息未找到</div>';
      return;
    }

    panel.innerHTML = `
      <div class="detail-header">
        <h3>消息详情</h3>
        <button onclick="closeDetail()">关闭</button>
      </div>
      <div class="detail-body">
        <div class="detail-field">
          <label>频道</label>
          <span>${escapeHtml(message.channel || '')}</span>
        </div>
        <div class="detail-field">
          <label>时间</label>
          <span>${escapeHtml(message.time || '')}</span>
        </div>
        <div class="detail-field">
          <label>内容</label>
          <div class="message-content">${escapeHtml(message.text || '')}</div>
        </div>
        ${message.metadata ? renderMessageMetadata(message.metadata) : ''}
      </div>
      <div class="detail-footer">
        <button onclick="replyToMessage('${message.id}')">回复</button>
        <button onclick="forwardMessage('${message.id}')">转发</button>
      </div>
    `;
  }

  /**
   * 渲染消息元数据
   */
  function renderMessageMetadata(metadata) {
    return `
      <div class="detail-field">
        <label>元数据</label>
        <pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>
      </div>
    `;
  }

  /**
   * 渲染身份详情
   */
  function renderIdentityDetail(panel) {
    const identity = getActiveIdentity();
    if (!identity) {
      panel.innerHTML = '<div class="empty-state">请选择一个身份</div>';
      return;
    }

    panel.innerHTML = `
      <div class="detail-header">
        <h3>身份详情</h3>
        <button onclick="closeDetail()">关闭</button>
      </div>
      <div class="detail-body">
        <div class="detail-field">
          <label>名称</label>
          <span>${escapeHtml(identity.name || '')}</span>
        </div>
        <div class="detail-field">
          <label>等级</label>
          <span>${identity.level || 0}</span>
        </div>
        <div class="detail-field">
          <label>境界</label>
          <span>${escapeHtml(identity.realm || '未知')}</span>
        </div>
        ${renderIdentityStats(identity)}
      </div>
    `;
  }

  /**
   * 渲染身份属性
   */
  function renderIdentityStats(identity) {
    const stats = identity.stats || {};
    return `
      <div class="detail-field">
        <label>属性</label>
        <div class="stats-grid">
          ${Object.entries(stats).map(([key, value]) => `
            <div class="stat-item">
              <span class="stat-label">${escapeHtml(key)}</span>
              <span class="stat-value">${escapeHtml(String(value))}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  /**
   * 渲染副本详情
   */
  function renderDungeonDetail(panel) {
    panel.innerHTML = `
      <div class="detail-header">
        <h3>副本详情</h3>
        <button onclick="closeDetail()">关闭</button>
      </div>
      <div class="detail-body">
        <div class="empty-state">副本详情开发中...</div>
      </div>
    `;
  }

  /**
   * 获取活跃身份
   */
  function getActiveIdentity() {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return null;
    return (state.identities || []).find(id => Number(id.id) === activeId);
  }

  // 导出
  window.MiniwebDetailRenderer = {
    renderDetail,
    renderMessageDetail,
    renderIdentityDetail,
    renderDungeonDetail,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('detailRenderer', window.MiniwebDetailRenderer);
  }

  logger.info('Detail renderer initialized');
})();
