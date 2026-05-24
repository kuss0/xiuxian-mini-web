// MINIWEB-VIEW: dungeon status modal shell
(function () {
  "use strict";

  const { fetchJson } = window.MiniwebApi;
  const { openModal } = window.MiniwebModal;

  async function openDungeonStatusModal(deps = {}) {
    const dialog = openModal({
      title: "副本状态",
      body: `
        <section class="modal-section">
          <h4>近期副本汇总</h4>
          <div class="quick-filters dungeon-status-filters">
            <button type="button" class="quick-filter-chip active all" data-dungeon-status-filter="all">全部</button>
            <button type="button" class="quick-filter-chip" data-dungeon-status-filter="live">活跃</button>
            <button type="button" class="quick-filter-chip" data-dungeon-status-filter="open">可加入</button>
            <button type="button" class="quick-filter-chip" data-dungeon-status-filter="done">结束</button>
          </div>
          <div class="quick-filters dungeon-status-filters">
            <button type="button" class="quick-filter-chip active" data-dungeon-summary-limit="3">最近3次</button>
            <button type="button" class="quick-filter-chip" data-dungeon-summary-limit="20">最近20次</button>
            <button type="button" class="quick-filter-chip" data-dungeon-summary-limit="80">更多</button>
          </div>
          <p class="modal-status-line info" id="dungeonStatusLine">正在读取最近副本消息…</p>
        </section>
        <section class="modal-section">
          <div id="dungeonPlaybookPanels" class="dungeon-playbook-panels"></div>
          <div id="dungeonStatusSummary" class="dungeon-status-summary"></div>
          <div id="dungeonStatusList" class="dungeon-status-list">
            <p class="empty inline">加载中…</p>
          </div>
        </section>
      `,
      footer: `
        <button type="button" id="xutianGuideButton">虚天攻略</button>
        <button type="button" id="cangkunGuideButton">苍坤攻略</button>
        <button type="button" id="dungeonStatusRefresh">刷新</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;
    dialog.classList.add("dungeon-status-modal");
    bindDungeonStatusModal(dialog, deps);
    await refreshDungeonStatusModal(dialog, deps);
  }

  function bindDungeonStatusModal(dialog, deps = {}) {
    dialog.querySelector("#dungeonStatusRefresh")?.addEventListener("click", () => {
      refreshDungeonStatusModal(dialog, deps).catch((error) => {
        setDungeonStatusLine(dialog, "error", error.message || "刷新失败");
      });
    });
    dialog.querySelector("#xutianGuideButton")?.addEventListener("click", () => {
      deps.openXutianOracleGuideModal?.().catch((error) => deps.showError?.(error));
    });
    dialog.querySelector("#cangkunGuideButton")?.addEventListener("click", () => {
      deps.openCangkunGuideModal?.().catch((error) => deps.showError?.(error));
    });
    dialog.querySelectorAll("[data-dungeon-status-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        dialog.querySelectorAll("[data-dungeon-status-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        deps.renderDungeonStatusModal?.(
          dialog,
          dialog._dungeonSummaries || [],
          dialog._dungeonRawCount || 0,
          dialog._dungeonTotalCount || 0,
          dialog._dungeonContextMode || ""
        );
      });
    });
    dialog.querySelectorAll("[data-dungeon-summary-limit]").forEach((button) => {
      button.addEventListener("click", () => {
        dialog.querySelectorAll("[data-dungeon-summary-limit]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        dialog._dungeonSummaryLimit = Number(button.dataset.dungeonSummaryLimit || 3) || 3;
        refreshDungeonStatusModal(dialog, deps).catch((error) => {
          setDungeonStatusLine(dialog, "error", error.message || "刷新失败");
        });
      });
    });
  }

  async function refreshDungeonStatusModal(dialog, deps = {}) {
    const refreshButton = dialog.querySelector("#dungeonStatusRefresh");
    const list = dialog.querySelector("#dungeonStatusList");
    const summary = dialog.querySelector("#dungeonStatusSummary");
    const playbooks = dialog.querySelector("#dungeonPlaybookPanels");
    if (refreshButton) refreshButton.disabled = true;
    if (list) list.innerHTML = '<p class="empty inline">加载中…</p>';
    if (summary) summary.innerHTML = "";
    if (playbooks) playbooks.innerHTML = "";
    setDungeonStatusLine(dialog, "info", "正在读取最近副本消息…");
    try {
      const summaryLimit = Number(dialog._dungeonSummaryLimit || 3) || 3;
      const scanLimit = summaryLimit <= 3 ? 90 : 300;
      const [payload, cangkunGuide, xutianGuide] = await Promise.all([
        fetchJson(`/api/dungeon-status?limit=${scanLimit}&summary_limit=${encodeURIComponent(summaryLimit)}&order=recent`),
        fetchJson("/api/cangkun-guide").catch((error) => ({ ok: false, error: error.message || "读取苍坤攻略失败" })),
        fetchJson("/api/xutian-oracle-guide").catch((error) => ({ ok: false, error: error.message || "读取虚天攻略失败" })),
      ]);
      const summaries = (payload.summaries || []).map((item) => deps.normalizeDungeonStatusSummary?.(item) || item);
      dialog._dungeonSummaries = summaries;
      dialog._dungeonRawCount = payload.raw_count || 0;
      dialog._dungeonTotalCount = payload.total_summaries || summaries.length;
      dialog._dungeonContextMode = payload.context_mode || "";
      dialog._dungeonGuides = {
        cangkun: cangkunGuide?.ok === false ? null : cangkunGuide,
        xutian: xutianGuide?.ok === false ? null : xutianGuide,
      };
      deps.renderDungeonStatusModal?.(
        dialog,
        summaries,
        payload.raw_count || 0,
        payload.total_summaries || summaries.length,
        payload.context_mode || ""
      );
    } finally {
      if (refreshButton) refreshButton.disabled = false;
    }
  }

  function setDungeonStatusLine(dialog, kind, text) {
    const status = dialog.querySelector("#dungeonStatusLine");
    if (!status) return;
    status.hidden = !text;
    status.className = `modal-status-line ${kind || "info"}`;
    status.textContent = text || "";
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.dungeonStatus = {
    openDungeonStatusModal,
  };
})();
