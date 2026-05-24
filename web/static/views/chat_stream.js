// MINIWEB-VIEW: chat message stream, scroll anchoring, and quick actions
(function () {
  "use strict";

  const {
    clipGraphemes,
    countGraphemes,
    escapeAttr,
    escapeHtml,
    firstGrapheme,
  } = window.MiniwebFormat;
  const {
    MESSAGE_PREVIEW_CHAR_LIMIT,
    MESSAGE_PREVIEW_LINE_LIMIT,
    NUMERIC_SOURCE_RE,
  } = window.MiniwebConstants;

  function chatStreamState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function visibleMessages(deps = {}) {
    const state = chatStreamState(deps);
    if (state.selectedChannels.size === 0) {
      return [];
    }
    // solo 模式数据已由 server 端 SQL 预过滤(mode=solo);前端只做频道过滤。
    // 「日志」modal 是另一条单独的全量数据流,不走这里。
    return state.messages.filter((message) => {
      const channels = message.channels || [message.channel];
      if (!channels.some((channel) => state.selectedChannels.has(channel))) {
        return false;
      }
      return messageMatchesSearch(deps, message);
    });
  }

  function messageMatchesSearch(deps = {}, message) {
    const state = chatStreamState(deps);
    const query = String(state.messageSearch || "").trim().toLowerCase();
    if (!query) return true;
    const haystack = [
      message.title,
      message.summary,
      message.raw,
      message.source,
      message.channel,
      ...(message.channels || []),
      ...Object.entries(message.fields || {}).map(([key, value]) => `${key} ${deps.formatFieldValue?.(value) || String(value)}`),
      ...(message.tags || []),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  }

  function parentMessageOf(deps = {}, card) {
    const state = chatStreamState(deps);
    if (!card.reply_to_msg_id || !card.chat_id) return null;
    const parentId = `tg:${card.chat_id}:${card.reply_to_msg_id}`;
    return (
      state.messages.find((m) => m.id === parentId) ||
      state.messages.find(
        (m) =>
          Number(m.chat_id || 0) === Number(card.chat_id || 0) &&
          Number(m.msg_id || 0) === Number(card.reply_to_msg_id || 0)
      ) ||
      null
    );
  }

  function renderReplyContext(deps = {}, message) {
    if (!message.reply_to_msg_id || !message.chat_id) return "";
    const parent = parentMessageOf(deps, message);
    const parentId = `tg:${message.chat_id}:${message.reply_to_msg_id}`;
    if (parent) {
      const preview = clipGraphemes((parent.raw || parent.summary || "").trim().replace(/\s+/g, " "), 60) || "(无内容)";
      return `
        <div class="chat-reply-context" data-reply-jump="${escapeAttr(parentId)}" title="点击跳到原消息">
          <span class="arrow">↪</span>
          <span class="source">${escapeHtml(displaySource(parent.source))}</span>
          <span class="preview">${escapeHtml(preview)}</span>
        </div>
      `;
    }
    // 父消息不在当前 state(超出初始 200 条范围),仍可点击 -- 点了会按需拉
    return `
      <div class="chat-reply-context" data-reply-jump="${escapeAttr(parentId)}" title="点击按需拉取并跳到原消息">
        <span class="arrow">↪</span>
        <span class="preview muted">回复消息 #${escapeHtml(String(message.reply_to_msg_id))}(点击载入)</span>
      </div>
    `;
  }

  function renderActiveChannelText(deps = {}) {
    const state = chatStreamState(deps);
    let text = "";
    if (state.selectedChannels.size === 0) {
      text = "未选择频道";
    } else if (state.selectedChannels.size === state.channels.length) {
      text = "全部频道";
    } else {
      const labels = state.channels
        .filter((channel) => state.selectedChannels.has(channel.key))
        .map((channel) => channel.label);
      text = labels.join(" / ");
    }
    const query = String(state.messageSearch || "").trim();
    if (query) {
      text = `${text}｜搜索「${query}」`;
    }
    if (deps.activeChannelText) deps.activeChannelText.textContent = text;
    if (deps.streamActiveChannelText) deps.streamActiveChannelText.textContent = text;
  }

  function renderMessages(deps = {}) {
    const state = chatStreamState(deps);
    const messages = visibleMessages(deps);
    const collectorStatus = deps.collectorLiveStatus?.();
    const searchSuffix = state.messageSearch ? "｜搜索中" : "";
    if (deps.messageCount) {
      deps.messageCount.textContent = `${messages.length} 条${searchSuffix}${collectorStatus ? `｜${collectorStatus}` : ""}`;
    }
    renderActiveChannelText(deps);
    deps.renderLiveSituationBoard?.();
    deps.renderWorldEventStrip?.();
    deps.renderGameActionDock?.();

    if (messages.length === 0) {
      if (deps.messageList) {
        deps.messageList.innerHTML = `<div class="chat-empty">${escapeHtml(deps.emptyMessageHint?.() || "没有消息。")}</div>`;
      }
      if (deps.jumpToLatestButton) {
        deps.jumpToLatestButton.hidden = true;
      }
      return;
    }

    // 聊天客户端顺序:旧消息在上,最新消息在底部发送栏上方。
    // 重建 DOM 时锚住当前可见消息;只有用户本来就在最新位置时才自动贴底。
    const scrollSnapshot = captureMessageScrollSnapshot(deps);

    const groups = groupMessagesByDate([...messages].reverse());
    const fragment = document.createDocumentFragment();
    groups.forEach((group) => {
      const divider = document.createElement("div");
      divider.className = "chat-day-divider";
      divider.innerHTML = `<span>${escapeHtml(group.label)}</span>`;
      fragment.appendChild(divider);
      group.items.forEach((message) => {
        fragment.appendChild(renderChatMessageNode(deps, message));
      });
    });
    deps.messageList?.replaceChildren(fragment);

    restoreMessageScrollSnapshot(deps, scrollSnapshot);
  }

  function isMessageListNearLatest(deps = {}, threshold = 120) {
    const messageList = deps.messageList;
    if (!messageList) return true;
    return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= threshold;
  }

  function updateJumpToLatestVisibility(deps = {}) {
    if (!deps.jumpToLatestButton || !deps.messageList) return;
    deps.jumpToLatestButton.hidden = isMessageListNearLatest(deps);
  }

  function scrollMessageListToLatest(deps = {}, { behavior = "auto" } = {}) {
    const messageList = deps.messageList;
    if (!messageList) return;
    messageList.scrollTo({ top: messageList.scrollHeight, behavior });
    updateJumpToLatestVisibility(deps);
  }

  function captureMessageScrollSnapshot(deps = {}) {
    const messageList = deps.messageList;
    if (!messageList) return { nearLatest: true };
    if (messageList.scrollHeight === 0 || isMessageListNearLatest(deps, 96)) {
      return { nearLatest: true };
    }

    const listRect = messageList.getBoundingClientRect();
    const topGuard = listRect.top + 1;
    const nodes = messageList.querySelectorAll("[data-message-id]");
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom >= topGuard) {
        return {
          nearLatest: false,
          anchorId: node.dataset.messageId || "",
          anchorOffset: rect.top - listRect.top,
          scrollTop: messageList.scrollTop,
        };
      }
    }
    return { nearLatest: false, scrollTop: messageList.scrollTop };
  }

  function restoreMessageScrollSnapshot(deps = {}, snapshot) {
    const messageList = deps.messageList;
    if (!messageList || !snapshot) return;
    if (snapshot.nearLatest) {
      scrollMessageListToLatest(deps);
      return;
    }
    if (snapshot.anchorId) {
      const node = messageList.querySelector(`[data-message-id="${CSS.escape(snapshot.anchorId)}"]`);
      if (node) {
        const listRect = messageList.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        messageList.scrollTop += rect.top - listRect.top - snapshot.anchorOffset;
        updateJumpToLatestVisibility(deps);
        return;
      }
    }
    messageList.scrollTop = Math.max(0, snapshot.scrollTop || 0);
    updateJumpToLatestVisibility(deps);
  }

  function renderChatMessageNode(deps = {}, message) {
    const state = chatStreamState(deps);
    const row = document.createElement("article");
    const kind = messageKind(deps, message);
    const isExpanded = state.expandedMessages.has(message.id);
    row.className = [
      "chat-message",
      `kind-${kind}`,
      message.id === state.selectedMessageId ? "active" : "",
    ]
      .filter(Boolean)
      .join(" ");
    row.dataset.messageId = message.id;

    const contextHtml = renderChatContextMeta(deps, message);

    const { html: textHtml, truncated } = renderChatBodyText(deps, message, isExpanded);
    const riskBadge =
      kind === "risk"
        ? `<span class="chat-risk-badge" title="风险消息，需要人工查看">! 需要关注</span>`
        : "";
    const sourceText = displaySource(message.source);
    const sourceClass = isNumericSource(message.source) ? "chat-source numeric" : "chat-source";
    const replyContext = renderReplyContext(deps, message);

    const canReply = Number(message.chat_id || 0) !== 0 && Number(message.msg_id || 0) > 0;
    row.innerHTML = `
      <button type="button" class="chat-avatar-btn" data-chat-action="detail" aria-label="查看消息详情">
        <span class="chat-avatar" aria-hidden="true">${escapeHtml(sourceInitial(message.source, kind))}</span>
      </button>
      <div class="chat-body">
        <div class="chat-head-row">
          <button type="button" class="chat-head" data-chat-action="select">
            <strong class="${sourceClass}">${escapeHtml(sourceText)}</strong>
            <span class="chat-time">${escapeHtml(formatChatTime(message.time))}</span>
            ${riskBadge}
          </button>
          <div class="chat-message-actions">
            <button type="button" class="chat-detail-button" data-chat-action="detail" aria-label="查看消息详情"
                    title="查看原文、字段和候选动作">详</button>
            <button type="button" class="chat-reply-button" data-chat-action="reply" ${canReply ? "" : "disabled"}
                    aria-label="回复这条消息"
                    title="${canReply ? "回复这条 Telegram 消息" : "这条卡片缺少 Telegram msg_id,不能回复"}">回</button>
          </div>
        </div>
        ${replyContext}
        <div class="chat-text" data-chat-action="select">${textHtml}</div>
        ${truncated ? `<button type="button" class="chat-toggle" data-chat-action="toggle">${isExpanded ? "收起全文" : "展开全文"}</button>` : ""}
        ${renderChatQuickActions(deps, message)}
        ${contextHtml}
      </div>
    `;

    row.addEventListener("click", async (event) => {
      const quickAction = event.target.closest('[data-chat-action="quick-action"]');
      if (quickAction) {
        event.stopPropagation();
        deps.selectMessageForComposer?.(message, { rerenderList: true });
        const index = Number(quickAction.dataset.actionIndex || 0);
        await handleChatQuickAction(deps, message, index, quickAction);
        return;
      }
      const detail = event.target.closest('[data-chat-action="detail"]');
      if (detail) {
        event.stopPropagation();
        deps.setWorkspaceSelectedMessage?.(message, { rerenderList: true });
        return;
      }
      const reply = event.target.closest('[data-chat-action="reply"]');
      if (reply) {
        event.stopPropagation();
        if (!reply.disabled) {
          deps.selectMessageForComposer?.(message, { rerenderList: true });
          deps.setDirectSendReplyFromMessage?.(message);
        }
        return;
      }
      const toggle = event.target.closest('[data-chat-action="toggle"]');
      if (toggle) {
        event.stopPropagation();
        if (state.expandedMessages.has(message.id)) {
          state.expandedMessages.delete(message.id);
        } else {
          state.expandedMessages.add(message.id);
        }
        renderMessages(deps);
        return;
      }
      const jump = event.target.closest("[data-reply-jump]");
      if (jump) {
        event.stopPropagation();
        const targetId = jump.dataset.replyJump;
        let parent = state.messages.find((m) => m.id === targetId);
        if (!parent) {
          jump.classList.add("loading");
          parent = await deps.fetchMessageById?.(targetId);
          jump.classList.remove("loading");
          if (!parent) {
            console.warn("[mini-web] 父消息不存在或已被清理:", targetId);
            return;
          }
        }
        deps.jumpToMessage?.(parent);
        return;
      }
      deps.selectMessageForComposer?.(message, { rerenderList: true });
    });
    return row;
  }

  function renderChatContextMeta(deps = {}, message) {
    const badges = visibleMessageBadges(deps, message);
    const actionCount = (message.actions || []).length;
    const items = [
      message.title ? `<span class="chat-title-pill">${escapeHtml(message.title)}</span>` : "",
      ...badges.map((tag) => `<span class="chat-tag">${escapeHtml(tag)}</span>`),
      actionCount ? `<span class="chat-action-pill">${actionCount} 个候选</span>` : "",
    ].filter(Boolean);
    return items.length ? `<div class="chat-enhance">${items.join("")}</div>` : "";
  }

  function visibleMessageBadges(deps = {}, message) {
    const tags = (message.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean);
    const channels = message.channels || [message.channel];
    const important = new Set();
    if (message.severity === "risk" || channels.includes("risk")) {
      important.add("风险");
    }
    if (deps.isPersonalSignal?.(message)) {
      important.add("我的");
    }
    for (const tag of tags) {
      if (["被@", "回复我", "会长", "我发出", "失败", "解散", "可加入", "加入", "风险"].includes(tag)) {
        important.add(tag === "我发出" ? "我的" : tag);
      } else if (tag.startsWith("关键词:")) {
        important.add(tag);
      }
    }
    return Array.from(important).slice(0, 3);
  }

  function renderChatQuickActions(deps = {}, message) {
    const actions = (message.actions || []).filter((action) => String(action.command || "").trim());
    if (!actions.length) return "";
    const maxVisible = 4;
    const buttons = actions.slice(0, maxVisible).map((action, index) => {
      const label = quickActionLabel(action);
      const command = String(action.command || "").trim();
      const replyText = action.reply_to_msg_id ? `回复 #${action.reply_to_msg_id}` : "直接发送";
      return `
        <button type="button" class="chat-quick-action" data-chat-action="quick-action"
                data-action-index="${index}" title="${escapeAttr(`${replyText}: ${command}`)}">
          ${escapeHtml(label)}
        </button>
      `;
    }).join("");
    const more = actions.length > maxVisible
      ? `<span class="chat-quick-more">+${actions.length - maxVisible}</span>`
      : "";
    return `<div class="chat-quick-actions">${buttons}${more}</div>`;
  }

  function quickActionLabel(action) {
    const rawLabel = String(action.label || "").trim();
    const command = String(action.command || "").trim();
    const cleaned = rawLabel
      .replace(/^复制\s*/, "")
      .replace(/[（(]回复[）)]/g, "")
      .trim();
    if (cleaned && cleaned.length <= 12) return cleaned;
    return command.replace(/^[.。]/, "").trim() || "回复";
  }

  function quickActionNeedsManualReview(action) {
    const command = String(action.command || "").trim();
    // 自证命令通常还需要口令 + 答案,不能裸发 ".自证"。
    return command === ".自证" || command === "。自证";
  }

  async function handleChatQuickAction(deps = {}, message, index, button) {
    const action = (message.actions || [])[index];
    if (!action) return;
    deps.fillDirectSendComposer?.(action.command, {
      replyContext: deps.directReplyContextFromAction?.(action, message),
      statusText: quickActionNeedsManualReview(action)
        ? "已填入快捷动作，请补全内容后发送。"
        : "已填入快捷动作，请确认后发送。",
      statusKind: "info",
    });
    if (button) {
      const originalText = button.textContent;
      button.textContent = "已填入";
      window.setTimeout(() => {
        button.textContent = originalText;
      }, 1200);
    }
  }

  function displaySource(source) {
    const clean = String(source || "").trim();
    if (!clean) {
      return "未知发送者";
    }
    if (isNumericSource(clean)) {
      return `用户 ${clean}`;
    }
    return clean;
  }

  function isNumericSource(source) {
    const clean = String(source || "").trim();
    return clean !== "" && NUMERIC_SOURCE_RE.test(clean);
  }

  function renderChatBodyText(deps = {}, message, isExpanded) {
    const raw = String(message.raw || "").trim();
    const fallback = String(message.summary || message.title || "").trim();
    const text = raw || fallback || "（空消息）";
    const lines = text.split("\n");
    const graphemeLength = countGraphemes(text);
    const tooLong =
      graphemeLength > MESSAGE_PREVIEW_CHAR_LIMIT || lines.length > MESSAGE_PREVIEW_LINE_LIMIT;

    if (!tooLong || isExpanded) {
      return { html: deps.renderTelegramTextHtml?.(text, message) || escapeHtml(text), truncated: tooLong };
    }

    const previewLines = lines.slice(0, MESSAGE_PREVIEW_LINE_LIMIT);
    let preview = previewLines.join("\n");
    if (countGraphemes(preview) > MESSAGE_PREVIEW_CHAR_LIMIT) {
      preview = clipGraphemes(preview, MESSAGE_PREVIEW_CHAR_LIMIT);
    }
    const html = deps.renderTelegramTextHtml?.(preview, message) || escapeHtml(preview);
    return { html: `${html}<span class="chat-text-ellipsis">…</span>`, truncated: true };
  }

  function groupMessagesByDate(messages) {
    const groups = [];
    let current = null;
    messages.forEach((message) => {
      const label = formatDayLabel(message.time);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(message);
    });
    return groups;
  }

  function formatDayLabel(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "时间未知";
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      return text;
    }
    const now = new Date();
    const diffDays = daysBetween(date, now);
    if (diffDays === 0) {
      return "今天";
    }
    if (diffDays === 1) {
      return "昨天";
    }
    if (diffDays === 2) {
      return "前天";
    }
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    }
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }

  function daysBetween(date, now) {
    const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function formatChatTime(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      return text;
    }
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function messageKind(deps = {}, message) {
    const channels = message.channels || [message.channel];
    const source = String(message.source || "");
    if (message.severity === "risk" || channels.includes("risk")) {
      return "risk";
    }
    if (deps.isPersonalSignal?.(message)) {
      return "mine";
    }
    if (message.sender_is_bot || channels.includes("system") || source.includes("韩天尊") || source.includes("天尊")) {
      return "bot";
    }
    return "player";
  }

  function sourceInitial(source, kind) {
    const clean = String(source || "").replace(/^@/, "").trim();
    if (kind === "risk") {
      return "！";
    }
    if (clean.includes("韩天尊") || clean.includes("天尊")) {
      return "天";
    }
    if (!clean) {
      return "?";
    }
    return firstGrapheme(clean).toUpperCase();
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.chatStream = {
    visibleMessages,
    messageMatchesSearch,
    parentMessageOf,
    renderReplyContext,
    renderActiveChannelText,
    renderMessages,
    isMessageListNearLatest,
    updateJumpToLatestVisibility,
    scrollMessageListToLatest,
    captureMessageScrollSnapshot,
    restoreMessageScrollSnapshot,
    renderChatMessageNode,
    renderChatContextMeta,
    visibleMessageBadges,
    renderChatQuickActions,
    quickActionLabel,
    quickActionNeedsManualReview,
    handleChatQuickAction,
    displaySource,
    isNumericSource,
    renderChatBodyText,
    groupMessagesByDate,
    formatDayLabel,
    daysBetween,
    formatChatTime,
    messageKind,
    sourceInitial,
  };
})();
