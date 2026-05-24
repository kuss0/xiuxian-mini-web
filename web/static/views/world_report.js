// MINIWEB-VIEW: world report modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  async function openWorldReportModal(deps = {}) {
    const dialog = openModal({
      title: "今日战报",
      body: `
        <section class="modal-section world-report-modal">
          <div id="worldReportBody" class="world-report-body">
            <p class="empty inline">正在读取今日态势...</p>
          </div>
        </section>
      `,
      footer: `
        <button type="button" id="worldReportRefresh">刷新战报</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;
    const load = async () => {
      const body = dialog.querySelector("#worldReportBody");
      const button = dialog.querySelector("#worldReportRefresh");
      if (button) button.disabled = true;
      if (body) body.innerHTML = '<p class="empty inline">正在读取今日态势...</p>';
      try {
        if (typeof deps.loadWorldReportPayload !== "function") {
          throw new Error("worldReport missing dependency: loadWorldReportPayload");
        }
        const payload = await deps.loadWorldReportPayload();
        const { dungeon, resource, leader, priority } = payload || {};
        if (deps.state) {
          deps.state.worldSnapshot = {
            loadedAt: new Date().toISOString(),
            dungeon,
            resource,
            leader,
            priority,
          };
        }
        deps.renderLiveSituationBoard?.();
        deps.renderWorldEventStrip?.();
        deps.renderGameSceneBoard?.();
        deps.renderQuestTracker?.();
        deps.renderGameActionDock?.();
        if (body) body.innerHTML = renderWorldReport(deps, payload);
        bindWorldReport(deps, dialog, payload);
      } catch (error) {
        if (body) body.innerHTML = `<p class="empty inline">战报读取失败：${escapeHtml(error.message || "未知错误")}</p>`;
      } finally {
        if (button) button.disabled = false;
      }
    };
    dialog.querySelector("#worldReportRefresh")?.addEventListener("click", () => load());
    await load();
  }

  function renderWorldReport(deps = {}, payload) {
    const health = payload.health || {};
    const dungeonSummaries = ((payload.dungeon || {}).summaries || []).map(deps.normalizeDungeonStatusSummary);
    const currentDungeon = deps.pickCurrentDungeonSummary?.(dungeonSummaries);
    const resource = payload.resource || {};
    const rows = resource.rows || [];
    const events = resource.event_summary || resource.events || [];
    const latestPeriod = deps.latestResourcePeriod?.(rows, events) || "";
    const periodRows = deps.filterResourceRowsByPeriod?.(rows, latestPeriod) || [];
    const periodEvents = deps.filterResourceRowsByPeriod?.(events, latestPeriod) || [];
    const rareRows = (deps.aggregateRareResourceRows?.(periodRows.filter((row) => row.resource_category === "rare")) || []).slice(0, 6);
    const leaderItems = (payload.leader?.messages || []).slice(0, 4);
    const quests = (deps.questTrackerItems?.() || []).slice(0, 6);
    return `
      <div class="world-report-hero">
        <div>
          <span>消息箱</span>
          <strong>${escapeHtml(worldReportListenerLabel(health))}</strong>
          <small>${escapeHtml(worldReportLatestMessageLabel(deps, health))}</small>
        </div>
        <div>
          <span>当前副本</span>
          <strong>${escapeHtml(currentDungeon ? `${currentDungeon.dungeonName}${currentDungeon.dungeonId ? ` #${currentDungeon.dungeonId}` : ""}` : "暂无")}</strong>
          <small>${escapeHtml(currentDungeon?.status || "最近没有活跃副本线索")}</small>
        </div>
        <div>
          <span>今日资源事件</span>
          <strong>${escapeHtml(formatNumber((resource.events || []).length))}</strong>
          <small>${escapeHtml(latestPeriod || "暂无周期")}</small>
        </div>
        <div>
          <span>情报摘录</span>
          <strong>${escapeHtml(formatNumber(leaderItems.length))}</strong>
          <small>会长 / 天尊普通发言</small>
        </div>
        <div>
          <span>待办动作</span>
          <strong>${escapeHtml(formatNumber(quests.length))}</strong>
          <small>只填入发送栏</small>
        </div>
      </div>
      <div class="world-report-grid">
        <section class="world-report-section wide">
          <div class="world-report-section-head">
            <strong>待办动作</strong>
            <button type="button" data-world-report-open="overview">查看全部</button>
          </div>
          <div class="world-report-quests">
            ${quests.length ? quests.map((message) => renderWorldReportQuestCard(deps, message)).join("") : '<p class="empty inline">暂无风险、@我或待确认动作。</p>'}
          </div>
        </section>
        <section class="world-report-section wide">
          <div class="world-report-section-head">
            <strong>当前副本</strong>
            <button type="button" data-world-report-open="dungeon">副本面板</button>
          </div>
          ${currentDungeon ? deps.renderCurrentDungeonPanel?.(currentDungeon) : '<p class="empty inline">暂无活跃副本线索。</p>'}
        </section>
        <section class="world-report-section">
          <div class="world-report-section-head">
            <strong>野外历练</strong>
            <button type="button" data-world-report-open="resource">资源面板</button>
          </div>
          <div class="world-report-wild">
            ${renderWorldReportWildCards(periodEvents)}
          </div>
        </section>
        <section class="world-report-section">
          <div class="world-report-section-head">
            <strong>稀有产物</strong>
            <button type="button" data-world-report-open="resource">查看统计</button>
          </div>
          <div class="world-report-rare">
            ${rareRows.length ? rareRows.map((row) => `
              <span>
                <strong>${escapeHtml(row.resource_name || "资源")}</strong>
                <em>${escapeHtml(deps.formatResourceAmount?.(row.total_amount, row.unit) || "")}</em>
                <small>${escapeHtml((row.sources || []).slice(0, 2).join(" / ") || "来源")}</small>
              </span>
            `).join("") : '<p class="empty inline">暂无稀有产物统计。</p>'}
          </div>
        </section>
        <section class="world-report-section wide">
          <div class="world-report-section-head">
            <strong>情报摘录</strong>
            <button type="button" data-world-report-open="intel">情报频道</button>
          </div>
          <div class="leader-intel-list world-report-intel-list">
            ${leaderItems.length ? leaderItems.map((message) => deps.renderLeaderIntelCard?.(message) || "").join("") : '<p class="empty inline">暂无情报消息。</p>'}
          </div>
        </section>
      </div>
    `;
  }

  function renderWorldReportQuestCard(deps = {}, message) {
    const key = deps.questTrackerItemKey?.(message) || "";
    const actionEntries = (message.actions || [])
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => String(action.command || "").trim());
    const { kind, text: kindText } = deps.questItemKind?.(message, actionEntries) || { kind: "", text: "待办" };
    const preview = clipGraphemes(
      String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim(),
      86
    );
    return `
      <article class="world-report-quest ${escapeAttr(kind)}">
        <button type="button" data-world-report-quest-view="${escapeAttr(key)}">
          <span>${escapeHtml(kindText)}</span>
          <strong>${escapeHtml(message.title || deps.displaySource?.(message.source) || "待办")}</strong>
          <small>${escapeHtml(deps.formatChatTime?.(message.time) || "")}｜${escapeHtml(deps.displaySource?.(message.source) || "快照")}</small>
          <em>${escapeHtml(preview || "等待查看原文")}</em>
        </button>
        ${actionEntries.length ? `
          <div>
            ${actionEntries.slice(0, 2).map(({ action, index }) => `
              <button type="button" data-world-report-quest-action="${escapeAttr(`${key}::${index}`)}" title="${escapeAttr(String(action.command || ""))}">
                ${escapeHtml(deps.quickActionLabel?.(action) || action.command || "动作")}
              </button>
            `).join("")}
          </div>
        ` : ""}
      </article>
    `;
  }

  function renderWorldReportWildCards(periodEvents) {
    const strategies = ["谨慎", "均衡", "深入"];
    const cards = strategies.map((strategy) => {
      const rows = (periodEvents || []).filter((row) => row.source_type === "wild_training" && String(row.source_name || "").includes(strategy));
      const success = rows.filter((row) => row.result === "success").reduce((sum, row) => sum + Number(row.event_count || 0), 0);
      const failed = rows.filter((row) => row.result === "failed").reduce((sum, row) => sum + Number(row.event_count || 0), 0);
      const cooldown = rows.filter((row) => row.result === "cooldown").reduce((sum, row) => sum + Number(row.event_count || 0), 0);
      const total = success + failed;
      const rate = total ? `${Math.round((success / total) * 100)}%` : "暂无";
      return `
        <article class="world-report-wild-card">
          <span>${escapeHtml(strategy)}</span>
          <strong>${escapeHtml(rate)}</strong>
          <small>${escapeHtml(formatNumber(success))} 成 / ${escapeHtml(formatNumber(failed))} 败｜CD ${escapeHtml(formatNumber(cooldown))}</small>
        </article>
      `;
    });
    return cards.join("");
  }

  function worldReportListenerLabel(health) {
    const running = health?.listener?.running || {};
    const rows = Object.values(running);
    const first = rows[0] || {};
    if (first.status === "running") return "监听运行中";
    if (first.status === "starting") return "监听启动中";
    return rows.length ? String(first.status || "未知") : "未运行";
  }

  function worldReportLatestMessageLabel(deps = {}, health) {
    const messages = health?.messages || {};
    const latest = messages.latest_msg_id ? `#${formatNumber(messages.latest_msg_id)}` : "无水位";
    const time = deps.auditTimeLabel?.(messages.latest_message_time || "") || "";
    return `${latest}${time ? `｜${time}` : ""}`;
  }

  function bindWorldReport(deps = {}, dialog, payload) {
    const dungeonSummaries = ((payload.dungeon || {}).summaries || []).map(deps.normalizeDungeonStatusSummary);
    const body = dialog.querySelector("#worldReportBody");
    if (body && dungeonSummaries.length) {
      deps.bindDungeonStatusCards?.(body, dungeonSummaries);
    }
    body?.querySelectorAll("[data-leader-intel-jump]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.leaderIntelJump || "";
        if (!id) return;
        const message = await deps.findOrFetchMessage?.(id);
        closeModal();
        if (message) deps.jumpToMessage?.(message);
      });
    });
    body?.querySelectorAll("[data-world-report-open]").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = button.dataset.worldReportOpen || "";
        closeModal();
        if (target === "dungeon") {
          await deps.openDungeonStatusModal?.();
        } else if (target === "resource") {
          await deps.openResourceStatsModal?.();
        } else if (target === "intel") {
          await deps.openLeaderIntelModal?.();
        } else if (target === "overview") {
          deps.openOverviewDetailPanel?.();
        }
      });
    });
    body?.querySelectorAll("[data-world-report-quest-view]").forEach((button) => {
      button.addEventListener("click", async () => {
        const key = button.dataset.worldReportQuestView || "";
        closeModal();
        await deps.openQuestTrackerItem?.(key);
      });
    });
    body?.querySelectorAll("[data-world-report-quest-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const [key, indexText] = String(button.dataset.worldReportQuestAction || "").split("::");
        closeModal();
        await deps.fillQuestTrackerAction?.(key, Number(indexText || 0), "战报动作");
      });
    });
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.worldReport = {
    openWorldReportModal,
    renderWorldReport,
    renderWorldReportQuestCard,
    renderWorldReportWildCards,
    worldReportListenerLabel,
    worldReportLatestMessageLabel,
    bindWorldReport,
  };
})();
