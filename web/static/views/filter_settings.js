// MINIWEB-VIEW: message filter settings modal
(function () {
  "use strict";

  const { fetchJson, postJson } = window.MiniwebApi;
  const { closeModal, openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function openFilterSettingsModal({
    fetchMessageById,
    findMessageById,
    jumpToMessage,
    muteFocusSenderId,
    renderFocusArchivePreview,
    saveFilterSettings,
    settings = {},
  }) {
    const dialog = openModal({
      title: "消息过滤设置",
      body: `
        <section class="modal-section">
          <h4>重点流规则</h4>
          <p class="muted">首页默认只看重点流。自己的发送一定显示;点命令和格式化天尊回复会进入归档;会长 sender ID 的非点命令发言会全部进入会长频道,已确认游戏 Bot/天尊 ID 仍只收非回复普通发言。</p>
          <form id="filterSettingsForm" class="settings-form">
            <label class="stacked-field">
              <span>我的 @ 名称</span>
              <textarea name="own_aliases" rows="2" placeholder="每行一个,例如 wa2000 或 @wa2000">${escapeHtml((settings.own_aliases || []).join("\n"))}</textarea>
            </label>
            <label class="stacked-field">
              <span>会长 sender IDs（会长频道判定）</span>
              <textarea name="leader_sender_ids" rows="2" placeholder="每行一个 sender_id">${escapeHtml((settings.leader_sender_ids || []).join("\n"))}</textarea>
            </label>
            <label class="stacked-field">
              <span>会长昵称备注（不参与判定）</span>
              <textarea name="leader_source_names" rows="2" placeholder="每行一个备注昵称；会长频道只按 sender_id 判定">${escapeHtml((settings.leader_source_names || []).join("\n"))}</textarea>
            </label>
            <label class="stacked-field">
              <span>重点流静音 sender IDs</span>
              <textarea name="focus_muted_sender_ids" rows="2" placeholder="每行一个 sender_id,只压普通玩家噪音">${escapeHtml((settings.focus_muted_sender_ids || []).join("\n"))}</textarea>
            </label>
            <label class="stacked-field">
              <span>重点流静音昵称</span>
              <textarea name="focus_muted_source_names" rows="2" placeholder="每行一个昵称片段,例如某个常刷屏玩家">${escapeHtml((settings.focus_muted_source_names || []).join("\n"))}</textarea>
            </label>
            <label class="stacked-field">
              <span>关注关键词</span>
              <textarea name="focus_keywords" rows="8" placeholder="每行一个关键词">${escapeHtml((settings.focus_keywords || []).join("\n"))}</textarea>
            </label>
            <div class="filter-helper-row" aria-label="关注关键词预设">
              ${["虚天殿", "坠魔谷", "共历心劫", "第二元神", "天道审判"].map((item) => `
                <button type="button" data-filter-keyword-preset="${escapeAttr(item)}">关注 ${escapeHtml(item)}</button>
              `).join("")}
            </div>
            <label class="stacked-field">
              <span>重点流排除规则（正则）</span>
              <textarea name="focus_exclude_patterns" rows="3" placeholder="每行一条正则，例如 ^\\d{1,2}$">${escapeHtml((settings.focus_exclude_patterns || []).join("\n"))}</textarea>
            </label>
            <div class="filter-rule-helper">
              <label class="stacked-field">
                <span>新增排除短语 / 正则</span>
                <input id="filterExcludeDraft" placeholder="例如 坠魔谷护持；只会压普通重点消息，不压 @我/风险/动作卡" />
              </label>
              <div class="filter-helper-row">
                <button type="button" data-filter-exclude-preset="坠魔谷护持" data-mode="contains">排除 坠魔谷护持</button>
                <button type="button" data-filter-exclude-preset="^\\d{1,2}$" data-mode="regex">排除单独数字</button>
                <button type="button" id="filterExcludePreview">预览新增规则</button>
                <button type="button" id="filterExcludeAddContains">按短语加入</button>
                <button type="button" id="filterExcludeAddRegex">按正则加入</button>
              </div>
              <div id="filterRulePreview" class="focus-preview-box"></div>
            </div>
            <div class="filter-rule-helper">
              <div class="filter-helper-row">
                <button type="button" id="filterDiagnosticsButton">查看最近入流原因</button>
              </div>
              <div id="filterDiagnosticsBox" class="focus-preview-box"></div>
            </div>
            <label class="toggle-row">
              <input type="checkbox" name="focus_include_player_plain" ${settings.focus_include_player_plain ? "checked" : ""} />
              <span>普通玩家聊天也进入重点流（会明显增噪）</span>
            </label>
            <label class="toggle-row">
              <input type="checkbox" name="archive_dot_commands" ${settings.archive_dot_commands === false ? "" : "checked"} />
              <span>点命令进入归档</span>
            </label>
            <label class="toggle-row">
              <input type="checkbox" name="archive_bot_replies" ${settings.archive_bot_replies === false ? "" : "checked"} />
              <span>普通天尊回复进入归档</span>
            </label>
            <p class="modal-status-line info" id="filterSettingsStatus" hidden></p>
          </form>
        </section>
      `,
      footer: `
        <button type="button" data-modal-close>取消</button>
        <button type="button" class="primary" id="filterSettingsSave">保存并刷新</button>
      `,
    });
    if (!dialog) return;
    bindFilterSettingsModal(dialog, {
      fetchMessageById,
      findMessageById,
      jumpToMessage,
      muteFocusSenderId,
      renderFocusArchivePreview,
      saveFilterSettings,
    });
  }

  function bindFilterSettingsModal(dialog, deps) {
    const status = dialog.querySelector("#filterSettingsStatus");
    const form = dialog.querySelector("#filterSettingsForm");
    const keywordTextarea = form?.querySelector('[name="focus_keywords"]');
    const excludeTextarea = form?.querySelector('[name="focus_exclude_patterns"]');
    const excludeDraft = dialog.querySelector("#filterExcludeDraft");
    const previewBox = dialog.querySelector("#filterRulePreview");
    const diagnosticsBox = dialog.querySelector("#filterDiagnosticsBox");
    const setStatus = (kind, text) => {
      if (!status) return;
      status.hidden = !text;
      status.className = `modal-status-line ${kind}`;
      status.textContent = text || "";
    };

    dialog.querySelectorAll("[data-filter-keyword-preset]").forEach((button) => {
      button.addEventListener("click", () => appendUniqueLine(keywordTextarea, button.dataset.filterKeywordPreset || ""));
    });
    dialog.querySelectorAll("[data-filter-exclude-preset]").forEach((button) => {
      button.addEventListener("click", async () => {
        const value = button.dataset.filterExcludePreset || "";
        if (excludeDraft) excludeDraft.value = value;
        await previewAndMaybeAppendFilterRule({
          mode: button.dataset.mode || "contains",
          input: excludeDraft,
          target: excludeTextarea,
          previewBox,
          append: true,
          renderFocusArchivePreview: deps.renderFocusArchivePreview,
          setStatus,
        });
      });
    });
    dialog.querySelector("#filterExcludePreview")?.addEventListener("click", () => {
      previewAndMaybeAppendFilterRule({
        mode: looksLikeRegex(excludeDraft?.value || "") ? "regex" : "contains",
        input: excludeDraft,
        target: excludeTextarea,
        previewBox,
        append: false,
        renderFocusArchivePreview: deps.renderFocusArchivePreview,
        setStatus,
      });
    });
    dialog.querySelector("#filterExcludeAddContains")?.addEventListener("click", () => {
      previewAndMaybeAppendFilterRule({
        mode: "contains",
        input: excludeDraft,
        target: excludeTextarea,
        previewBox,
        append: true,
        renderFocusArchivePreview: deps.renderFocusArchivePreview,
        setStatus,
      });
    });
    dialog.querySelector("#filterExcludeAddRegex")?.addEventListener("click", () => {
      previewAndMaybeAppendFilterRule({
        mode: "regex",
        input: excludeDraft,
        target: excludeTextarea,
        previewBox,
        append: true,
        renderFocusArchivePreview: deps.renderFocusArchivePreview,
        setStatus,
      });
    });
    dialog.querySelector("#filterDiagnosticsButton")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus("info", "正在统计最近消息归类原因…");
      if (diagnosticsBox) diagnosticsBox.innerHTML = '<p class="empty inline">统计中…</p>';
      try {
        const payload = await fetchJson("/api/filter/diagnostics?limit=1000");
        if (!payload.ok) throw new Error(payload.error || "诊断失败");
        if (diagnosticsBox) diagnosticsBox.innerHTML = renderFilterDiagnostics(payload);
        bindFilterDiagnosticsActions({
          diagnosticsBox,
          excludeDraft,
          excludeTextarea,
          previewBox,
          setStatus,
          ...deps,
        });
        setStatus("ok", `最近 ${payload.scanned || 0} 条：重点 ${payload.focus_count || 0}｜归档 ${payload.archive_count || 0}｜会长 ${payload.leader_count || 0}`);
      } catch (error) {
        if (diagnosticsBox) diagnosticsBox.innerHTML = "";
        setStatus("error", error.message || "诊断失败");
      } finally {
        button.disabled = false;
      }
    });
    dialog.querySelector("#filterSettingsSave")?.addEventListener("click", async () => {
      const data = new FormData(form);
      setStatus("info", "保存中…");
      try {
        const saved = await deps.saveFilterSettings({
          own_aliases: splitLines(data.get("own_aliases")),
          leader_sender_ids: splitLines(data.get("leader_sender_ids")),
          leader_source_names: splitLines(data.get("leader_source_names")),
          focus_muted_sender_ids: splitLines(data.get("focus_muted_sender_ids")),
          focus_muted_source_names: splitLines(data.get("focus_muted_source_names")),
          focus_keywords: splitLines(data.get("focus_keywords")),
          focus_exclude_patterns: splitRows(data.get("focus_exclude_patterns")),
          focus_include_player_plain: data.get("focus_include_player_plain") === "on",
          archive_dot_commands: data.get("archive_dot_commands") === "on",
          archive_bot_replies: data.get("archive_bot_replies") === "on",
        });
        setStatus("ok", `已保存。${saved.rebuilt_messages ? `已重分流 ${saved.rebuilt_messages} 条历史消息。` : "历史消息无需重分流。"}`);
      } catch (error) {
        setStatus("error", error.message || "保存失败");
      }
    });
  }

  function splitLines(value) {
    return String(value || "")
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function splitRows(value) {
    return String(value || "")
      .split(/\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function appendUniqueLine(textarea, value) {
    if (!textarea) return false;
    const item = String(value || "").trim();
    if (!item) return false;
    const rows = splitRows(textarea.value);
    if (!rows.includes(item)) {
      rows.push(item);
      textarea.value = rows.join("\n");
    }
    textarea.focus();
    return true;
  }

  function looksLikeRegex(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    return text.startsWith("^") || text.endsWith("$") || /[\\[\]().+*?|{}]/.test(text);
  }

  async function previewAndMaybeAppendFilterRule({
    mode,
    input,
    target,
    previewBox,
    append,
    renderFocusArchivePreview,
    setStatus,
  }) {
    const value = String(input?.value || "").trim();
    if (!value) {
      setStatus?.("warn", "先输入要排除的短语或正则。");
      return null;
    }
    setStatus?.("info", "正在预览规则影响…");
    if (previewBox) previewBox.innerHTML = '<p class="empty inline">预览中…</p>';
    try {
      const preview = await postJson("/api/focus-exclude/preview", { mode, text: value });
      if (!preview.ok) throw new Error(preview.error || "预览失败");
      if (previewBox) previewBox.innerHTML = renderFocusArchivePreview(preview);
      if (append && preview.pattern) {
        appendUniqueLine(target, preview.pattern);
        setStatus?.("ok", `已加入排除规则：${preview.pattern}。预览影响 ${preview.total || 0} 条，点击保存后才会重分流。`);
      } else {
        setStatus?.("ok", `预览完成：${preview.pattern}，影响 ${preview.total || 0} 条。`);
      }
      return preview;
    } catch (error) {
      if (previewBox) previewBox.innerHTML = "";
      setStatus?.("error", error.message || "预览失败");
      return null;
    }
  }

  function renderFilterDiagnostics(payload) {
    const reasons = payload.reason_rows || [];
    const senders = payload.focus_sender_rows || [];
    const samples = payload.samples || [];
    return `
      <div class="filter-diagnostics-grid">
        <div>
          <strong>入流原因 Top</strong>
          <ul class="send-as-result-list">
            ${reasons.slice(0, 8).map((item) => `<li class="ok"><span>${escapeHtml(item.reason || "")}</span><small>${escapeHtml(formatNumber(item.count || 0))} 条</small></li>`).join("") || "<li>(空)</li>"}
          </ul>
        </div>
        <div>
          <strong>重点发送者 Top</strong>
          <ul class="send-as-result-list">
            ${senders.slice(0, 8).map((item) => `
              <li>
                <span>${escapeHtml(item.sender || "")}</span>
                <small>${escapeHtml(formatNumber(item.count || 0))} 条</small>
                ${Number(item.sender_id || 0) ? `<button type="button" data-filter-mute-sender="${escapeAttr(String(item.sender_id))}">静音</button>` : ""}
              </li>
            `).join("") || "<li>(空)</li>"}
          </ul>
        </div>
      </div>
      ${samples.length ? `
        <div class="filter-diagnostics-samples">
          <strong>最近样本</strong>
          ${samples.slice(0, 6).map((item) => `
            <p>
              <b>#${escapeHtml(String(item.seq || ""))} ${escapeHtml(item.source || "")}</b>
              <small>${escapeHtml((item.channels || []).join("/"))}｜${escapeHtml((item.reasons || []).join("、") || "无理由")}</small>
              <span>${escapeHtml(clipGraphemes(item.summary || item.title || "", 70))}</span>
              <em>
                ${item.id ? `<button type="button" data-filter-jump-id="${escapeAttr(String(item.id))}">定位</button>` : ""}
                ${Number(item.sender_id || 0) ? `<button type="button" data-filter-mute-sender="${escapeAttr(String(item.sender_id))}">静音 sender</button>` : ""}
                ${(item.summary || item.title) ? `<button type="button" data-filter-exclude-text="${escapeAttr(clipGraphemes(item.summary || item.title || "", 36))}">排除这类短语</button>` : ""}
              </em>
            </p>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  function bindFilterDiagnosticsActions({
    diagnosticsBox,
    excludeDraft,
    excludeTextarea,
    fetchMessageById,
    findMessageById,
    jumpToMessage,
    muteFocusSenderId,
    previewBox,
    renderFocusArchivePreview,
    setStatus,
  }) {
    if (!diagnosticsBox) return;
    diagnosticsBox.querySelectorAll("[data-filter-mute-sender]").forEach((button) => {
      button.addEventListener("click", async () => {
        const senderId = Number(button.dataset.filterMuteSender || 0);
        if (!senderId) return;
        try {
          await muteFocusSenderId(senderId, button);
          setStatus?.("ok", `已更新 sender ${senderId} 的重点流静音设置。`);
        } catch (error) {
          setStatus?.("error", error.message || "静音失败");
        }
      });
    });
    diagnosticsBox.querySelectorAll("[data-filter-exclude-text]").forEach((button) => {
      button.addEventListener("click", async () => {
        const text = String(button.dataset.filterExcludeText || "").trim();
        if (!text) return;
        if (excludeDraft) excludeDraft.value = text;
        await previewAndMaybeAppendFilterRule({
          mode: "contains",
          input: excludeDraft,
          target: excludeTextarea,
          previewBox,
          append: true,
          renderFocusArchivePreview,
          setStatus,
        });
      });
    });
    diagnosticsBox.querySelectorAll("[data-filter-jump-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = String(button.dataset.filterJumpId || "");
        if (!id) return;
        let target = findMessageById(id);
        if (!target) target = await fetchMessageById(id);
        if (target) {
          closeModal();
          jumpToMessage(target);
        }
      });
    });
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.filterSettings = { openFilterSettingsModal };
})();
