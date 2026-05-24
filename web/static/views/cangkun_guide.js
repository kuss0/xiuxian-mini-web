// MINIWEB-VIEW: Cangkun guide modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  async function openCangkunGuideModal({ fillCommand, loadCangkunGuide } = {}) {
    const dialog = openModal({
      title: "苍坤攻略",
      body: `
        <section class="modal-section xutian-guide-modal cangkun-guide-modal">
          <div class="xutian-guide-head">
            <div>
              <strong>苍坤上人洞府</strong>
              <span>入本后阶段路线参考；按钮只填入发送栏，不会自动发送。</span>
            </div>
            <label class="message-search xutian-guide-search">
              <span>搜索</span>
              <input id="cangkunGuideSearch" type="search" placeholder="路线 / 阶段 / 风险" autocomplete="off" />
            </label>
          </div>
          <div class="quick-filters xutian-guide-filters">
            <button type="button" class="quick-filter-chip active" data-cangkun-guide-filter="all">全部</button>
            <button type="button" class="quick-filter-chip" data-cangkun-guide-filter="stage">阶段</button>
            <button type="button" class="quick-filter-chip" data-cangkun-guide-filter="route">路线</button>
            <button type="button" class="quick-filter-chip" data-cangkun-guide-filter="history">历史</button>
          </div>
          <div id="cangkunGuideSummary" class="xutian-guide-summary">加载中...</div>
          <div id="cangkunGuideList" class="xutian-guide-list">
            <p class="empty inline">加载中...</p>
          </div>
        </section>
      `,
      footer: `
        <button type="button" id="cangkunGuideRefresh">刷新攻略</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;

    const local = { payload: null, filter: "all", query: "", loading: false };
    const load = async () => {
      local.loading = true;
      renderCangkunGuide(dialog, local, { fillCommand });
      try {
        if (typeof loadCangkunGuide !== "function") {
          throw new Error("cangkunGuide missing dependency: loadCangkunGuide");
        }
        local.payload = await loadCangkunGuide();
      } catch (error) {
        local.payload = { ok: false, error: error.message || "读取失败" };
      } finally {
        local.loading = false;
      }
      renderCangkunGuide(dialog, local, { fillCommand });
    };

    dialog.querySelectorAll("[data-cangkun-guide-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        dialog.querySelectorAll("[data-cangkun-guide-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        local.filter = button.dataset.cangkunGuideFilter || "all";
        renderCangkunGuide(dialog, local, { fillCommand });
      });
    });
    dialog.querySelector("#cangkunGuideSearch")?.addEventListener("input", (event) => {
      local.query = event.target.value || "";
      renderCangkunGuide(dialog, local, { fillCommand });
    });
    dialog.querySelector("#cangkunGuideRefresh")?.addEventListener("click", () => load());
    await load();
  }

  function renderCangkunGuide(dialog, local, deps) {
    const summary = dialog.querySelector("#cangkunGuideSummary");
    const list = dialog.querySelector("#cangkunGuideList");
    if (!summary || !list) return;
    if (local.loading) {
      summary.textContent = "加载中...";
      list.innerHTML = '<p class="empty inline">加载中...</p>';
      return;
    }
    const payload = local.payload || {};
    if (payload.ok === false) {
      summary.textContent = "读取失败";
      list.innerHTML = `<p class="empty inline">苍坤攻略读取失败：${escapeHtml(payload.error || "未知错误")}</p>`;
      return;
    }
    const stages = payload.stages || [];
    const routes = payload.routes || [];
    const history = payload.history || [];
    summary.innerHTML = `
      <div class="xutian-guide-counts">
        <span><strong>${escapeHtml(payload.default_route || "1 -> 1 -> 2")}</strong> 默认线</span>
        <span><strong>${escapeHtml(formatNumber(stages.length))}</strong> 阶段</span>
        <span><strong>${escapeHtml(formatNumber(routes.filter((item) => item.kind === "risk").length))}</strong> 避坑</span>
      </div>
      <div class="xutian-guide-aliases">
        ${(payload.boundaries || []).map((text) => `<span>${escapeHtml(text)}</span>`).join("")}
      </div>
    `;
    const cards = cangkunGuideVisibleCards(payload, local.filter, local.query);
    if (!cards.length) {
      list.innerHTML = '<p class="empty inline">没有匹配的苍坤攻略条目。</p>';
      return;
    }
    list.innerHTML = cards.map(renderCangkunGuideCard).join("");
    bindCangkunGuideCards(list, deps);
  }

  function cangkunGuideVisibleCards(payload, filter, query) {
    const cards = [
      ...(payload.stages || []).map((item) => ({ type: "stage", ...item })),
      ...(payload.routes || []).map((item) => ({ type: "route", ...item })),
      ...(payload.history || []).map((item) => ({ type: "history", ...item })),
    ];
    const needle = cleanText(query).toLowerCase();
    return cards.filter((item) => {
      if (filter && filter !== "all" && item.type !== filter) return false;
      if (!needle) return true;
      const haystack = [
        item.type,
        item.label,
        item.route,
        item.summary,
        item.advice,
        item.kind_label,
        item.result,
        item.state,
        item.time,
        item.recommendation?.label,
        item.recommendation?.reason,
        ...(item.choices || []).map((choice) => `${choice.choice} ${choice.label} ${choice.advice}`),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }

  function renderCangkunGuideCard(item) {
    if (item.type === "stage") return renderCangkunStageCard(item);
    if (item.type === "route") return renderCangkunRouteCard(item);
    return renderCangkunHistoryCard(item);
  }

  function renderCangkunStageCard(item) {
    const rec = item.recommendation || {};
    const choices = item.choices || [];
    return `
      <article class="xutian-guide-card cangkun-stage ${escapeAttr(rec.stance || "")}">
        <div class="xutian-guide-card-head">
          <span class="xutian-guide-kind">阶段</span>
          <strong>${escapeHtml(item.label || "苍坤阶段")}</strong>
        </div>
        <p class="xutian-guide-advice">
          <strong>${escapeHtml(rec.label || "看原文")}${rec.command ? ` · ${escapeHtml(rec.command)}` : ""}</strong>
          <span>${escapeHtml(rec.reason || "")}</span>
        </p>
        <div class="xutian-guide-examples">
          ${choices.map((choice) => `<span><b>${escapeHtml(choice.choice || "")} ${escapeHtml(choice.label || "")}</b>${escapeHtml(choice.advice || "")}</span>`).join("")}
        </div>
        ${choices.some((choice) => choice.command) ? `
          <div class="xutian-guide-actions">
            ${choices.filter((choice) => choice.command).map((choice) => `
              <button type="button" data-cangkun-command="${escapeAttr(choice.command)}">${escapeHtml(choice.command)} · ${escapeHtml(choice.label || "")}</button>
            `).join("")}
          </div>
        ` : ""}
      </article>
    `;
  }

  function renderCangkunRouteCard(item) {
    return `
      <article class="xutian-guide-card cangkun-route ${escapeAttr(item.kind || "")}">
        <div class="xutian-guide-card-head">
          <span class="xutian-guide-kind">${escapeHtml(item.kind_label || "路线")}</span>
          <strong>${escapeHtml(item.route || "未知路线")}</strong>
        </div>
        <div class="xutian-guide-meta">
          ${item.summary ? `<span><b>说明</b>${escapeHtml(item.summary)}</span>` : ""}
          ${item.advice ? `<span><b>建议</b>${escapeHtml(item.advice)}</span>` : ""}
        </div>
        ${(item.commands || []).length ? `
          <div class="xutian-guide-actions">
            ${(item.commands || []).map((command) => `<button type="button" data-cangkun-command="${escapeAttr(command)}">${escapeHtml(command)}</button>`).join("")}
          </div>
        ` : ""}
      </article>
    `;
  }

  function renderCangkunHistoryCard(item) {
    return `
      <article class="xutian-guide-card cangkun-history ${escapeAttr(item.result || "")}">
        <div class="xutian-guide-card-head">
          <span class="xutian-guide-kind">${escapeHtml(item.result === "success" ? "顺例" : "反例")}</span>
          <strong>${escapeHtml(item.route || "未知路线")}</strong>
        </div>
        <div class="xutian-guide-meta">
          ${item.time ? `<span><b>时间</b>${escapeHtml(item.time)}</span>` : ""}
          ${item.state ? `<span><b>状态</b>${escapeHtml(item.state)}</span>` : ""}
        </div>
      </article>
    `;
  }

  function bindCangkunGuideCards(root, { fillCommand } = {}) {
    root.querySelectorAll("[data-cangkun-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.cangkunCommand || "";
        if (!command) return;
        closeModal();
        if (typeof fillCommand === "function") fillCommand(command);
      });
    });
  }

  function cleanText(value) {
    return String(value ?? "").trim();
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.cangkunGuide = { openCangkunGuideModal };
})();
