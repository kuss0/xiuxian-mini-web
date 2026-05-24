// MINIWEB-VIEW: focus archive rule modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeHtml } = window.MiniwebFormat;

  function openFocusArchiveModal({
    applyFocusExcludePattern,
    formatChatTime,
    message,
    mode,
    previewFocusExcludePattern,
  }) {
    const text = focusArchiveBaseText(message);
    const title = mode === "contains" ? "归档包含短语" : "归档这句话";
    const help = mode === "contains"
      ? "输入一个短语；命中该短语的普通重点消息会转入归档。关键词关注仍可对其他消息生效。"
      : "按完整文本生成精确规则；只会归档完全相同的普通重点消息。";
    const dialog = openModal({
      title,
      body: `
        <section class="modal-section">
          <p class="muted">${escapeHtml(help)}</p>
          <label class="stacked-field">
            <span>${mode === "contains" ? "短语" : "完整文本"}</span>
            <textarea id="focusArchiveText" rows="${mode === "contains" ? "2" : "4"}">${escapeHtml(text)}</textarea>
          </label>
          <p class="modal-status-line info" id="focusArchiveStatus">先预览影响范围，再确认保存规则。</p>
          <div id="focusArchivePreview" class="focus-preview-box"></div>
        </section>
      `,
      footer: `
        <button type="button" data-modal-close>取消</button>
        <button type="button" id="focusArchivePreviewButton">预览影响</button>
        <button type="button" class="primary" id="focusArchiveApplyButton" disabled>确认归档此类</button>
      `,
    });
    if (!dialog) return;

    let lastPreview = null;
    const input = dialog.querySelector("#focusArchiveText");
    const status = dialog.querySelector("#focusArchiveStatus");
    const previewBox = dialog.querySelector("#focusArchivePreview");
    const applyButton = dialog.querySelector("#focusArchiveApplyButton");
    const previewButton = dialog.querySelector("#focusArchivePreviewButton");
    const setStatus = (kind, value) => {
      status.className = `modal-status-line ${kind}`;
      status.textContent = value;
    };

    previewButton?.addEventListener("click", async () => {
      const value = String(input?.value || "").trim();
      if (!value) {
        setStatus("warn", "内容为空，不能生成规则。");
        return;
      }
      previewButton.disabled = true;
      applyButton.disabled = true;
      setStatus("info", "正在预览…");
      try {
        if (typeof previewFocusExcludePattern !== "function") {
          throw new Error("focusArchive missing dependency: previewFocusExcludePattern");
        }
        lastPreview = await previewFocusExcludePattern({ mode, text: value });
        if (!lastPreview.ok) throw new Error(lastPreview.error || "预览失败");
        previewBox.innerHTML = renderFocusArchivePreview(lastPreview, { formatChatTime });
        setStatus("ok", `规则已生成：${lastPreview.pattern}`);
        applyButton.disabled = false;
      } catch (error) {
        lastPreview = null;
        previewBox.innerHTML = "";
        setStatus("error", error.message || "预览失败");
      } finally {
        previewButton.disabled = false;
      }
    });

    applyButton?.addEventListener("click", async () => {
      if (!lastPreview || !lastPreview.pattern) return;
      applyButton.disabled = true;
      setStatus("info", "正在保存规则并重分流…");
      try {
        await applyFocusExcludePattern(lastPreview.pattern);
        closeModal();
      } catch (error) {
        applyButton.disabled = false;
        setStatus("error", error.message || "保存失败");
      }
    });
  }

  function focusArchiveBaseText(message) {
    const raw = String(message?.raw || message?.summary || "").trim();
    if (!raw) return "";
    return clipGraphemes(raw, 500);
  }

  function renderFocusArchivePreview(preview, { formatChatTime } = {}) {
    const samples = preview.samples || [];
    const timeLabel = typeof formatChatTime === "function" ? formatChatTime : (value) => String(value || "");
    const sampleHtml = samples.length
      ? samples.map((item) => `
          <li>
            <strong>${escapeHtml(item.source || String(item.sender_id || "未知"))}</strong>
            <span>${escapeHtml(timeLabel(item.time) || item.time || "")}</span>
            <p>${escapeHtml(item.text || "")}</p>
          </li>
        `).join("")
      : "<li><p>当前历史里没有会被这条规则影响的普通重点消息。</p></li>";
    const regexWarn = preview.invalid_regex
      ? `<p class="modal-status-line warn">正则无效，已按纯文本完全相等预览：${escapeHtml(preview.invalid_regex)}</p>`
      : "";
    return `
      <div class="focus-preview-counts">
        <span>近 24 小时：<strong>${Number(preview.last_24h || 0)}</strong></span>
        <span>近 7 天：<strong>${Number(preview.last_7d || 0)}</strong></span>
        <span>全部历史：<strong>${Number(preview.total || 0)}</strong></span>
      </div>
      ${regexWarn}
      <ul class="focus-preview-samples">${sampleHtml}</ul>
    `;
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.focusArchive = {
    openFocusArchiveModal,
    renderFocusArchivePreview,
  };
})();
