// MINIWEB-VIEW: Xutian oracle guide modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  async function openXutianOracleGuideModal({ fillCommand, loadXutianOracleGuide } = {}) {
    const dialog = openModal({
      title: "虚天攻略",
      body: `
        <section class="modal-section xutian-guide-modal">
          <div class="xutian-guide-head">
            <div>
              <strong>卦象样本库</strong>
              <span>只读参考，按钮只填入发送栏，不会自动发送。</span>
            </div>
            <label class="message-search xutian-guide-search">
              <span>搜索</span>
              <input id="xutianGuideSearch" type="search" placeholder="卦象 / 路线 / 来源" autocomplete="off" />
            </label>
          </div>
          <div class="quick-filters xutian-guide-filters">
            <button type="button" class="quick-filter-chip active" data-xutian-guide-filter="all">全部</button>
            <button type="button" class="quick-filter-chip" data-xutian-guide-filter="explicit">明示</button>
            <button type="button" class="quick-filter-chip" data-xutian-guide-filter="success">顺例</button>
            <button type="button" class="quick-filter-chip" data-xutian-guide-filter="failure">反例</button>
          </div>
          <div id="xutianGuideSummary" class="xutian-guide-summary">加载中...</div>
          <div id="xutianGuideList" class="xutian-guide-list">
            <p class="empty inline">加载中...</p>
          </div>
        </section>
      `,
      footer: `
        <button type="button" id="xutianGuideRefresh">刷新攻略</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;

    const local = { payload: null, filter: "all", query: "", loading: false };
    const load = async () => {
      local.loading = true;
      renderXutianGuide(dialog, local, { fillCommand });
      try {
        if (typeof loadXutianOracleGuide !== "function") {
          throw new Error("xutianGuide missing dependency: loadXutianOracleGuide");
        }
        local.payload = await loadXutianOracleGuide();
      } catch (error) {
        local.payload = { ok: false, error: error.message || "读取失败", cases: {}, counts: {} };
      } finally {
        local.loading = false;
      }
      renderXutianGuide(dialog, local, { fillCommand });
    };

    dialog.querySelectorAll("[data-xutian-guide-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        dialog.querySelectorAll("[data-xutian-guide-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        local.filter = button.dataset.xutianGuideFilter || "all";
        renderXutianGuide(dialog, local, { fillCommand });
      });
    });
    dialog.querySelector("#xutianGuideSearch")?.addEventListener("input", (event) => {
      local.query = event.target.value || "";
      renderXutianGuide(dialog, local, { fillCommand });
    });
    dialog.querySelector("#xutianGuideRefresh")?.addEventListener("click", () => load());
    await load();
  }

  function renderXutianGuide(dialog, local, deps) {
    const summary = dialog.querySelector("#xutianGuideSummary");
    const list = dialog.querySelector("#xutianGuideList");
    if (!summary || !list) return;
    if (local.loading) {
      summary.textContent = "加载中...";
      list.innerHTML = '<p class="empty inline">加载中...</p>';
      return;
    }
    const payload = local.payload || {};
    if (payload.ok === false) {
      summary.textContent = "读取失败";
      list.innerHTML = `<p class="empty inline">虚天攻略读取失败：${escapeHtml(payload.error || "未知错误")}</p>`;
      return;
    }
    const counts = payload.counts || {};
    const aliases = payload.element_aliases || [];
    summary.innerHTML = `
      <div class="xutian-guide-counts">
        <span><strong>${escapeHtml(formatNumber(counts.explicit || 0))}</strong> 明示</span>
        <span><strong>${escapeHtml(formatNumber(counts.success || 0))}</strong> 顺例</span>
        <span><strong>${escapeHtml(formatNumber(counts.failure || 0))}</strong> 反例</span>
      </div>
      <div class="xutian-guide-aliases">
        ${aliases.map((item) => `
          <span><strong>${escapeHtml(item.label || "")}</strong>${escapeHtml((item.values || []).join(" / "))}</span>
        `).join("")}
      </div>
    `;
    const cases = xutianGuideVisibleCases(payload, local.filter, local.query);
    if (!cases.length) {
      list.innerHTML = '<p class="empty inline">没有匹配的卦象样本。</p>';
      return;
    }
    list.innerHTML = cases.map(renderXutianGuideCase).join("");
    bindXutianGuideCards(list, deps);
  }

  function xutianGuideVisibleCases(payload, filter, query) {
    const allCases = ["explicit", "success", "failure"].flatMap((kind) => (payload.cases?.[kind] || []));
    const needle = cleanText(query).toLowerCase();
    return allCases.filter((item) => {
      if (filter && filter !== "all" && item.kind !== filter) return false;
      if (!needle) return true;
      const haystack = [
        item.kind_label,
        item.gua,
        item.route,
        item.strategy,
        item.source,
        item.advice,
        item.basis,
        item.confidence,
        ...(item.positive_examples || []),
        ...(item.negative_examples || []),
        ...(item.examples || []).map((example) => `${example.route} ${example.strategy} ${example.source}`),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }

  function renderXutianGuideCase(item) {
    const commands = xutianGuideCommands(item);
    const examples = [
      ...(item.positive_examples || []).map((text) => ["顺例", text]),
      ...(item.negative_examples || []).map((text) => ["反例", text]),
    ].slice(0, 3);
    const meta = [
      item.route ? ["路线", item.route] : null,
      item.strategy ? ["阵策", item.strategy] : null,
      item.source ? ["来源", item.source] : null,
      item.confidence ? ["置信", item.confidence] : null,
    ].filter(Boolean);
    return `
      <article class="xutian-guide-card ${escapeAttr(item.kind || "")}">
        <div class="xutian-guide-card-head">
          <span class="xutian-guide-kind">${escapeHtml(item.kind_label || item.kind || "样本")}</span>
          <strong>${escapeHtml(item.gua || "未知卦象")}</strong>
        </div>
        ${meta.length ? `<div class="xutian-guide-meta">${meta.map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
        ${(item.advice || item.basis) ? `
          <p class="xutian-guide-advice">
            ${item.advice ? `<strong>${escapeHtml(item.advice)}</strong>` : ""}
            ${item.basis ? `<span>${escapeHtml(item.basis)}</span>` : ""}
          </p>
        ` : ""}
        ${examples.length ? `
          <div class="xutian-guide-examples">
            ${examples.map(([label, text]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(text)}</span>`).join("")}
          </div>
        ` : ""}
        ${commands.length ? `
          <div class="xutian-guide-actions">
            ${commands.map((command) => `<button type="button" data-xutian-command="${escapeAttr(command)}">${escapeHtml(command)}</button>`).join("")}
          </div>
        ` : ""}
      </article>
    `;
  }

  function xutianGuideCommands(item) {
    const commands = [];
    for (const route of xutianGuideSplitChoices(item.route)) {
      if (route.includes("冰")) commands.push(".选择道路 冰");
      if (route.includes("火")) commands.push(".选择道路 火");
    }
    for (const strategy of xutianGuideSplitChoices(item.strategy)) {
      if (strategy.includes("稳")) commands.push(".阵策 稳");
      if (strategy.includes("压")) commands.push(".阵策 压");
      if (strategy.includes("势")) commands.push(".阵策 势");
    }
    return [...new Set(commands)];
  }

  function xutianGuideSplitChoices(value) {
    return String(value || "")
      .split(/[\/／、；,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function bindXutianGuideCards(root, { fillCommand }) {
    root.querySelectorAll("[data-xutian-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.xutianCommand || "";
        if (!command) return;
        closeModal();
        fillCommand(command);
      });
    });
  }

  function cleanText(value) {
    return String(value ?? "").trim();
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.xutianGuide = { openXutianOracleGuideModal };
})();
