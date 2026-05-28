// MINIWEB-MODULE: Action handlers
// 游戏和消息操作处理
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { fetchJson, postJson } = window.MiniwebApi;
  const logger = window.MiniwebLogger || console;
  const errorHandler = window.MiniwebErrorHandler;

  /**
   * 发送直接消息
   */
  async function sendDirectMessage() {
    const input = document.querySelector("#directSendInput");
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
      if (window.MiniwebToast) {
        window.MiniwebToast.warn('请输入消息内容');
      }
      return;
    }

    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) {
      if (window.MiniwebToast) {
        window.MiniwebToast.error('请先选择身份');
      }
      return;
    }

    try {
      await postJson('/api/messages/send', {
        identity_id: activeId,
        text: text,
        reply_to: state.replyToMessage?.id || null,
      });

      // 清空输入
      input.value = '';
      state.replyToMessage = null;

      // 刷新消息列表
      if (window.loadMessages) {
        await window.loadMessages({ incremental: true });
      }

      if (window.MiniwebToast) {
        window.MiniwebToast.success('发送成功');
      }

      logger.info('Message sent successfully');
    } catch (error) {
      errorHandler.handle(error, {
        type: window.MiniwebErrorTypes.API,
        context: 'sendDirectMessage',
        userMessage: '发送失败，请重试',
      });
    }
  }

  /**
   * 清空编辑器
   */
  function clearComposer() {
    const input = document.querySelector("#directSendInput");
    if (input) {
      input.value = '';
    }
    state.replyToMessage = null;
    state.selectedText = null;

    if (window.renderDirectSendComposer) {
      window.renderDirectSendComposer();
    }

    logger.debug('Composer cleared');
  }

  /**
   * 回复消息
   */
  function replyToMessage(messageId) {
    const message = (state.messages || []).find(m => m.id === messageId);
    if (!message) return;

    state.replyToMessage = message;

    // 更新编辑器
    if (window.renderDirectSendComposer) {
      window.renderDirectSendComposer();
    }

    // 聚焦输入框
    const input = document.querySelector("#directSendInput");
    if (input) {
      input.focus();
    }

    logger.debug('Reply to message:', messageId);
  }

  /**
   * 取消回复
   */
  function cancelReply() {
    state.replyToMessage = null;

    if (window.renderDirectSendComposer) {
      window.renderDirectSendComposer();
    }

    logger.debug('Reply cancelled');
  }

  /**
   * 转发消息
   */
  async function forwardMessage(messageId) {
    const message = (state.messages || []).find(m => m.id === messageId);
    if (!message) return;

    // 将消息内容填入编辑器
    const input = document.querySelector("#directSendInput");
    if (input) {
      input.value = `[转发] ${message.text || ''}`;
      input.focus();
    }

    logger.debug('Forward message:', messageId);
  }

  /**
   * 处理游戏操作
   */
  async function handleGameAction(action) {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) {
      if (window.MiniwebToast) {
        window.MiniwebToast.error('请先选择身份');
      }
      return;
    }

    logger.info('Game action:', action);

    try {
      const result = await postJson('/api/game/action', {
        identity_id: activeId,
        action: action,
      });

      if (window.MiniwebToast) {
        window.MiniwebToast.success(result.message || '操作成功');
      }

      // 刷新相关数据
      if (window.MiniwebIdentityLoader) {
        await window.MiniwebIdentityLoader.loadIdentityModuleStates();
      }

      logger.info('Game action completed:', action);
    } catch (error) {
      errorHandler.handle(error, {
        type: window.MiniwebErrorTypes.API,
        context: 'handleGameAction',
        userMessage: '操作失败，请重试',
      });
    }
  }

  /**
   * 使用技能
   */
  async function useSkill(skillId) {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) {
      if (window.MiniwebToast) {
        window.MiniwebToast.error('请先选择身份');
      }
      return;
    }

    logger.info('Use skill:', skillId);

    try {
      const result = await postJson('/api/skills/use', {
        identity_id: activeId,
        skill_id: skillId,
      });

      if (window.MiniwebToast) {
        window.MiniwebToast.success(result.message || '技能使用成功');
      }

      // 刷新技能状态
      if (window.MiniwebSettingsLoader) {
        await window.MiniwebSettingsLoader.loadSkills();
      }

      logger.info('Skill used:', skillId);
    } catch (error) {
      errorHandler.handle(error, {
        type: window.MiniwebErrorTypes.API,
        context: 'useSkill',
        userMessage: '技能使用失败',
      });
    }
  }

  /**
   * 加载草稿
   */
  function loadDraft(draftId) {
    const draft = (state.outboxDrafts || []).find(d => d.id === draftId);
    if (!draft) return;

    const input = document.querySelector("#directSendInput");
    if (input) {
      input.value = draft.text || '';
      input.focus();
    }

    logger.debug('Draft loaded:', draftId);
  }

  /**
   * 删除草稿
   */
  async function deleteDraft(draftId, event) {
    if (event) {
      event.stopPropagation();
    }

    try {
      await postJson(`/api/outbox/drafts/${draftId}/delete`, {});

      // 刷新草稿列表
      if (window.MiniwebSettingsLoader) {
        await window.MiniwebSettingsLoader.loadOutboxDrafts();
      }

      if (window.renderDraftList) {
        window.renderDraftList();
      }

      if (window.MiniwebToast) {
        window.MiniwebToast.success('草稿已删除');
      }

      logger.info('Draft deleted:', draftId);
    } catch (error) {
      errorHandler.handle(error, {
        type: window.MiniwebErrorTypes.API,
        context: 'deleteDraft',
        userMessage: '删除失败',
      });
    }
  }

  /**
   * 取消定时消息
   */
  async function cancelScheduled(messageId) {
    try {
      await postJson(`/api/scheduled-messages/${messageId}/cancel`, {});

      // 刷新定时消息列表
      if (window.MiniwebSettingsLoader) {
        await window.MiniwebSettingsLoader.loadScheduledMessages();
      }

      if (window.renderScheduleRail) {
        window.renderScheduleRail();
      }

      if (window.MiniwebToast) {
        window.MiniwebToast.success('定时消息已取消');
      }

      logger.info('Scheduled message cancelled:', messageId);
    } catch (error) {
      errorHandler.handle(error, {
        type: window.MiniwebErrorTypes.API,
        context: 'cancelScheduled',
        userMessage: '取消失败',
      });
    }
  }

  // 导出到全局
  window.sendDirectMessage = sendDirectMessage;
  window.clearComposer = clearComposer;
  window.replyToMessage = replyToMessage;
  window.cancelReply = cancelReply;
  window.forwardMessage = forwardMessage;
  window.handleGameAction = handleGameAction;
  window.useSkill = useSkill;
  window.loadDraft = loadDraft;
  window.deleteDraft = deleteDraft;
  window.cancelScheduled = cancelScheduled;

  // 导出模块
  window.MiniwebActionHandlers = {
    sendDirectMessage,
    clearComposer,
    replyToMessage,
    cancelReply,
    forwardMessage,
    handleGameAction,
    useSkill,
    loadDraft,
    deleteDraft,
    cancelScheduled,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('actionHandlers', window.MiniwebActionHandlers);
  }

  logger.info('Action handlers initialized');
})();
