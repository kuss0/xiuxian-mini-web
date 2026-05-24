// MINIWEB-VIEW: leader intelligence modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  async function openLeaderIntelModal({
    applyChannelSelection,
    displaySource,
    findOrFetchMessage,
    formatChatTime,
    jumpToMessage,
    loadLeaderMessages,
  }) {
    const dialog = openModal({
      title: "情报频道",
      body: `
        <section class="modal-section leader-intel-modal">
          <div class="leader-intel-head">
            <div>
              <strong>会长 / 天尊普通发言</strong>
              <span>只读聚合，不自动发送；用于快速看新玩法线索和公告。</span>
            </div>
            <div class="quick-filters leader-intel-filters">
              <button type="button" class="quick-filter-chip active" data-leader-intel-filter="all">全部</button>
              <button type="button" class="quick-filter-chip" data-leader-intel-filter="owner">本人上号</button>
              <button type="button" class="quick-filter-chip" data-leader-intel-filter="tianzun">天尊普通</button>
              <button type="button" class="quick-filter-chip" data-leader-intel-filter="keyword">关键词</button>
              <button type="button" class="quick-filter-chip" data-leader-intel-filter="reply">回复链</button>
            </div>
          </div>
          <div id="leaderIntelSummary" class="leader-intel-summary">加载中...</div>
          <div id="leaderIntelList" class="leader-intel-list">
            <p class="empty inline">加载中...</p>
          </div>
        </section>
      `,
      footer: `
        <button type="button" id="leaderIntelOpenChannel">切到会长频道</button>
        <button type="button" id="leaderIntelRefresh">刷新情报</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;

    const local = { items: [], filter: "all", loading: false };
    const deps = { displaySource, findOrFetchMessage, formatChatTime, jumpToMessage };
    const load = async () => {
      local.loading = true;
      renderLeaderIntelModal(dialog, local, deps);
      try {
        if (typeof loadLeaderMessages !== "function") {
          throw new Error("leaderIntel missing dependency: loadLeaderMessages");
        }
        const payload = await loadLeaderMessages();
        local.items = payload.messages || [];
      } catch (error) {
        local.items = [];
        const list = dialog.querySelector("#leaderIntelList");
        if (list) list.innerHTML = `<p class="empty inline">情报读取失败：${escapeHtml(error.message || "未知错误")}</p>`;
        const summary = dialog.querySelector("#leaderIntelSummary");
        if (summary) summary.textContent = "读取失败";
        return;
      } finally {
        local.loading = false;
      }
      renderLeaderIntelModal(dialog, local, deps);
    };

    dialog.querySelectorAll("[data-leader-intel-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        dialog.querySelectorAll("[data-leader-intel-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        local.filter = button.dataset.leaderIntelFilter || "all";
        renderLeaderIntelModal(dialog, local, deps);
      });
    });
    dialog.querySelector("#leaderIntelRefresh")?.addEventListener("click", () => load());
    dialog.querySelector("#leaderIntelOpenChannel")?.addEventListener("click", async () => {
      closeModal();
      await applyChannelSelection(["leader"]);
    });
    await load();
  }

  function renderLeaderIntelModal(dialog, local, deps) {
    const summary = dialog.querySelector("#leaderIntelSummary");
    const list = dialog.querySelector("#leaderIntelList");
    if (!summary || !list) return;
    if (local.loading) {
      summary.textContent = "加载中...";
      list.innerHTML = '<p class="empty inline">加载中...</p>';
      return;
    }
    const items = leaderIntelFilteredItems(local.items, local.filter);
    const ownerCount = local.items.filter((item) => (item.tags || []).includes("本人上号")).length;
    const tianzunCount = local.items.filter((item) => (item.tags || []).includes("会长上号")).length;
    const keywordCount = local.items.filter((item) => (item.tags || []).some((tag) => String(tag).startsWith("关键词:"))).length;
    summary.innerHTML = `
      <span>全部 <b>${escapeHtml(formatNumber(local.items.length))}</b></span>
      <span>本人上号 <b>${escapeHtml(formatNumber(ownerCount))}</b></span>
      <span>天尊普通 <b>${escapeHtml(formatNumber(tianzunCount))}</b></span>
      <span>关键词 <b>${escapeHtml(formatNumber(keywordCount))}</b></span>
      <span>当前可见 <b>${escapeHtml(formatNumber(items.length))}</b></span>
    `;
    if (!items.length) {
      list.innerHTML = '<p class="empty inline">当前筛选下没有情报。</p>';
      return;
    }
    list.innerHTML = items.map((message) => renderLeaderIntelCard(message, deps)).join("");
    bindLeaderIntelJumps(list, deps);
  }

  function bindLeaderIntelJumps(root, { findOrFetchMessage, jumpToMessage }) {
    root.querySelectorAll("[data-leader-intel-jump]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.leaderIntelJump || "";
        if (!id) return;
        const message = await findOrFetchMessage(id);
        closeModal();
        if (message) jumpToMessage(message);
      });
    });
  }

  function leaderIntelFilteredItems(items, filter) {
    const source = items || [];
    if (filter === "owner") return source.filter((item) => (item.tags || []).includes("本人上号"));
    if (filter === "tianzun") return source.filter((item) => (item.tags || []).includes("会长上号"));
    if (filter === "keyword") return source.filter((item) => (item.tags || []).some((tag) => String(tag).startsWith("关键词:")));
    if (filter === "reply") return source.filter((item) => Number(item.reply_to_msg_id || 0));
    return source;
  }

  function renderLeaderIntelCard(message, { displaySource, formatChatTime } = {}) {
    const sourceLabel = typeof displaySource === "function" ? displaySource : (value) => String(value || "");
    const timeLabel = typeof formatChatTime === "function" ? formatChatTime : (value) => String(value || "");
    const tags = message.tags || [];
    const kind = tags.includes("本人上号")
      ? "本人上号"
      : tags.includes("会长上号")
        ? "天尊普通"
        : "会长";
    const keywordTags = tags.filter((tag) => String(tag).startsWith("关键词:")).slice(0, 3);
    const preview = clipGraphemes(
      String(message.raw || message.summary || message.title || "").replace(/\s+/g, " ").trim() || "（空消息）",
      150
    );
    const replyText = message.reply_to_msg_id ? `回复 #${message.reply_to_msg_id}` : "非回复";
    return `
      <article class="leader-intel-card">
        <div class="leader-intel-card-head">
          <span class="leader-intel-kind">${escapeHtml(kind)}</span>
          <strong>${escapeHtml(sourceLabel(message.source))}</strong>
          <small>${escapeHtml(timeLabel(message.time) || "")}</small>
        </div>
        <p>${escapeHtml(preview)}</p>
        <div class="leader-intel-card-foot">
          <span>${escapeHtml(replyText)}</span>
          ${keywordTags.map((tag) => `<em>${escapeHtml(String(tag).replace(/^关键词:/, ""))}</em>`).join("")}
          <button type="button" data-leader-intel-jump="${escapeAttr(message.id || "")}">定位</button>
        </div>
      </article>
    `;
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.leaderIntel = {
    bindLeaderIntelJumps,
    openLeaderIntelModal,
    renderLeaderIntelCard,
  };
})();
