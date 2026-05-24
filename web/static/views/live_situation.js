// MINIWEB-VIEW: live situation board and signal snapshots
(function () {
  "use strict";

  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function liveSituationState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderLiveSituationBoard(deps = {}) {
    const liveSituationBoard = deps.liveSituationBoard;
    if (!liveSituationBoard) return;
    const model = liveSituationModel(deps);
    liveSituationBoard.innerHTML = `
      ${model.dungeonHero ? renderLiveDungeonHero(deps, model.dungeonHero) : renderLiveMessageHero(deps, model.primary)}
      <div class="live-situation-grid">
        ${model.dungeonSummary ? renderLiveDungeonSummaryTile(deps, model.dungeonSummary) : renderLiveSituationTile(deps, "dungeon", "当前副本", model.dungeon, "暂无副本线索", "dungeon")}
        ${renderLiveSituationTile(deps, "risk", "风险 / 我的", model.mine, "暂无风险或 @ 我", "mine")}
        ${model.resourceSummary ? renderLiveResourceSummaryTile(deps, model.resourceSummary) : renderLiveSituationTile(deps, "resource", "近期收益", model.resource, "暂无收益记录", "resource")}
        ${renderLiveCooldownTile(moduleRowView(model.module))}
      </div>
    `;
    bindLiveSituationBoard(deps, liveSituationBoard);
  }

  function liveSituationModel(deps = {}) {
    const state = liveSituationState(deps);
    const source = summarySignalMessages(deps);
    const sorted = [...source]
      .filter((message) => message?.id)
      .sort(rankComparator(deps));
    const withAction = sorted.find((message) => (message.actions || []).some((item) => String(item.command || "").trim())) || null;
    const withActionChannels = withAction ? (withAction.channels || [withAction.channel]) : [];
    const mine = sorted.find((message) => {
      return isPersonalSignal(deps, message);
    }) || null;
    const dungeon = sorted.find((message) => (message.channels || [message.channel]).includes("dungeon")) || null;
    const resource = sorted.find((message) => {
      const channels = message.channels || [message.channel];
      return channels.includes("resource") || channels.includes("training") || channels.includes("home");
    }) || null;
    const dungeonSummary = deps.actionableDungeonSnapshot?.() || currentDungeonSnapshot(deps);
    const dungeonIsLive = dungeonSummary && ["open", "choice", "active", "joined"].includes(dungeonSummary.statusKind);
    const dungeonHero = dungeonIsLive && !mine && (!withAction || withActionChannels.includes("dungeon"))
      ? dungeonSummary
      : null;
    const activeId = Number(state.activeIdentityId || 0) || null;
    const module = (deps.overviewModuleRows?.(activeId) || [])[0] || null;
    return {
      primary: mine || withAction || dungeon || resource || latestLeaderSnapshotMessage(deps) || sorted[0] || null,
      dungeonSummary,
      dungeonHero,
      mine,
      dungeon,
      resource,
      resourceSummary: liveResourceSnapshot(deps),
      module,
    };
  }

  function rankComparator(deps = {}) {
    const rankFn = deps.worldEventRank || (() => 99);
    if (deps.compareRankThenRecency) return deps.compareRankThenRecency(rankFn);
    return (a, b) => rankFn(a) - rankFn(b);
  }

  function renderLiveMessageHero(deps = {}, primary) {
    const primaryAction = (primary?.actions || []).find((item) => String(item.command || "").trim());
    const primaryPreview = primary
      ? liveMessagePreview(primary, 110)
      : "监听运行后，这里会汇总最新风险、副本、收益和关键回复。";
    const primaryMeta = primary
      ? `${deps.formatChatTime?.(primary.time) || "最近"}｜${deps.displaySource?.(primary.source) || ""}`
      : deps.collectorLiveStatus?.() || "等待消息箱";
    return `
      <article class="live-situation-hero ${primary ? escapeAttr(liveMessageKind(deps, primary)) : "empty"}">
        <div class="live-situation-title">
          <span>当前态势</span>
          <strong>${escapeHtml(primary?.title || "等待游戏事件")}</strong>
          <small>${escapeHtml(primaryMeta)}</small>
        </div>
        <p>${escapeHtml(primaryPreview)}</p>
        <div class="live-situation-actions">
          ${primary ? `<button type="button" data-live-message="${escapeAttr(primary.id || "")}">查看原文</button>` : ""}
          ${primaryAction ? `<button type="button" data-live-action="${escapeAttr(primary.id || "")}">填入 ${escapeHtml(deps.quickActionLabel?.(primaryAction) || primaryAction.command || "动作")}</button>` : ""}
          <button type="button" data-live-panel="overview">打开概览</button>
        </div>
      </article>
    `;
  }

  function renderLiveDungeonHero(deps = {}, summary) {
    const title = deps.dungeonSummaryDisplayLabel?.(summary) || "副本";
    const advice = [summary?.advice, summary?.routeVerdict, summary?.teamFit].filter(Boolean).join("｜");
    const primaryActions = (deps.visibleDungeonActions?.(summary) || []).slice(0, 3);
    return `
      <article class="live-situation-hero dungeon-live ${escapeAttr(summary?.statusKind || "")}">
        <div class="live-situation-title">
          <span>当前副本</span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(deps.formatChatTime?.(summary?.latestMessage?.time) || summary?.latestMessage?.time || "最近")}</small>
        </div>
        <p>${escapeHtml(advice || summary?.status || summary?.latestStage || "副本线索已汇总，点击面板看原文和时间线。")}</p>
        <div class="live-situation-metrics">
          <span><b>阶段</b>${escapeHtml(summary?.latestStage || "未读")}</span>
          <span><b>状态</b>${escapeHtml(summary?.status || "副本")}</span>
          <span><b>人数</b>${escapeHtml(summary?.capacity || (summary?.joinSuccess?.length ? `${summary.joinSuccess.length} 人` : "未读"))}</span>
        </div>
        <div class="live-situation-actions">
          ${primaryActions.map((action, index) => `
            <button type="button" data-live-dungeon-action="${index}" title="${escapeAttr(action.command || "")}">
              填入 ${escapeHtml(action.label || action.command || "动作")}
            </button>
          `).join("")}
          <button type="button" data-live-panel="dungeon">副本面板</button>
        </div>
      </article>
    `;
  }

  function currentDungeonSnapshot(deps = {}) {
    const state = liveSituationState(deps);
    const summaries = ((state.worldSnapshot?.dungeon || {}).summaries || []).map(deps.normalizeDungeonStatusSummary || ((item) => item));
    return deps.pickCurrentDungeonSummary?.(summaries) || null;
  }

  function latestLeaderSnapshotMessage(deps = {}) {
    const state = liveSituationState(deps);
    return ((state.worldSnapshot?.leader || {}).messages || [])[0] || null;
  }

  function snapshotPriorityMessages(deps = {}) {
    const state = liveSituationState(deps);
    return ((state.worldSnapshot?.priority || {}).messages || []).filter((message) => {
      if (!message?.id) return false;
      if (isArchivedOnlySignal(message)) return false;
      const channels = message.channels || [message.channel];
      return channels.includes("risk") || channels.includes("focus") || (message.tags || []).includes("被@") || (message.tags || []).includes("回复我");
    });
  }

  function isArchivedOnlySignal(message) {
    const channels = message?.channels || [message?.channel];
    if (!channels.includes("archive")) return false;
    if (message?.severity === "risk" || channels.includes("risk")) return false;
    const tags = message?.tags || [];
    if (tags.includes("被@") || tags.includes("回复我") || tags.includes("我发出")) return false;
    return true;
  }

  function isPersonalSignal(deps = {}, message) {
    const channels = message?.channels || [message?.channel];
    const tags = message?.tags || [];
    if (message?.severity === "risk" || channels.includes("risk")) return true;
    if (tags.includes("被@") || tags.includes("回复我") || tags.includes("我发出")) return true;
    return channels.includes("mine") && !isArchivedOnlySignal(message);
  }

  function summarySignalMessages(deps = {}) {
    const state = liveSituationState(deps);
    const base = state.channelSummaryMessages?.length ? state.channelSummaryMessages : state.messages || [];
    const byId = new Map();
    for (const message of [...snapshotPriorityMessages(deps), ...base]) {
      if (!message?.id || byId.has(message.id)) continue;
      if (isArchivedOnlySignal(message)) continue;
      byId.set(message.id, message);
    }
    return Array.from(byId.values());
  }

  function liveResourceSnapshot(deps = {}) {
    const state = liveSituationState(deps);
    const payload = state.worldSnapshot?.resource || null;
    if (!payload) return null;
    const rows = payload.rows || [];
    const eventSummary = payload.event_summary || [];
    const latestPeriod = deps.latestResourcePeriod?.(rows, eventSummary);
    const periodEvents = deps.filterResourceRowsByPeriod?.(eventSummary, latestPeriod) || [];
    const periodRows = deps.filterResourceRowsByPeriod?.(rows, latestPeriod) || [];
    const wild = {
      success: 0,
      failed: 0,
      cooldown: 0,
    };
    for (const row of periodEvents) {
      if (row.source_type !== "wild_training") continue;
      wild.success += Number(row.success || 0) + Number(row.extra_success || 0);
      wild.failed += Number(row.failed || 0) + Number(row.basic_only || 0);
      wild.cooldown += Number(row.cooldown || 0);
    }
    const rareRows = (deps.aggregateRareResourceRows?.(periodRows) || [])
      .filter((row) => row.total_amount > 0)
      .sort((a, b) => (
        Number(!(deps.isYinNingResource?.(a.resource_name) || false)) - Number(!(deps.isYinNingResource?.(b.resource_name) || false))
        || Number(a.total_amount || 0) - Number(b.total_amount || 0)
        || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
      ))
      .slice(0, 3);
    return {
      latestPeriod,
      eventCount: periodEvents.reduce((sum, row) => sum + Number(row.total || row.event_count || 0), 0),
      wild,
      rareRows,
    };
  }

  function renderLiveSituationTile(deps = {}, kind, label, message, emptyText, panel) {
    const meta = message ? `${deps.formatChatTime?.(message.time) || "最近"}｜${deps.displaySource?.(message.source) || ""}` : "等待消息箱";
    const preview = message ? liveMessagePreview(message, 58) : emptyText;
    const fields = message?.fields || {};
    const dungeonId = fields["副本ID"] ? `#${fields["副本ID"]}` : "";
    const badge = kind === "dungeon" && dungeonId ? dungeonId : (message ? liveMessageKindLabel(deps, message) : "空");
    return `
      <article class="live-situation-tile ${escapeAttr(kind)} ${message ? "" : "empty"}">
        <button type="button" ${message ? `data-live-message="${escapeAttr(message.id || "")}"` : `data-live-panel="${escapeAttr(panel)}"`}>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(message?.title || emptyText)}</strong>
          <small>${escapeHtml(meta)}</small>
          <em>${escapeHtml(preview)}</em>
        </button>
        <button type="button" class="live-situation-badge" data-live-panel="${escapeAttr(panel)}">${escapeHtml(badge)}</button>
      </article>
    `;
  }

  function renderLiveDungeonSummaryTile(deps = {}, summary) {
    const title = `${summary.dungeonName || "副本"}${summary.dungeonId ? ` #${summary.dungeonId}` : ""}`;
    const preview = [summary.advice, summary.routeVerdict, summary.latestStage, summary.openedBy].filter(Boolean).join("｜");
    return `
      <article class="live-situation-tile dungeon ${escapeAttr(summary.statusKind || "")}">
        <button type="button" data-live-panel="dungeon">
          <span>当前副本</span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(deps.formatChatTime?.(summary.latestMessage?.time) || "最近")}｜${escapeHtml(summary.status || "副本")}</small>
          <em>${escapeHtml(preview || "副本状态已从消息箱汇总。")}</em>
        </button>
        <button type="button" class="live-situation-badge" data-live-panel="dungeon">${escapeHtml(summary.status || "副本")}</button>
      </article>
    `;
  }

  function renderLiveResourceSummaryTile(deps = {}, summary) {
    const attempts = summary.wild.success + summary.wild.failed;
    const rate = attempts ? `${Math.round((summary.wild.success * 100) / attempts)}%` : "暂无";
    const rareText = summary.rareRows.length
      ? summary.rareRows.map((row) => `${row.resource_name}${deps.formatResourceAmount?.(row.total_amount, row.unit) || ""}`).join(" / ")
      : "暂无稀有产物";
    return `
      <article class="live-situation-tile resource">
        <button type="button" data-live-panel="resource">
          <span>今日收益</span>
          <strong>野外成功率 ${escapeHtml(rate)}</strong>
          <small>${escapeHtml(summary.latestPeriod || "本期")}｜事件 ${escapeHtml(formatNumber(summary.eventCount))}</small>
          <em>${escapeHtml(rareText)}</em>
        </button>
        <button type="button" class="live-situation-badge" data-live-panel="resource">统计</button>
      </article>
    `;
  }

  function renderLiveCooldownTile(moduleRow) {
    if (!moduleRow) {
      return `
        <article class="live-situation-tile cooldown empty">
          <button type="button" data-live-panel="status">
            <span>关键冷却</span>
            <strong>暂无角色 CD</strong>
            <small>先选择身份</small>
            <em>发送或监听状态消息后会补全。</em>
          </button>
          <button type="button" class="live-situation-badge" data-live-panel="status">状态</button>
        </article>
      `;
    }
    return `
      <article class="live-situation-tile cooldown ${escapeAttr(moduleRow.view.cls)}">
        <button type="button" data-live-panel="status">
          <span>关键冷却</span>
          <strong>${escapeHtml(moduleRow.view.label)}</strong>
          <small>${escapeHtml(moduleRow.view.status)}｜${escapeHtml(moduleRow.view.time)}</small>
          <em>点开角色状态可看完整 CD 和资料来源。</em>
        </button>
        <button type="button" class="live-situation-badge" data-live-panel="status">${escapeHtml(moduleRow.view.icon)}</button>
      </article>
    `;
  }

  function moduleRowView(moduleRow) {
    return moduleRow?.view ? moduleRow : null;
  }

  function bindLiveSituationBoard(deps = {}, liveSituationBoard) {
    liveSituationBoard.querySelectorAll("[data-live-message]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.liveMessage || "";
        const message = id ? await deps.findOrFetchMessage?.(id) : null;
        if (message) deps.jumpToMessage?.(message);
      });
    });
    liveSituationBoard.querySelectorAll("[data-live-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.liveAction || "";
        const message = id ? await deps.findOrFetchMessage?.(id) : null;
        const action = (message?.actions || []).find((item) => String(item.command || "").trim());
        if (!message || !action) return;
        deps.fillDirectSendComposer?.(action.command, {
          identityId: action.identity_id,
          replyContext: deps.directReplyContextFromAction?.(action, message),
          statusText: "已填入当前态势候选动作，请确认后发送。",
          statusKind: "info",
        });
        deps.jumpToMessage?.(message);
      });
    });
    liveSituationBoard.querySelectorAll("[data-live-panel]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const panel = button.dataset.livePanel || "";
        if (panel === "overview") {
          deps.openOverviewDetailPanel?.();
          return;
        }
        await deps.openGameScenePanel?.(panel);
      });
    });
    liveSituationBoard.querySelectorAll("[data-live-dungeon-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const summary = liveSituationModel(deps).dungeonSummary;
        const action = (deps.visibleDungeonActions?.(summary) || [])[Number(button.dataset.liveDungeonAction || 0)];
        if (!action?.command) return;
        deps.fillDirectSendComposer?.(action.command, {
          replyContext: deps.directReplyContextFromAction?.(action),
          statusText: "已填入副本动作，请看原文后手动发送。",
          statusKind: "info",
        });
        const sourceId = action.source_message_id || summary?.latestMessage?.id || "";
        const message = sourceId ? await deps.findOrFetchMessage?.(sourceId) : null;
        if (message) deps.jumpToMessage?.(message);
      });
    });
  }

  function liveMessagePreview(message, limit) {
    return clipGraphemes(String(message?.summary || message?.raw || message?.title || "").replace(/\s+/g, " ").trim(), limit);
  }

  function liveMessageKind(deps = {}, message) {
    const meta = deps.worldEventMeta?.(message) || {};
    return meta.kind || "focus";
  }

  function liveMessageKindLabel(deps = {}, message) {
    const meta = deps.worldEventMeta?.(message) || {};
    return meta.label || "消息";
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.liveSituation = {
    renderLiveSituationBoard,
    bindLiveSituationBoard,
    liveSituationModel,
    renderLiveMessageHero,
    renderLiveDungeonHero,
    currentDungeonSnapshot,
    latestLeaderSnapshotMessage,
    snapshotPriorityMessages,
    isArchivedOnlySignal,
    isPersonalSignal,
    summarySignalMessages,
    liveResourceSnapshot,
    renderLiveSituationTile,
    renderLiveDungeonSummaryTile,
    renderLiveResourceSummaryTile,
    renderLiveCooldownTile,
    liveMessagePreview,
    liveMessageKind,
    liveMessageKindLabel,
  };
})();
