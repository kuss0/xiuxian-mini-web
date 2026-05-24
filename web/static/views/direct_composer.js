// MINIWEB-VIEW: direct composer, emoji palette, and quick command hotbar
(function () {
  "use strict";

  const { EMOJI_PALETTE } = window.MiniwebConstants;
  const { clipGraphemes, escapeAttr, escapeHtml } = window.MiniwebFormat;

  const HOTBAR_ROWS = 2;
  const HOTBAR_VISIBLE_SLOTS = 12;
  const HOTBAR_PRIORITY_KEYS = new Map([
    ["deep_retreat", 1],
    ["wild_training", 2],
    ["checkin", 3],
    ["tower", 4],
    ["storage_bag", 5],
    ["battle_power", 6],
    ["deep_retreat_query", 7],
    ["identity_info", 8],
    ["pet_touch", 9],
    ["pet_warm", 10],
    ["yuanying_status", 11],
    ["second_soul_status", 12],
    ["dungeon_status", 13],
  ]);

  function composerState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function composerElements(deps = {}) {
    return deps.elements || deps;
  }

  function manualMessagePreview(deps = {}, message) {
    if (!message) return "";
    const raw = String(message.raw || message.summary || message.title || "").trim();
    const compact = clipGraphemes(raw.replace(/\s+/g, " "), 120);
    const source = deps.displaySource?.(message.source) || String(message.source || "未知发送者");
    const msgId = message.msg_id ? `#${message.msg_id}` : message.id || "";
    return `${source} ${msgId}${compact ? `: ${compact}` : ""}`;
  }

  function directReplyContextFromMessage(deps = {}, message) {
    if (!message) return null;
    const chatId = Number(message.chat_id || 0);
    const msgId = Number(message.msg_id || 0);
    if (!chatId || !msgId) return null;
    return {
      messageId: message.id || `tg:${chatId}:${msgId}`,
      chatId,
      replyToMsgId: msgId,
      topMsgId: Number(message.top_msg_id || 0) || null,
      source: deps.displaySource?.(message.source) || String(message.source || "Telegram 消息"),
      preview: manualMessagePreview(deps, message),
    };
  }

  function directReplyContextFromAction(deps = {}, action, fallbackMessage = null) {
    if (!action) return null;
    const state = composerState(deps);
    const chatId = Number(action.chat_id || fallbackMessage?.chat_id || 0);
    const replyToMsgId = Number(action.reply_to_msg_id || 0);
    if (!chatId || !replyToMsgId) return null;
    const parent =
      (state.messages || []).find(
        (message) =>
          Number(message.chat_id || 0) === chatId &&
          Number(message.msg_id || 0) === replyToMsgId
      ) || fallbackMessage;
    return {
      messageId: parent?.id || `tg:${chatId}:${replyToMsgId}`,
      chatId,
      replyToMsgId,
      topMsgId: Number(action.top_msg_id || parent?.top_msg_id || 0) || null,
      source: parent ? (deps.displaySource?.(parent.source) || String(parent.source || "Telegram 消息")) : "Telegram 消息",
      preview: parent ? manualMessagePreview(deps, parent) : `回复消息 #${replyToMsgId}`,
    };
  }

  function setDirectSendReply(deps = {}, replyContext) {
    composerState(deps).directSendReply = replyContext || null;
    renderDirectSendReplyContext(deps);
  }

  function clearDirectSendReply(deps = {}) {
    setDirectSendReply(deps, null);
  }

  function renderDirectSendReplyContext(deps = {}) {
    const { directSendReplyContext } = composerElements(deps);
    if (!directSendReplyContext) return;
    const reply = composerState(deps).directSendReply;
    if (!reply) {
      directSendReplyContext.hidden = true;
      directSendReplyContext.innerHTML = "";
      return;
    }
    const preview = reply.preview || `${reply.source || "Telegram 消息"} #${reply.replyToMsgId || ""}`;
    directSendReplyContext.hidden = false;
    directSendReplyContext.innerHTML = `
      <div class="direct-send-reply-main">
        <span>回复</span>
        <strong>${escapeHtml(preview)}</strong>
        <small>群 ${escapeHtml(String(reply.chatId || ""))}|消息 #${escapeHtml(String(reply.replyToMsgId || ""))}</small>
      </div>
      <button type="button" data-direct-reply-clear>取消回复</button>
    `;
    directSendReplyContext.querySelector("[data-direct-reply-clear]")?.addEventListener("click", () => {
      clearDirectSendReply(deps);
      focusDirectSendInput(deps);
    });
  }

  function renderDirectSendSelectionContext(deps = {}) {
    const { directSendSelectionContext } = composerElements(deps);
    if (!directSendSelectionContext) return;
    const state = composerState(deps);
    const message = deps.selectedVisibleMessage?.() || null;
    if (!message) {
      directSendSelectionContext.hidden = true;
      directSendSelectionContext.innerHTML = "";
      return;
    }
    const channels = (message.channels || [message.channel])
      .map((channel) => deps.channelLabel?.(channel) || "")
      .filter(Boolean)
      .slice(0, 3)
      .join(" / ");
    const title = String(message.title || "").trim();
    const raw = String(message.summary || message.raw || "").trim().replace(/\s+/g, " ");
    const preview = clipGraphemes(raw || title || "（空消息）", 120);
    const canReply = Number(message.chat_id || 0) !== 0 && Number(message.msg_id || 0) > 0;
    const kind = deps.messageKind?.(message) || "default";
    const source = deps.displaySource?.(message.source) || String(message.source || "未知发送者");
    directSendSelectionContext.hidden = false;
    directSendSelectionContext.innerHTML = `
      <div class="direct-selection-main kind-${escapeAttr(kind)}">
        <span>当前消息</span>
        <strong>${escapeHtml(source)}${title ? `|${escapeHtml(title)}` : ""}</strong>
        <small>${escapeHtml(deps.formatChatTime?.(message.time) || message.time || "")}${channels ? `|${escapeHtml(channels)}` : ""}${message.msg_id ? `|#${escapeHtml(String(message.msg_id))}` : ""}</small>
        <p>${escapeHtml(preview)}</p>
      </div>
      <div class="direct-selection-actions">
        <button type="button" class="primary" data-direct-selected-action="reply" ${canReply ? "" : "disabled"}>回复</button>
        <button type="button" data-direct-selected-action="quote">填入原文</button>
        <button type="button" data-direct-selected-action="copy">复制</button>
        <button type="button" data-direct-selected-action="clear">清除</button>
      </div>
    `;
    directSendSelectionContext.querySelector('[data-direct-selected-action="reply"]')?.addEventListener("click", () => {
      setDirectSendReplyFromMessage(deps, message);
    });
    directSendSelectionContext.querySelector('[data-direct-selected-action="quote"]')?.addEventListener("click", () => {
      const text = String(message.raw || message.summary || message.title || "").trim();
      fillDirectSendComposer(deps, text, {
        replyContext: null,
        statusText: "已把当前消息原文填入发送框，请确认后发送。",
        statusKind: "info",
      });
    });
    directSendSelectionContext.querySelector('[data-direct-selected-action="copy"]')?.addEventListener("click", async (event) => {
      const text = String(message.raw || message.summary || message.title || "").trim();
      await deps.copyCommandToClipboard?.(text, event.currentTarget);
    });
    directSendSelectionContext.querySelector('[data-direct-selected-action="clear"]')?.addEventListener("click", () => {
      state.selectedMessageId = null;
      deps.setWorkspacePanelOpen?.(false);
      deps.renderMessages?.();
      renderDirectSendComposer(deps);
    });
  }

  function renderDirectSendActionHints(deps = {}) {
    const { directSendActionHints } = composerElements(deps);
    if (!directSendActionHints) return;
    const message = deps.selectedVisibleMessage?.() || null;
    const actions = (message?.actions || []).filter((action) => String(action.command || "").trim());
    if (!message || !actions.length) {
      directSendActionHints.hidden = true;
      directSendActionHints.innerHTML = "";
      return;
    }
    directSendActionHints.hidden = false;
    directSendActionHints.innerHTML = `
      <span class="direct-action-hints-label">候选动作</span>
      <div class="direct-action-hints-list">
      ${actions.slice(0, 6).map((action, index) => {
        const command = String(action.command || "").trim();
        return `
          <button type="button" data-direct-action-hint="${index}" title="${escapeAttr(command)}">
            <strong>${escapeHtml(deps.quickActionLabel?.(action) || action.label || "动作")}</strong>
            <small>${escapeHtml(clipGraphemes(command, 42))}</small>
          </button>
        `;
      }).join("")}
      ${actions.length > 6 ? `<span class="direct-action-hints-more">+${actions.length - 6}</span>` : ""}
      </div>
    `;
    directSendActionHints.querySelectorAll("[data-direct-action-hint]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = actions[Number(button.dataset.directActionHint || 0)];
        if (!action) return;
        fillDirectSendComposer(deps, action.command, {
          identityId: action.identity_id,
          replyContext: directReplyContextFromAction(deps, action, message),
          statusText: deps.quickActionNeedsManualReview?.(action)
            ? "已填入候选动作，请补全内容后发送。"
            : "已填入候选动作，请确认后发送。",
          statusKind: "info",
        });
      });
    });
  }

  function fillDirectSendComposer(deps = {}, command, opts = {}) {
    const state = composerState(deps);
    const { directSendInput } = composerElements(deps);
    const text = String(command || "").trim();
    if (opts.identityId) {
      state.directSendIdentityId = Number(opts.identityId || 0) || state.directSendIdentityId;
    }
    if (opts.replyContext !== undefined) {
      setDirectSendReply(deps, opts.replyContext);
    }
    renderDirectSendComposer(deps);
    if (directSendInput && text) {
      directSendInput.value = text;
      resizeDirectSendInput(deps);
    }
    if (opts.statusText) {
      setDirectSendStatus(deps, opts.statusText, opts.statusKind || "info");
    }
    if (opts.focus !== false) {
      focusDirectSendInput(deps);
    }
  }

  function resizeDirectSendInput(deps = {}) {
    const { directSendInput } = composerElements(deps);
    if (!directSendInput) return;
    directSendInput.style.height = "auto";
    const style = window.getComputedStyle(directSendInput);
    const minHeight = Number.parseFloat(style.minHeight) || 44;
    const cssMaxHeight = Number.parseFloat(style.maxHeight);
    const maxHeight = Number.isFinite(cssMaxHeight) && cssMaxHeight > 0 ? cssMaxHeight : 140;
    const nextHeight = Math.min(Math.max(directSendInput.scrollHeight, minHeight), maxHeight);
    directSendInput.style.height = `${nextHeight}px`;
    directSendInput.style.overflowY = directSendInput.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
  }

  function focusDirectSendInput(deps = {}) {
    const { directSendComposer, directSendInput } = composerElements(deps);
    window.requestAnimationFrame(() => {
      if (!directSendInput) return;
      resizeDirectSendInput(deps);
      if (window.innerWidth <= 900) {
        directSendComposer?.scrollIntoView({ block: "nearest" });
      }
      try {
        directSendInput.focus({ preventScroll: true });
      } catch (_error) {
        directSendInput.focus();
      }
      directSendInput.setSelectionRange(directSendInput.value.length, directSendInput.value.length);
    });
  }

  function setDirectSendReplyFromMessage(deps = {}, message) {
    const reply = directReplyContextFromMessage(deps, message);
    if (!reply) {
      deps.showSkillToast?.("这条消息缺少 Telegram chat_id/msg_id，不能回复", "err");
      return;
    }
    fillDirectSendComposer(deps, "", {
      replyContext: reply,
      statusText: `已锁定回复对象：${reply.preview}`,
      statusKind: "info",
    });
  }

  function emojiPaletteHtml() {
    const buttons = (EMOJI_PALETTE || []).map((emoji) => `
      <button type="button" class="emoji-palette-button" data-emoji="${escapeAttr(emoji)}" title="插入 ${escapeAttr(emoji)}">${escapeHtml(emoji)}</button>
    `).join("");
    return `
      <div class="emoji-palette-buttons">${buttons}</div>
      <span class="emoji-palette-hint">系统表情: Windows 用 Win+.，macOS 用 Ctrl+Cmd+Space</span>
    `;
  }

  function bindEmojiPalette(container, getTextarea) {
    if (!container) return;
    container.innerHTML = emojiPaletteHtml();
    container.querySelectorAll("[data-emoji]").forEach((button) => {
      button.addEventListener("click", () => {
        const textarea = getTextarea ? getTextarea() : null;
        if (!textarea) return;
        insertTextAtCursor(textarea, button.dataset.emoji || "");
      });
    });
  }

  function insertTextAtCursor(textarea, text) {
    if (!textarea || !text) return;
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = `${before}${text}${after}`;
    const next = start + text.length;
    textarea.focus();
    textarea.setSelectionRange(next, next);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function defaultManualIdentityId(deps = {}) {
    const state = composerState(deps);
    const active = deps.identityById?.(state.activeIdentityId);
    if (active && deps.identityCanSend?.(active)) {
      return Number(active.send_as_id);
    }
    const firstSelf = (state.identities || []).find((identity) => deps.identityCanSend?.(identity));
    if (firstSelf) {
      return Number(firstSelf.send_as_id);
    }
    return Number((active || (state.identities || [])[0] || {}).send_as_id || 0);
  }

  function manualSendIdentityOptions(deps = {}, selectedId) {
    const state = composerState(deps);
    const selected = Number(selectedId || 0);
    return (state.identities || []).map((identity) => {
      const id = Number(identity.send_as_id || 0);
      const canSend = deps.identityCanSend?.(identity);
      return `
        <option value="${escapeAttr(String(id))}" ${id === selected ? "selected" : ""} ${canSend ? "" : "disabled"}>
          ${escapeHtml(deps.identityOptionLabel?.(identity) || identity.label || identity.username || String(id))}
        </option>
      `;
    }).join("");
  }

  function directSendSelectedIdentityId(deps = {}) {
    const state = composerState(deps);
    const activeId = Number(state.activeIdentityId || 0);
    if (activeId && state.directSendLastActiveId !== activeId) {
      state.directSendLastActiveId = activeId;
      state.directSendIdentityId = activeId;
    }
    if (state.directSendIdentityId && deps.identityById?.(state.directSendIdentityId)) {
      return Number(state.directSendIdentityId);
    }
    const fallback = activeId || defaultManualIdentityId(deps);
    state.directSendIdentityId = fallback || null;
    return Number(fallback || 0);
  }

  function renderDirectSendComposer(deps = {}) {
    const state = composerState(deps);
    const { directSendComposer, directSendIdentityLine, directSendIdentitySelect, directSendSubmit } = composerElements(deps);
    if (!directSendComposer || !directSendIdentitySelect || !directSendSubmit) return;
    renderDirectSendReplyContext(deps);
    renderDirectSendSelectionContext(deps);
    renderDirectSendActionHints(deps);
    if (!state.identities.length) {
      directSendIdentitySelect.innerHTML = '<option value="">先登录账号</option>';
      directSendIdentitySelect.disabled = true;
      directSendSubmit.disabled = true;
      if (directSendIdentityLine) directSendIdentityLine.textContent = "未登录";
      return;
    }

    const selectedId = directSendSelectedIdentityId(deps);
    directSendIdentitySelect.innerHTML = manualSendIdentityOptions(deps, selectedId);
    directSendIdentitySelect.value = String(selectedId || "");
    directSendIdentitySelect.disabled = false;

    const identity = deps.identityById?.(selectedId);
    const canSend = identity && deps.identityCanSend?.(identity);
    directSendSubmit.disabled = !canSend;
    if (directSendIdentityLine) {
      if (!identity) {
        directSendIdentityLine.textContent = "未选身份";
      } else {
        const name = identity.label || identity.username || identity.send_as_id;
        directSendIdentityLine.textContent = canSend ? `当前: ${name}` : `当前身份暂不能发送: ${name}`;
      }
    }
    resizeDirectSendInput(deps);
  }

  function setDirectSendStatus(deps = {}, text, kind = "info") {
    const { directSendStatus } = composerElements(deps);
    if (!directSendStatus) return;
    directSendStatus.textContent = text;
    directSendStatus.className = `direct-send-status ${kind}`;
    directSendStatus.hidden = false;
  }

  function hotbarSkillGroups(deps = {}) {
    const state = composerState(deps);
    const preferred = ["日常", "玩法", "查询", "法宝", "副本"];
    const available = state.skillGroups || [];
    const seen = new Set();
    return [...preferred, ...available].filter((group) => {
      if (!group || seen.has(group)) return false;
      seen.add(group);
      return available.includes(group);
    });
  }

  function hotbarSkillScore(skill) {
    const groupScore = {
      "日常": 1,
      "玩法": 2,
      "查询": 3,
      "法宝": 4,
      "副本": 5,
    }[skill.group] || 9;
    const keyScore = HOTBAR_PRIORITY_KEYS.get(skill.key);
    if (keyScore) return keyScore;
    const label = `${skill.label || ""}${skill.key || ""}${skill.command || ""}`;
    const important = [
      ["深度闭关", 1],
      ["野外历练", 2],
      ["点卯", 3],
      ["闯塔", 4],
      ["储物袋", 5],
      ["战力", 6],
      ["查看闭关", 7],
      ["我的", 8],
      ["元婴", 9],
      ["第二元神", 10],
      ["抚摸", 11],
      ["温养", 12],
    ];
    const hit = important.find(([word]) => label.includes(word));
    return groupScore * 100 + (hit ? hit[1] : 50);
  }

  function quickActionHotbarSkills(deps = {}) {
    const state = composerState(deps);
    const groups = new Set(hotbarSkillGroups(deps));
    return (state.skills || [])
      .filter((skill) => groups.has(skill.group))
      .filter((skill) => skill.reply_mode !== "required")
      .filter((skill) => String(skill.command || "").trim())
      .filter((skill) => deps.skillIsUnlocked?.(skill) !== false)
      .sort((a, b) => hotbarSkillScore(a) - hotbarSkillScore(b) || String(a.label || "").localeCompare(String(b.label || ""), "zh-Hans-CN"));
  }

  function renderQuickActionHotbar(deps = {}) {
    const state = composerState(deps);
    const { quickActionHotbar } = composerElements(deps);
    if (!quickActionHotbar) return;
    const activeId = state.activeIdentityId;
    const rankedSkills = quickActionHotbarSkills(deps);
    const hasMore = rankedSkills.length > HOTBAR_VISIBLE_SLOTS;
    const skills = hasMore ? rankedSkills.slice(0, HOTBAR_VISIBLE_SLOTS - 1) : rankedSkills.slice(0, HOTBAR_VISIBLE_SLOTS);
    const renderedCount = skills.length + (hasMore ? 1 : 0);
    quickActionHotbar.style.setProperty("--hotbar-columns", String(Math.max(1, Math.ceil(renderedCount / HOTBAR_ROWS))));
    if (!renderedCount) {
      quickActionHotbar.innerHTML = `
        <span class="quick-action-hotbar-empty">${activeId ? "暂无可用快捷指令" : "选择身份后显示常用操作"}</span>
      `;
      return;
    }
    const modulesByKey = activeId
      ? new Map((state.identityModuleStates.get(Number(activeId)) || []).map((it) => [it.module_key, it]))
      : new Map();
    const now = Date.now() / 1000;
    quickActionHotbar.innerHTML = skills.map((skill) => {
      const moduleState = skill.cd_module ? modulesByKey.get(skill.cd_module) : null;
      const cdUntil = moduleState
        ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
        : 0;
      const cooling = cdUntil > now;
      const busy = state.skillBarBusyKeys.has(skill.key);
      const disabled = !activeId || busy || cooling;
      const cls = [
        "skill-chip",
        "hotbar-skill",
        cooling ? "cooling" : "",
        busy ? "busy" : "",
      ].filter(Boolean).join(" ");
      const cdText = cooling ? deps.fmtCountdown?.(cdUntil - now) || "" : "";
      return `
        <button type="button" class="${cls}" ${disabled ? "disabled" : ""}
                data-skill-key="${escapeAttr(skill.key)}" title="${escapeAttr(skill.note || skill.command || skill.label || "")}">
          ${skill.icon ? `<span class="skill-chip-icon">${skill.icon}</span>` : ""}
          <span class="skill-chip-label">${escapeHtml(skill.label || skill.command)}</span>
          ${cdText ? `<span class="skill-chip-cd">${escapeHtml(cdText)}</span>` : ""}
        </button>
      `;
    }).join("");
    if (hasMore) {
      quickActionHotbar.insertAdjacentHTML("beforeend", `
        <button type="button" class="skill-chip hotbar-more" data-hotbar-more title="打开全部快捷指令">
          <span class="skill-chip-icon">+</span>
          <span class="skill-chip-label">更多</span>
        </button>
      `);
    }
    quickActionHotbar.querySelectorAll("[data-skill-key]").forEach((btn) => {
      btn.addEventListener("click", () => fillSkillIntoComposer(deps, btn.dataset.skillKey, btn));
    });
    quickActionHotbar.querySelector("[data-hotbar-more]")?.addEventListener("click", () => {
      openSkillMenuModal(deps);
    });
  }

  function openSkillMenuModal(deps = {}) {
    const dialog = deps.openModal?.({
      title: "快捷指令",
      body: `
        <section class="modal-section skill-menu-modal">
          <div class="skill-bar-head">
            <div class="skill-bar-tabs" id="skillMenuTabs"></div>
            <div class="skill-bar-meta">
              <span id="skillMenuIdentity" class="skill-bar-identity">未选身份</span>
            </div>
          </div>
          <div id="skillMenuChips" class="skill-bar-chips"></div>
        </section>
      `,
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    renderSkillMenuModal(deps);
  }

  function renderSkillBar(deps = {}) {
    const { skillBarTabs, skillBarChips, skillBarIdentity } = composerElements(deps);
    renderSkillPanel(deps, skillBarTabs, skillBarChips, skillBarIdentity, () => renderSkillBar(deps));
  }

  function renderSkillMenuModal(deps = {}) {
    const modalRoot = deps.modalRoot;
    const tabs = modalRoot?.querySelector("#skillMenuTabs");
    const chips = modalRoot?.querySelector("#skillMenuChips");
    const identity = modalRoot?.querySelector("#skillMenuIdentity");
    renderSkillPanel(deps, tabs, chips, identity, () => renderSkillMenuModal(deps));
  }

  function renderSkillPanel(deps = {}, tabsEl, chipsEl, identityEl, rerender) {
    const state = composerState(deps);
    if (!tabsEl || !chipsEl) return;
    tabsEl.innerHTML = (state.skillGroups || []).map((group) => {
      const cls = group === state.skillBarTab ? "skill-bar-tab active" : "skill-bar-tab";
      return `<button type="button" class="${cls}" data-skill-tab="${escapeAttr(group)}">${escapeHtml(group)}</button>`;
    }).join("");
    tabsEl.querySelectorAll("[data-skill-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.skillBarTab = btn.dataset.skillTab;
        rerender?.();
      });
    });

    const activeId = state.activeIdentityId;
    const identity = activeId ? (state.identities || []).find((item) => Number(item.send_as_id || 0) === Number(activeId)) : null;
    if (identityEl) {
      if (identity) {
        identityEl.textContent = `身份: ${identity.label || identity.username || activeId}`;
        identityEl.classList.remove("empty");
      } else {
        identityEl.textContent = "未选身份(点左边身份列表)";
        identityEl.classList.add("empty");
      }
    }

    const tabSkills = (state.skills || [])
      .filter((skill) => skill.group === state.skillBarTab)
      .filter((skill) => deps.skillIsUnlocked?.(skill) !== false);
    if (!tabSkills.length) {
      const sect = deps.currentIdentitySect?.() || "";
      const hint = sect
        ? `「${state.skillBarTab}」组里没有跟你宗门(${sect})/境界匹配的技能`
        : `「${state.skillBarTab}」组里没有技能`;
      chipsEl.innerHTML = `<span class="muted">${escapeHtml(hint)}</span>`;
      return;
    }
    const modulesByKey = activeId
      ? new Map((state.identityModuleStates.get(Number(activeId)) || []).map((it) => [it.module_key, it]))
      : new Map();
    const now = Date.now() / 1000;
    chipsEl.innerHTML = tabSkills.map((skill) => {
      const isReply = skill.reply_mode === "required";
      const moduleState = skill.cd_module ? modulesByKey.get(skill.cd_module) : null;
      const cdUntil = moduleState
        ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
        : 0;
      const cooling = cdUntil > now;
      const busy = state.skillBarBusyKeys.has(skill.key);
      const disabled = !activeId || isReply || busy || cooling;
      const cls = [
        "skill-chip",
        isReply ? "reply" : "",
        cooling ? "cooling" : "",
        busy ? "busy" : "",
      ].filter(Boolean).join(" ");
      const cdText = cooling ? `剩 ${deps.fmtCountdown?.(cdUntil - now) || ""}` : "";
      const title = isReply
        ? (skill.note || "需要回复指定消息发送 - 在消息卡的 actions 区点对应按钮")
        : (skill.note || skill.command);
      return `
        <button type="button" class="${cls}" ${disabled ? "disabled" : ""}
                data-skill-key="${escapeAttr(skill.key)}" title="${escapeAttr(title)}">
          ${skill.icon ? `<span class="skill-chip-icon">${skill.icon}</span>` : ""}
          <span class="skill-chip-label">${escapeHtml(skill.label)}</span>
          ${cdText ? `<span class="skill-chip-cd">${escapeHtml(cdText)}</span>` : ""}
          ${isReply ? '<span class="skill-chip-cd" style="color:#fbbf24;">回复</span>' : ""}
        </button>
      `;
    }).join("");
    chipsEl.querySelectorAll("[data-skill-key]").forEach((btn) => {
      btn.addEventListener("click", () => fillSkillIntoComposer(deps, btn.dataset.skillKey, btn));
    });
  }

  function tickSkillBarChips(deps = {}) {
    const state = composerState(deps);
    const chips = document.querySelectorAll(".skill-chip");
    if (!chips.length) return;
    const activeId = state.activeIdentityId;
    if (!activeId) return;
    const modulesByKey = new Map(
      (state.identityModuleStates.get(Number(activeId)) || []).map((item) => [item.module_key, item])
    );
    const now = Date.now() / 1000;
    let shouldRerender = false;
    chips.forEach((chip) => {
      const key = chip.dataset.skillKey;
      const skill = (state.skills || []).find((item) => item.key === key);
      if (!skill || !skill.cd_module) return;
      const moduleState = modulesByKey.get(skill.cd_module);
      const cdUntil = moduleState
        ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
        : 0;
      const remaining = cdUntil - now;
      const cdEl = chip.querySelector(".skill-chip-cd");
      if (remaining > 0) {
        if (cdEl) {
          cdEl.textContent = chip.classList.contains("hotbar-skill")
            ? deps.fmtCountdown?.(remaining) || ""
            : `剩 ${deps.fmtCountdown?.(remaining) || ""}`;
        } else {
          shouldRerender = true;
        }
      } else if (chip.classList.contains("cooling")) {
        shouldRerender = true;
      }
    });
    if (shouldRerender) {
      deps.renderSkillViews?.();
    }
  }

  function fillSkillIntoComposer(deps = {}, skillKey, button = null) {
    const state = composerState(deps);
    const elements = composerElements(deps);
    const skill = (state.skills || []).find((item) => item.key === skillKey);
    if (!skill) {
      deps.showSkillToast?.("找不到快捷指令", "err");
      return;
    }
    const command = String(skill.command || "").trim();
    if (!command) {
      deps.showSkillToast?.("这条快捷指令没有命令文本", "err");
      return;
    }
    fillDirectSendComposer(deps, command, {
      identityId: state.activeIdentityId,
      replyContext: null,
      statusText: `已填入快捷指令：${skill.label || command}`,
      statusKind: "info",
    });
    if (elements.directSendSkillPanel && !elements.directSendSkillPanel.hidden) {
      elements.directSendSkillPanel.hidden = true;
      elements.openSkillMenuButton?.setAttribute("aria-expanded", "false");
    }
    if (button) {
      const originalText = button.querySelector(".skill-chip-label")?.textContent || button.textContent;
      const label = button.querySelector(".skill-chip-label");
      if (label) label.textContent = "已填入";
      window.setTimeout(() => {
        if (label) label.textContent = originalText;
      }, 1000);
    }
  }

  function bindDirectComposer(deps = {}) {
    const state = composerState(deps);
    const elements = composerElements(deps);
    const {
      directSendIdentitySelect,
      directSendInput,
      directSendSubmit,
      emojiPickerButton,
      directSendEmojiPalette,
      directSendSkillPanel,
      openSkillMenuButton,
      openCultivationButton,
    } = elements;

    if (directSendIdentitySelect) {
      directSendIdentitySelect.addEventListener("change", () => {
        state.directSendIdentityId = Number(directSendIdentitySelect.value || 0) || null;
        renderDirectSendComposer(deps);
      });
    }

    if (directSendInput) {
      resizeDirectSendInput(deps);
      directSendInput.addEventListener("input", () => resizeDirectSendInput(deps));
      directSendInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          deps.sendComposerMessage?.();
        }
      });
    }

    if (directSendSubmit) {
      directSendSubmit.addEventListener("click", () => {
        deps.sendComposerMessage?.();
      });
    }

    if (emojiPickerButton && directSendEmojiPalette) {
      bindEmojiPalette(directSendEmojiPalette, () => directSendInput);
      emojiPickerButton.addEventListener("click", () => {
        emojiPickerButton.closest("details")?.removeAttribute("open");
        const shouldOpen = directSendEmojiPalette.hidden;
        directSendEmojiPalette.hidden = !shouldOpen;
        emojiPickerButton.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
        if (shouldOpen && directSendSkillPanel) {
          directSendSkillPanel.hidden = true;
          openSkillMenuButton?.setAttribute("aria-expanded", "false");
        }
        if (!directSendEmojiPalette.hidden) {
          focusDirectSendInput(deps);
        }
      });
    }

    if (openSkillMenuButton) {
      openSkillMenuButton.addEventListener("click", async () => {
        try {
          openSkillMenuButton.closest("details")?.removeAttribute("open");
          if (!directSendSkillPanel) {
            await Promise.all([deps.loadAccounts?.(), deps.loadIdentities?.()]);
            if (!state.skills.length) await deps.loadSkills?.();
            openSkillMenuModal(deps);
            return;
          }
          const shouldOpen = directSendSkillPanel.hidden;
          if (!shouldOpen) {
            directSendSkillPanel.hidden = true;
            openSkillMenuButton.setAttribute("aria-expanded", "false");
            focusDirectSendInput(deps);
            return;
          }
          await Promise.all([deps.loadAccounts?.(), deps.loadIdentities?.()]);
          if (!state.skills.length) await deps.loadSkills?.();
          if (directSendEmojiPalette) {
            directSendEmojiPalette.hidden = true;
            emojiPickerButton?.setAttribute("aria-expanded", "false");
          }
          directSendSkillPanel.hidden = false;
          openSkillMenuButton.setAttribute("aria-expanded", "true");
          renderSkillBar(deps);
          focusDirectSendInput(deps);
        } catch (error) {
          deps.showError?.(error);
        }
      });
    }

    if (openCultivationButton) {
      openCultivationButton.addEventListener("click", async () => {
        try {
          openCultivationButton.closest("details")?.removeAttribute("open");
          await Promise.all([deps.loadAccounts?.(), deps.loadIdentities?.()]);
          deps.openCultivationModal?.();
        } catch (error) {
          deps.showError?.(error);
        }
      });
    }
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.directComposer = {
    HOTBAR_ROWS,
    HOTBAR_VISIBLE_SLOTS,
    manualMessagePreview,
    directReplyContextFromMessage,
    directReplyContextFromAction,
    setDirectSendReply,
    clearDirectSendReply,
    renderDirectSendReplyContext,
    renderDirectSendSelectionContext,
    renderDirectSendActionHints,
    fillDirectSendComposer,
    resizeDirectSendInput,
    focusDirectSendInput,
    setDirectSendReplyFromMessage,
    emojiPaletteHtml,
    bindEmojiPalette,
    insertTextAtCursor,
    defaultManualIdentityId,
    manualSendIdentityOptions,
    directSendSelectedIdentityId,
    renderDirectSendComposer,
    setDirectSendStatus,
    hotbarSkillGroups,
    hotbarSkillScore,
    quickActionHotbarSkills,
    renderQuickActionHotbar,
    openSkillMenuModal,
    renderSkillBar,
    renderSkillMenuModal,
    renderSkillPanel,
    tickSkillBarChips,
    fillSkillIntoComposer,
    bindDirectComposer,
  };
})();
