// MINIWEB-VIEW: message detail panel and manual action controls
(function () {
  "use strict";

  const { clipGraphemes, escapeHtml } = window.MiniwebFormat;

  function detailPanelState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  async function renderDetail(deps = {}) {
    const state = detailPanelState(deps);
    const detailPanel = deps.detailPanel;
    const detailState = deps.detailState;
    if (!detailPanel) return;

    if (state.detailMode === "overview") {
      if (detailState) detailState.textContent = "概览";
      detailPanel.innerHTML = deps.renderOverviewDetailPanel?.() || "";
      deps.bindOverviewDetailPanel?.();
      return;
    }
    if (state.detailMode !== "message") {
      return;
    }
    const message = (state.messages || []).find((item) => item.id === state.selectedMessageId);
    const visible = deps.visibleMessages?.() || [];
    if (!message || !visible.some((item) => item.id === message.id)) {
      deps.setWorkspacePanelOpen?.(false);
      if (detailState) detailState.textContent = "未选择";
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
      if (detailState) detailState.textContent = "载入中";
      detailPanel.innerHTML = '<div class="detail-empty-state loading"><strong>正在载入原文</strong><p>从消息箱补齐 Telegram 原文和结构化字段。</p></div>';
      const fullMessage = await deps.ensureFullMessage?.(message);
      if (fullMessage && !fullMessage.compact) {
        await renderDetail(deps);
      }
      return;
    }

    const isRisk = message.severity === "risk";
    if (detailState) detailState.textContent = isRisk ? "风险" : actionCountLabel(message);
    const enhancedHtml = deps.renderEnhancedBlock?.(message) || "";
    const actionsHtml = renderDetailActions(deps, message);
    const focusInsightHtml = renderFocusInsight(deps, message);
    const heading = String(message.title || "").trim() || "Telegram 消息";
    const summary = String(message.summary || "").trim();
    const rawText = String(message.raw || "").trim();
    const rawPreview = clipGraphemes((rawText || summary || heading).replace(/\s+/g, " "), 180);
    const actionCount = (message.actions || []).length;
    const canReply = Number(message.chat_id || 0) !== 0 && Number(message.msg_id || 0) > 0;

    detailPanel.innerHTML = `
      <section class="detail-selected-message ${isRisk ? "risk" : ""}">
        <div class="detail-selected-meta">
          <strong>${escapeHtml(deps.displaySource?.(message.source) || String(message.source || "未知发送者"))}</strong>
          <span>${escapeHtml(deps.formatChatTime?.(message.time) || message.time || "时间未知")}</span>
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
        <pre class="raw-text">${deps.renderTelegramTextHtml?.(rawText || "（未抓取到原文）", message) || escapeHtml(rawText || "（未抓取到原文）")}</pre>
      </details>

      <details class="detail-fold detail-focus-fold">
        <summary>分流原因 / 降噪</summary>
        <div class="detail-fold-body">${focusInsightHtml}</div>
      </details>
    `;

    bindDetailActions(deps, message);
  }

  function renderFocusInsight(deps = {}, message) {
    const reasons = focusReasonList(deps, message);
    const reasonsHtml = reasons.length
      ? `<div class="focus-reason-list">${reasons.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
      : '<p class="empty inline">这条消息当前不在重点流。</p>';
    const toolsHtml = renderFocusTools(deps, message);
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

  function renderFocusTools(deps = {}, message) {
    if (!canFocusArchiveMessage(deps, message)) return "";
    const senderId = Number(message.sender_id || 0);
    const muted = isFocusMutedSenderId(deps, senderId);
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

  function focusReasonList(deps = {}, message) {
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
    if (deps.messageKind?.(message) === "player" && !reasons.length) reasons.push("普通玩家消息策略");
    if (!tags.some((tag) => String(tag).startsWith("重点排除:") || String(tag).startsWith("重点静音:"))) {
      reasons.push("未被排除规则命中");
    }
    return Array.from(new Set(reasons));
  }

  function canFocusArchiveMessage(deps = {}, message) {
    const senderId = Number(message?.sender_id || 0);
    if (!Number.isFinite(senderId) || senderId === 0) return false;
    if (deps.messageKind?.(message) !== "player") return false;
    if ((message.channels || []).includes("mine")) return false;
    if ((message.actions || []).length) return false;
    if (message.severity === "risk" || (message.channels || []).includes("risk")) return false;
    if ((message.tags || []).some((tag) => ["被@", "回复我", "会长", "我发出"].includes(String(tag)))) return false;
    return true;
  }

  function isFocusMutedSenderId(deps = {}, senderId) {
    const state = detailPanelState(deps);
    const ids = ((state.settings || {}).focus_muted_sender_ids || []).map((id) => Number(id));
    return ids.includes(Number(senderId));
  }

  function renderDetailActions(deps = {}, message) {
    const state = detailPanelState(deps);
    const actions = message.actions || [];
    if (actions.length === 0) {
      return '<p class="empty inline">这条消息没有解析出候选回复。需要操作时，直接在底部发送栏输入。</p>';
    }
    const cards = actions
      .map((action, index) => {
        const context = renderActionContextLine(action);
        const notice = state.draftNoticeByMessageId?.get(`${message.id}:${index}`);
        const command = String(action.command || "").trim();
        return `
          <div class="action-draft" data-action-index="${index}">
            <div class="action-draft-head">
              <strong>${escapeHtml(deps.quickActionLabel?.(action) || action.label || "动作")}</strong>
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

  function bindDetailActions(deps = {}, message) {
    const state = detailPanelState(deps);
    const detailPanel = deps.detailPanel;
    if (!detailPanel) return;
    const actions = message.actions || [];
    detailPanel.querySelector('[data-detail-message-action="reply"]')?.addEventListener("click", () => {
      deps.setDirectSendReplyFromMessage?.(message);
    });
    detailPanel.querySelector('[data-detail-message-action="copy-text"]')?.addEventListener("click", async (event) => {
      const text = String(message.raw || message.summary || message.title || "").trim();
      if (!text) {
        deps.showSkillToast?.("这条消息没有可复制文本", "err");
        return;
      }
      await deps.copyCommandToClipboard?.(text, event.currentTarget);
    });
    detailPanel.querySelector('[data-detail-message-action="fill-source"]')?.addEventListener("click", () => {
      const text = String(message.raw || "").trim();
      if (!text) {
        deps.showSkillToast?.("这条消息没有原文", "err");
        return;
      }
      deps.fillDirectSendComposer?.(text, {
        replyContext: null,
        statusText: "已把原文填入发送框，请确认后发送。",
        statusKind: "info",
      });
    });
    detailPanel.querySelector('[data-detail-action="focus-archive-exact"]')?.addEventListener("click", () => {
      deps.openFocusArchiveModal?.(message, "exact");
    });
    detailPanel.querySelector('[data-detail-action="focus-archive-contains"]')?.addEventListener("click", () => {
      deps.openFocusArchiveModal?.(message, "contains");
    });
    detailPanel.querySelector('[data-detail-action="focus-mute-toggle"]')?.addEventListener("click", async (event) => {
      await deps.toggleFocusMuteSender?.(message, event.currentTarget);
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
            deps.fillDirectSendComposer?.(action.command, {
              identityId: action.identity_id,
              replyContext: deps.directReplyContextFromAction?.(action, message),
              statusText: "已填入输入框，请确认内容后发送。",
              statusKind: "info",
            });
            return;
          }
          if (kind === "copy") {
            await deps.copyCommandToClipboard?.(action.command, button);
            return;
          }
          if (kind === "plan") {
            button.disabled = true;
            const plan = await deps.planOutboxAction?.(action);
            deps.renderOutboxPlan?.(plan, action, planPanel);
            return;
          }
          if (kind === "enqueue") {
            button.disabled = true;
            const result = await deps.createOutboxDraft?.(action, message.id);
            if (result?.ok && result.draft) {
              state.draftNoticeByMessageId?.set(noticeKey, {
                kind: "ok",
                text: `已入队草稿 ${result.draft.id || ""}，可在草稿箱里人工确认或删除。`,
              });
            } else {
              state.draftNoticeByMessageId?.set(noticeKey, {
                kind: "warn",
                text: result?.error || "入队草稿失败",
              });
            }
            deps.renderDetail?.();
            return;
          }
        } catch (error) {
          if (kind === "plan") {
            deps.renderOutboxPlanError?.(error, planPanel);
          } else {
            state.draftNoticeByMessageId?.set(noticeKey, {
              kind: "warn",
              text: error.message || "操作失败",
            });
            deps.renderDetail?.();
          }
        } finally {
          if (kind !== "copy") {
            button.disabled = false;
          }
        }
      });
    });
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.detailPanel = {
    renderDetail,
    renderFocusInsight,
    actionCountLabel,
    renderFocusTools,
    focusReasonList,
    canFocusArchiveMessage,
    isFocusMutedSenderId,
    renderDetailActions,
    renderActionContextLine,
    bindDetailActions,
  };
})();
