// MINIWEB-MODULE: Composer renderer
// 消息编辑器渲染
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { escapeHtml } = window.MiniwebFormat;
  const logger = window.MiniwebLogger || console;

  /**
   * 渲染直接发送编辑器
   */
  function renderDirectSendComposer() {
    const composer = document.querySelector("#directSendComposer");
    if (!composer) return;

    const activeIdentity = getActiveIdentity();
    if (!activeIdentity) {
      composer.innerHTML = '<div class="empty-state">请先选择身份</div>';
      return;
    }

    composer.innerHTML = `
      <div class="composer-header">
        <span class="composer-title">发送消息</span>
        <span class="composer-identity">${escapeHtml(activeIdentity.name || '')}</span>
      </div>
      <div class="composer-body">
        ${renderDirectSendReplyContext()}
        <textarea id="directSendInput"
                  placeholder="输入消息内容..."
                  rows="3"></textarea>
        ${renderDirectSendActionHints()}
      </div>
      <div class="composer-footer">
        <button id="directSendSubmit" onclick="sendDirectMessage()">发送</button>
        <button onclick="clearComposer()">清空</button>
      </div>
    `;

    // 绑定快捷键
    bindComposerShortcuts();

    logger.debug('Direct send composer rendered');
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
   * 渲染回复上下文
   */
  function renderDirectSendReplyContext() {
    const replyTo = state.replyToMessage;
    if (!replyTo) return '';

    return `
      <div class="reply-context">
        <span class="reply-label">回复:</span>
        <span class="reply-preview">${escapeHtml((replyTo.text || '').slice(0, 50))}</span>
        <button class="reply-cancel" onclick="cancelReply()">×</button>
      </div>
    `;
  }

  /**
   * 渲染操作提示
   */
  function renderDirectSendActionHints() {
    return `
      <div class="action-hints">
        <span class="hint">Ctrl+Enter 发送</span>
        <span class="hint">Esc 清空</span>
      </div>
    `;
  }

  /**
   * 绑定编辑器快捷键
   */
  function bindComposerShortcuts() {
    const input = document.querySelector("#directSendInput");
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      // Ctrl+Enter 发送
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (window.sendDirectMessage) window.sendDirectMessage();
      }

      // Esc 清空
      if (e.key === 'Escape') {
        e.preventDefault();
        if (window.clearComposer) window.clearComposer();
      }
    });
  }

  /**
   * 渲染选择上下文
   */
  function renderDirectSendSelectionContext() {
    const selection = state.selectedText;
    if (!selection) return '';

    return `
      <div class="selection-context">
        <span class="selection-label">选中文本:</span>
        <span class="selection-preview">${escapeHtml(selection.slice(0, 50))}</span>
        <button class="selection-cancel" onclick="clearSelection()">×</button>
      </div>
    `;
  }

  /**
   * 渲染草稿列表
   */
  function renderDraftList() {
    const container = document.querySelector("#draftList");
    if (!container) return;

    const drafts = state.outboxDrafts || [];
    if (drafts.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无草稿</div>';
      return;
    }

    container.innerHTML = drafts.map(draft => `
      <div class="draft-item" onclick="loadDraft('${draft.id}')">
        <div class="draft-preview">${escapeHtml((draft.text || '').slice(0, 50))}</div>
        <div class="draft-time">${escapeHtml(draft.created_at || '')}</div>
        <button class="draft-delete" onclick="deleteDraft('${draft.id}', event)">删除</button>
      </div>
    `).join('');

    logger.debug('Draft list rendered:', drafts.length);
  }

  /**
   * 渲染定时消息列表
   */
  function renderScheduleRail() {
    const container = document.querySelector("#scheduleRail");
    if (!container) return;

    const scheduled = state.scheduledMessages || [];
    if (scheduled.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无定时消息</div>';
      return;
    }

    container.innerHTML = scheduled.map(msg => `
      <div class="scheduled-item">
        <div class="scheduled-time">${escapeHtml(msg.scheduled_at || '')}</div>
        <div class="scheduled-preview">${escapeHtml((msg.text || '').slice(0, 50))}</div>
        <button class="scheduled-cancel" onclick="cancelScheduled('${msg.id}')">取消</button>
      </div>
    `).join('');

    logger.debug('Schedule rail rendered:', scheduled.length);
  }

  // 导出
  window.MiniwebComposerRenderer = {
    renderDirectSendComposer,
    renderDirectSendReplyContext,
    renderDirectSendSelectionContext,
    renderDirectSendActionHints,
    renderDraftList,
    renderScheduleRail,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('composerRenderer', window.MiniwebComposerRenderer);
  }

  logger.info('Composer renderer initialized');
})();
