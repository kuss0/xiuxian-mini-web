// MINIWEB-VIEW: overview detail panel
(function () {
  "use strict";

  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function overviewState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderOverviewDetailPanel(deps = {}) {
    const state = overviewState(deps);
    const activeId = Number(state.activeIdentityId || 0) || null;
    const identity = activeId ? deps.identityById?.(activeId) : null;
    const patches = deps.activeIdentityPatches?.() || [];
    const patchMap = new Map(patches.map((item) => [item.key, item.value]));
    const sourceRows = (deps.identityProfileSourceRows?.(patches) || []).slice(0, 4);
    const name =
      patchMap.get("角色名") ||
      patchMap.get("道号") ||
      identity?.label ||
      identity?.username ||
      (activeId ? String(activeId) : "未选身份");
    const subtitle = [
      patchMap.get("境界"),
      String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
      patchMap.get("灵根"),
    ].filter(Boolean).join("｜") || "等待消息箱补全角色资料";
    const metrics = [
      ["战力", patchMap.get("综合战力") || "未读"],
      ["修为", patchMap.get("修为") || "未读"],
      ["身份", identity?.kind === "channel" ? "频道" : identity ? "账号" : "未选"],
    ];
    const moduleRows = overviewModuleRows(deps, activeId).slice(0, 6);
    const quests = deps.questTrackerItems?.() || [];
    const scenes = deps.gameSceneSummaries?.() || [];
    return `
      <section class="overview-panel">
        <div class="overview-hero">
          <div class="cockpit-avatar overview-avatar">${escapeHtml(deps.sourceInitial?.(String(name), "player") || "?")}</div>
          <div>
            <span>当前角色</span>
            <strong>${escapeHtml(String(name))}</strong>
            <small>${escapeHtml(subtitle)}</small>
          </div>
        </div>
        <div class="overview-metrics">
          ${metrics.map(([label, value]) => deps.cockpitMetric?.(label, value) || "").join("")}
        </div>
        <div class="overview-actions">
          <button type="button" data-overview-action="status">角色状态</button>
          <button type="button" data-overview-action="report">今日战报</button>
          <button type="button" data-overview-action="refresh">刷新</button>
        </div>

        <section class="overview-section">
          <div class="overview-section-head">
            <strong>关键冷却</strong>
            <span>${escapeHtml(moduleRows.length ? `${moduleRows.length} 项` : "暂无")}</span>
          </div>
          <div class="overview-module-list">
            ${moduleRows.length ? moduleRows.map((row) => renderOverviewModuleRow(row)).join("") : '<p class="empty inline">选择身份后显示关键 CD。</p>'}
          </div>
        </section>

        <section class="overview-section">
          <div class="overview-section-head">
            <strong>任务追踪</strong>
            <span>${escapeHtml(quests.length ? `${quests.length} 条全部显示` : "暂无")}</span>
          </div>
          <div class="overview-quest-list">
            ${quests.length ? quests.map((message) => renderOverviewQuestRow(deps, message)).join("") : '<p class="empty inline">风险、@我和候选动作会出现在这里。</p>'}
          </div>
        </section>

        <section class="overview-section">
          <div class="overview-section-head">
            <strong>场景入口</strong>
            <span>修仙地图</span>
          </div>
          <div class="overview-scene-grid">
            ${scenes.map((scene) => `
              <button type="button" data-overview-scene-channel="${escapeAttr(scene.channel)}">
                <strong>${escapeHtml(scene.title)}</strong>
                <span>${escapeHtml(formatNumber(scene.count))} 条</span>
                <small>${escapeHtml(clipGraphemes(scene.preview || "", 46))}</small>
              </button>
            `).join("")}
          </div>
        </section>

        <section class="overview-section">
          <div class="overview-section-head">
            <strong>资料来源</strong>
            <span>${escapeHtml(sourceRows.length ? "可追溯" : "暂无")}</span>
          </div>
          <div class="overview-source-list">
            ${sourceRows.length ? sourceRows.map((row) => `
              <button type="button" data-overview-source="${escapeAttr(row.sourceMessageId || "")}" ${row.sourceMessageId ? "" : "disabled"}>
                <span>${escapeHtml(row.key)}</span>
                <strong>${escapeHtml(deps.formatFieldValue?.(row.value) || "")}</strong>
                <small>${escapeHtml(deps.auditTimeLabel?.(row.updatedAt) || "未知时间")}</small>
              </button>
            `).join("") : '<p class="empty inline">发送或监听“我的灵根 / 战力”后会更新。</p>'}
          </div>
        </section>
      </section>
    `;
  }

  function overviewModuleRows(deps = {}, activeId) {
    const state = overviewState(deps);
    if (!activeId) return [];
    const stateItems = state.identityModuleStates.get(activeId) || [];
    const byKey = new Map(stateItems.map((item) => [item.module_key, item]));
    const specs = deps.identityStatusFlatSpecs?.() || [];
    const rank = { warn: 0, ready: 1, running: 2, cooling: 3, unknown: 4 };
    return specs
      .map((spec) => ({ spec, item: byKey.get(spec.key), view: deps.identityModuleView?.(spec, byKey.get(spec.key)) || {} }))
      .sort((a, b) => (rank[a.view.cls] ?? 9) - (rank[b.view.cls] ?? 9) || (a.spec.__rank || 0) - (b.spec.__rank || 0));
  }

  function renderOverviewModuleRow(row) {
    return `
      <div class="overview-module-row ${escapeAttr(row.view.cls)}">
        <span>${escapeHtml(row.view.icon)}</span>
        <strong>${escapeHtml(row.view.label)}</strong>
        <small>${escapeHtml(row.view.status)}｜${escapeHtml(row.view.time)}</small>
      </div>
    `;
  }

  function renderOverviewQuestRow(deps = {}, message) {
    const key = deps.questTrackerItemKey?.(message) || "";
    const actionEntries = (message.actions || [])
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => String(action.command || "").trim());
    const { kind, text: kindText } = deps.questItemKind?.(message, actionEntries) || { kind: "info", text: "消息" };
    const preview = clipGraphemes(String(message.summary || message.raw || message.title || "").replace(/\s+/g, " "), 58);
    return `
      <article class="overview-quest-row ${escapeAttr(kind)}">
        <button type="button" data-overview-quest-view="${escapeAttr(key)}">
          <span class="overview-quest-kind ${escapeAttr(kind)}">${escapeHtml(kindText)}</span>
          <strong>${escapeHtml(message.title || deps.displaySource?.(message.source) || "")}</strong>
          <small>${escapeHtml(deps.formatChatTime?.(message.time) || "")}｜${escapeHtml(deps.displaySource?.(message.source) || "")}</small>
          <span>${escapeHtml(preview || "（空消息）")}</span>
        </button>
        ${actionEntries[0] ? `<button type="button" data-overview-quest-action="${escapeAttr(`${key}::${actionEntries[0].index}`)}">${escapeHtml(deps.quickActionLabel?.(actionEntries[0].action) || "")}</button>` : ""}
      </article>
    `;
  }

  function bindOverviewDetailPanel(deps = {}) {
    const detailPanel = deps.detailPanel;
    detailPanel?.querySelector('[data-overview-action="status"]')?.addEventListener("click", () => deps.openIdentityStatusModal?.());
    detailPanel?.querySelector('[data-overview-action="report"]')?.addEventListener("click", () => deps.openWorldReportModal?.().catch((error) => deps.showError?.(error)));
    detailPanel?.querySelector('[data-overview-action="refresh"]')?.addEventListener("click", async () => {
      await Promise.all([deps.refreshChatViewport?.(), deps.loadIdentityPatches?.(), deps.loadIdentityModuleStates?.()]);
      deps.renderDetail?.().catch((error) => console.warn("[mini-web] refresh overview failed:", error));
    });
    detailPanel?.querySelectorAll("[data-overview-scene-channel]").forEach((button) => {
      button.addEventListener("click", () => {
        const channel = button.dataset.overviewSceneChannel || "focus";
        deps.closeWorkspacePanel?.({ rerenderList: false, clearSelection: true });
        deps.applyChannelSelection?.([channel]).catch((error) => deps.showSkillToast?.(`频道加载失败: ${error.message || error}`, "err"));
      });
    });
    detailPanel?.querySelectorAll("[data-overview-source]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.overviewSource || "";
        if (!id) return;
        const message = await deps.findOrFetchMessage?.(id);
        if (message) deps.jumpToMessage?.(message);
      });
    });
    detailPanel?.querySelectorAll("[data-overview-quest-view]").forEach((button) => {
      button.addEventListener("click", async () => {
        await deps.openQuestTrackerItem?.(button.dataset.overviewQuestView || "");
      });
    });
    detailPanel?.querySelectorAll("[data-overview-quest-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const [key, indexText] = String(button.dataset.overviewQuestAction || "").split("::");
        await deps.fillQuestTrackerAction?.(key, Number(indexText || 0), "概览动作");
      });
    });
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.overview = {
    renderOverviewDetailPanel,
    overviewModuleRows,
    renderOverviewModuleRow,
    renderOverviewQuestRow,
    bindOverviewDetailPanel,
  };
})();
