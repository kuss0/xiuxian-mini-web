// MINIWEB-VIEW: game cockpit, primary strip, and action dock
(function () {
  "use strict";

  const { escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function renderGameCockpit(deps = {}) {
    if (!deps.gameCockpit && !deps.gameHud && !deps.gameActionDock && !deps.gamePrimaryStrip) return;
    renderCockpitIdentity(deps);
    renderCockpitModules(deps);
    renderCockpitInbox(deps);
    renderGamePrimaryStrip(deps);
    deps.renderLiveSituationBoard?.();
    renderGameActionDock(deps);
    deps.renderGameSceneBoard?.();
    deps.renderQuestTracker?.();
  }

  function renderGamePrimaryStrip(deps = {}) {
    const gamePrimaryStrip = deps.gamePrimaryStrip;
    if (!gamePrimaryStrip) return;
    if (!isPrimaryStripVisible(gamePrimaryStrip)) {
      gamePrimaryStrip.innerHTML = "";
      gamePrimaryStrip.setAttribute("aria-hidden", "true");
      return;
    }
    const focus = primaryFocusStripModel(deps);
    const dungeon = primaryDungeonStripModel(deps);
    const status = primaryStatusStripModel(deps);
    gamePrimaryStrip.removeAttribute("aria-hidden");
    gamePrimaryStrip.innerHTML = `
      <button type="button" class="game-primary-item focus ${escapeAttr(focus.kind)}" data-primary-strip-action="${escapeAttr(focus.action)}"
              aria-label="${escapeAttr(primaryStripButtonLabel(focus))}" title="${escapeAttr(primaryStripButtonLabel(focus))}">
        <span>${escapeHtml(focus.label)}</span>
        <strong>${escapeHtml(focus.title)}</strong>
        <small>${escapeHtml(focus.meta)}</small>
      </button>
      <button type="button" class="game-primary-item dungeon ${escapeAttr(dungeon.kind)}" data-primary-strip-action="dungeon"
              aria-label="${escapeAttr(primaryStripButtonLabel(dungeon))}" title="${escapeAttr(primaryStripButtonLabel(dungeon))}">
        <span>${escapeHtml(dungeon.label)}</span>
        <strong>${escapeHtml(dungeon.title)}</strong>
        <small>${escapeHtml(dungeon.meta)}</small>
      </button>
      <button type="button" class="game-primary-item status ${escapeAttr(status.kind)}" data-primary-strip-action="status"
              aria-label="${escapeAttr(primaryStripButtonLabel(status))}" title="${escapeAttr(primaryStripButtonLabel(status))}">
        <span>${escapeHtml(status.label)}</span>
        <strong>${escapeHtml(status.title)}</strong>
        <small>${escapeHtml(status.meta)}</small>
      </button>
      <button type="button" class="game-primary-more" data-primary-strip-action="secondary" aria-label="打开工具中心" title="打开工具中心">工具</button>
    `;
    gamePrimaryStrip.querySelectorAll("[data-primary-strip-action]").forEach((button) => {
      button.addEventListener("click", () => {
        handlePrimaryStripAction(deps, button.dataset.primaryStripAction || "").catch((error) => deps.showError?.(error));
      });
    });
  }

  function isPrimaryStripVisible(gamePrimaryStrip) {
    if (!gamePrimaryStrip || gamePrimaryStrip.hidden) return false;
    if (typeof window.getComputedStyle !== "function") return true;
    try {
      const style = window.getComputedStyle(gamePrimaryStrip);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch (error) {
      return true;
    }
  }

  function primaryStripButtonLabel(item = {}) {
    return [item.label, item.title, item.meta].filter(Boolean).join("｜");
  }

  function primaryFocusStripModel(deps = {}) {
    const state = deps.state || {};
    const auditStatus = state.messageAudit?.status || "";
    if (auditStatus && auditStatus !== "ok") {
      return {
        label: "重点",
        title: "消息箱异常",
        meta: deps.healthStatusLabel?.(auditStatus) || auditStatus,
        kind: "warn",
        action: "health",
      };
    }
    const message = primaryFocusMessage(deps);
    if (!message) {
      return {
        label: "重点",
        title: "暂无重点回复",
        meta: deps.collectorLiveStatus?.() || "风险、@我和重点频道会显示在这里",
        kind: "muted",
        action: "overview",
      };
    }
    const meta = deps.worldEventMeta?.(message) || {};
    const actionCount = (message.actions || []).filter((item) => String(item.command || "").trim()).length;
    const preview = deps.liveMessagePreview?.(message, 44) || "";
    return {
      label: meta.label === "我的" ? "重点 / 我的" : "重点",
      title: String(message.title || deps.displaySource?.(message.source) || "重点回复").trim(),
      meta: [
        deps.formatChatTime?.(message.time) || "最近",
        deps.displaySource?.(message.source),
        actionCount ? `${actionCount} 个候选` : preview,
      ].filter(Boolean).join("｜"),
      kind: meta.kind || "focus",
      action: "focus",
    };
  }

  function primaryFocusMessage(deps = {}) {
    const seen = new Set();
    return (deps.summarySignalMessages?.() || [])
      .filter((message) => {
        if (!message?.id || seen.has(message.id)) return false;
        seen.add(message.id);
        const channels = message.channels || [message.channel];
        const tags = message.tags || [];
        if (channels.includes("dungeon")) return false;
        if (message.severity === "risk" || channels.includes("risk")) return true;
        if (deps.isPersonalSignal?.(message)) return true;
        if (channels.includes("leader") || channels.includes("focus")) return true;
        if ((tags.includes("会长") || tags.includes("重点")) && deps.messageKind?.(message) === "bot") return true;
        return false;
      })
      .sort(deps.compareRankThenRecency?.((message) => primaryFocusRank(deps, message)) || (() => 0))[0] || null;
  }

  function primaryFocusRank(deps = {}, message) {
    const channels = message?.channels || [message?.channel];
    const hasCommand = (message?.actions || []).some((item) => String(item.command || "").trim());
    if (message?.severity === "risk" || channels.includes("risk")) return 1;
    if (hasCommand) return 2;
    if (deps.isPersonalSignal?.(message)) return 3;
    if (channels.includes("leader")) return 4;
    if (channels.includes("focus")) return 5;
    return 9;
  }

  function primaryDungeonStripModel(deps = {}) {
    const summary = deps.actionableDungeonSnapshot?.() || deps.currentDungeonSnapshot?.();
    if (!summary) {
      return {
        label: "副本",
        title: "暂无副本线索",
        meta: "苍坤洞府、虚天殿等副本会在这里置顶",
        kind: "muted",
      };
    }
    const actions = (deps.visibleDungeonActions?.(summary) || []).filter((action) => String(action.command || "").trim());
    const meta = [
      summary.status || "副本",
      summary.latestStage || "",
      actions.length ? `${actions.length} 个动作` : "",
      deps.formatChatTime?.(summary.latestMessage?.time) || "",
    ].filter(Boolean).join("｜");
    return {
      label: "副本",
      title: deps.dungeonSummaryDisplayLabel?.(summary) || "副本",
      meta: meta || summary.advice || summary.routeVerdict || "点击查看副本面板",
      kind: summary.statusKind || "dungeon",
    };
  }

  function primaryStatusStripModel(deps = {}) {
    const state = deps.state || {};
    const activeId = Number(state.activeIdentityId || 0) || null;
    const identity = activeId ? deps.identityById?.(activeId) : null;
    const patchMap = new Map((deps.activeIdentityPatches?.() || []).map((item) => [item.key, item.value]));
    const identityName =
      patchMap.get("角色名") ||
      patchMap.get("道号") ||
      identity?.label ||
      identity?.username ||
      (activeId ? String(activeId) : "未选角色");
    const identityMeta = [
      patchMap.get("境界"),
      String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
    ].filter(Boolean).join("｜") || (identity ? "资料待补全" : "先选身份");
    const moduleRow = (deps.overviewModuleRows?.(activeId) || []).find((row) => ["warn", "ready", "running", "cooling"].includes(row.view?.cls)) || null;
    return {
      label: "角色 / CD",
      title: String(identityName),
      meta: moduleRow ? `${moduleRow.view.label} ${moduleRow.view.time}`.trim() : identityMeta,
      kind: moduleRow?.view?.cls || (activeId ? "ready" : "muted"),
    };
  }

  async function handlePrimaryStripAction(deps = {}, action) {
    if (action === "secondary") {
      openSecondaryGamePanel(deps);
      return;
    }
    if (action === "focus") {
      const signal = primaryFocusMessage(deps);
      const message = signal?.id ? await deps.findOrFetchMessage?.(signal.id) : null;
      if (message) {
        deps.jumpToMessage?.(message);
      } else {
        deps.openOverviewDetailPanel?.();
      }
      return;
    }
    if (action === "overview") {
      deps.openOverviewDetailPanel?.();
      return;
    }
    if (action === "dungeon") {
      await deps.openDungeonStatusModal?.();
      return;
    }
    if (action === "health") {
      await deps.openHealthModal?.();
      return;
    }
    deps.openIdentityStatusModal?.();
  }

  function openSecondaryGamePanel(deps = {}) {
    const shell = document.querySelector(".workspace-tools-shell");
    const secondary = document.querySelector(".game-secondary-shell");
    if (shell) shell.open = true;
    if (secondary) {
      secondary.open = true;
      secondary.scrollIntoView({ block: "nearest" });
    } else {
      deps.openOverviewDetailPanel?.();
    }
  }

  function renderCockpitIdentity(deps = {}) {
    const { cockpitIdentity, hudIdentity } = deps;
    if (!cockpitIdentity && !hudIdentity) return;
    const state = deps.state || {};
    const activeId = Number(state.activeIdentityId || 0) || null;
    const identity = activeId ? deps.identityById?.(activeId) : null;
    const account = identity ? deps.accountForIdentity?.(identity) : null;
    const patches = deps.activeIdentityPatches?.() || [];
    const patchMap = new Map(patches.map((item) => [item.key, item.value]));
    const sourceRows = deps.identityProfileSourceRows?.(patches) || [];
    if (!identity) {
      const hudSelect = renderHudIdentitySelect(deps, activeId);
      const emptyHtml = `
        <div class="cockpit-empty">
          <strong>未选择身份</strong>
          <span>左侧选身份后，下方发送栏会自动跟随。</span>
        </div>
      `;
      if (cockpitIdentity) cockpitIdentity.innerHTML = emptyHtml;
      if (hudIdentity) {
        hudIdentity.innerHTML = `
          <div class="hud-empty">
            <strong>未选择身份</strong>
            <span>选择角色后显示状态</span>
            ${hudSelect}
          </div>
        `;
        bindHudIdentitySelect(deps);
      }
      return;
    }

    const name =
      patchMap.get("角色名") ||
      patchMap.get("道号") ||
      identity.label ||
      identity.username ||
      String(identity.send_as_id || "未命名");
    const subtitleParts = [
      patchMap.get("境界"),
      String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
      patchMap.get("灵根"),
    ].filter(Boolean);
    const cultivation = String(patchMap.get("修为") || "");
    const power = String(patchMap.get("综合战力") || "");
    const title = String(patchMap.get("称号") || "").replace(/^【|】$/g, "");
    const canSend = deps.identityCanSend?.(identity);
    const statusClass = !account ? "warn" : canSend ? "ok" : "warn";
    const statusText = !account ? "未绑定账号" : canSend ? "可直接发送" : "账号未就绪";
    const metricRows = [
      ["战力", power || "未读"],
      ["修为", cultivation || "未读"],
      ["称号", title || "未读"],
    ].filter(([, value]) => value);

    if (cockpitIdentity) {
      cockpitIdentity.innerHTML = `
        <div class="cockpit-identity-main">
          <div class="cockpit-avatar">${escapeHtml(deps.sourceInitial?.(name, "player") || "")}</div>
          <div class="cockpit-identity-title">
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml(subtitleParts.join("｜") || "等待消息箱补全角色资料")}</span>
          </div>
          <span class="cockpit-status ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        <div class="cockpit-player-meta">
          ${metricRows.map(([label, value]) => cockpitMetric(label, value)).join("")}
        </div>
        ${renderHudProfileSource(deps, sourceRows)}
      `;
    }

    if (hudIdentity) {
      const hudMetrics = [
        ["境界", patchMap.get("境界") || "未读"],
        ["灵根", patchMap.get("灵根") || "未读"],
        ["战力", power || "未读"],
        ["修为", cultivation || "未读"],
      ];
      hudIdentity.innerHTML = `
        <div class="hud-identity-switch">
          <span>当前角色</span>
          ${renderHudIdentitySelect(deps, activeId)}
        </div>
        <div class="hud-player-main">
          <div class="cockpit-avatar hud-avatar">${escapeHtml(deps.sourceInitial?.(name, "player") || "")}</div>
          <div class="hud-player-title">
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml(subtitleParts.join("｜") || title || "等待角色资料")}</span>
          </div>
          <span class="cockpit-status ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        <div class="hud-player-metrics">
          ${hudMetrics.map(([label, value]) => cockpitMetric(label, value)).join("")}
        </div>
        ${renderHudProfileSource(deps, sourceRows)}
      `;
      bindHudIdentitySelect(deps);
    }
    bindHudSourceButtons(deps);
  }

  function renderHudIdentitySelect(deps = {}, activeId) {
    const state = deps.state || {};
    if (!state.identities?.length) {
      return "";
    }
    const options = [
      `<option value="">未选择</option>`,
      ...state.identities.map((identity) => {
        const id = Number(identity.send_as_id || 0);
        const name = identity.label || identity.username || identity.send_as_id || "未命名";
        const account = deps.accountForIdentity?.(identity);
        const accountLabel = account?.label || identity.account_local_id || "未绑定";
        return `
          <option value="${escapeAttr(String(id))}" ${id === Number(activeId || 0) ? "selected" : ""}>
            ${escapeHtml(String(name))}｜${escapeHtml(String(accountLabel))}
          </option>
        `;
      }),
    ].join("");
    return `<select class="hud-identity-select" data-hud-identity-select aria-label="切换当前角色">${options}</select>`;
  }

  function bindHudIdentitySelect(deps = {}) {
    deps.hudIdentity?.querySelector("[data-hud-identity-select]")?.addEventListener("change", (event) => {
      const id = Number(event.currentTarget.value || 0) || null;
      deps.setActiveIdentity?.(id, { loadPatches: true }).catch((err) => {
        console.warn("[mini-web] switch identity failed:", err);
        deps.showSkillToast?.(`切换身份失败: ${err.message || err}`, "err");
      });
    });
  }

  function renderHudProfileSource(deps = {}, rows) {
    const cleanRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!cleanRows.length) {
      return `
        <button type="button" class="hud-profile-source muted" data-hud-source-status>
          <span>资料来源</span>
          <strong>等待玉牒 / 战力</strong>
        </button>
      `;
    }
    const latest = cleanRows
      .map((row) => row.updatedAt)
      .filter(Boolean)
      .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
    const primary = cleanRows.find((row) => row.sourceMessageId) || cleanRows[0];
    const countText = `${cleanRows.length} 项投影`;
    const timeText = deps.auditTimeLabel?.(latest) || "未知时间";
    const sourceAttr = primary?.sourceMessageId ? `data-hud-source-message="${escapeAttr(primary.sourceMessageId)}"` : "data-hud-source-status";
    return `
      <button type="button" class="hud-profile-source" ${sourceAttr}>
        <span>资料来源</span>
        <strong>${escapeHtml(countText)}｜${escapeHtml(timeText)}</strong>
      </button>
    `;
  }

  function bindHudSourceButtons(deps = {}) {
    [deps.cockpitIdentity, deps.hudIdentity].filter(Boolean).forEach((root) => {
      root.querySelectorAll("[data-hud-source-message]").forEach((button) => {
        button.addEventListener("click", async () => {
          const id = button.dataset.hudSourceMessage || "";
          const message = id ? await deps.findOrFetchMessage?.(id) : null;
          if (message) {
            deps.jumpToMessage?.(message);
          } else {
            deps.openIdentityStatusModal?.();
          }
        });
      });
      root.querySelectorAll("[data-hud-source-status]").forEach((button) => {
        button.addEventListener("click", () => deps.openIdentityStatusModal?.());
      });
    });
  }

  function cockpitMetric(label, value) {
    return `
      <span class="cockpit-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value || "—"))}</strong>
      </span>
    `;
  }

  function renderCockpitModules(deps = {}) {
    const { cockpitModules, hudModules } = deps;
    if (!cockpitModules && !hudModules) return;
    const state = deps.state || {};
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) {
      const empty = '<p class="cockpit-muted">选中身份后显示关键 CD。</p>';
      if (cockpitModules) cockpitModules.innerHTML = empty;
      if (hudModules) hudModules.innerHTML = empty;
      return;
    }
    const moduleStates = state.identityModuleStates?.get(activeId) || [];
    const byKey = new Map(moduleStates.map((item) => [item.module_key, item]));
    const now = Date.now() / 1000;
    const specs = [
      { key: "wild_training", icon: "⚔️", label: "野外" },
      { key: "checkin", icon: "📋", label: "点卯" },
      { key: "tower", icon: "🗼", label: "闯塔" },
      { key: "deep_retreat", icon: "📿", label: "深闭" },
      { key: "retreat_shallow", icon: "🧘", label: "浅闭" },
      { key: "yuanying", icon: "👻", label: "元婴" },
      { key: "second_soul", icon: "🪞", label: "元神" },
      { key: "pet_touch", icon: "🖐️", label: "抚摸" },
      { key: "pet_warm", icon: "♨️", label: "温养" },
      { key: "pet_trial", icon: "🥊", label: "试炼" },
    ];
    const rows = specs.map((spec) => {
      const item = byKey.get(spec.key);
      const summary = item?.summary || {};
      const st = item?.state || {};
      const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
      const startAt = deps.moduleStartTs?.(st) || 0;
      const label = item?.label || spec.label;
      if (!item) {
        return cockpitModuleChip({ icon: spec.icon, label, text: "未知", cls: "unknown" });
      }
      const phase = String(summary.phase || st.phase || "");
      if (phase === "running") {
        if (nextAt > now) {
          const remaining = Math.max(0, nextAt - now);
          const total = Math.max(1, nextAt - startAt);
          const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
          return cockpitModuleChip({
            icon: spec.icon,
            label,
            text: `剩 ${deps.fmtCountdown?.(remaining) || ""}`,
            cls: "cooling",
            nextAt,
            startAt,
            pct,
          });
        }
        return cockpitModuleChip({ icon: spec.icon, label, text: "待结算", cls: "ready" });
      }
      const ready = summary.ready === true || nextAt === 0 || (nextAt > 0 && nextAt <= now);
      if (ready) {
        return cockpitModuleChip({ icon: spec.icon, label, text: "已就绪", cls: "ready" });
      }
      const remaining = Math.max(0, nextAt - now);
      const total = Math.max(1, nextAt - startAt);
      const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      return cockpitModuleChip({
        icon: spec.icon,
        label,
        text: `剩 ${deps.fmtCountdown?.(remaining) || ""}`,
        cls: "cooling",
        nextAt,
        startAt,
        pct,
      });
    });
    const html = rows.join("");
    if (cockpitModules) cockpitModules.innerHTML = html;
    if (hudModules) hudModules.innerHTML = html;
  }

  function cockpitModuleChip({ icon, label, text, cls, nextAt = 0, startAt = 0, pct = 0 }) {
    const liveAttrs = nextAt
      ? ` data-cockpit-timer="1" data-next-at="${nextAt}" data-start-at="${startAt}"`
      : "";
    return `
      <div class="cockpit-module ${escapeAttr(cls || "")}"${liveAttrs}>
        <span class="cockpit-module-icon">${escapeHtml(icon || "•")}</span>
        <span class="cockpit-module-label">${escapeHtml(label || "")}</span>
        <strong class="cockpit-module-time">${escapeHtml(text || "—")}</strong>
        <span class="cockpit-module-bar"><span style="width:${Number(pct || 0).toFixed(1)}%"></span></span>
      </div>
    `;
  }

  function renderCockpitInbox(deps = {}) {
    const { cockpitInbox, hudInbox } = deps;
    if (!cockpitInbox && !hudInbox) return;
    const state = deps.state || {};
    const audit = state.messageAudit || {};
    const messages = audit.messages || {};
    const listener = audit.listener || state.listenerSummary || {};
    const running = listener.running || {};
    const runningCount = Object.keys(running).length;
    const status = audit.status || (runningCount ? "ok" : "warn");
    const latestMsg = audit.latest_target_msg_id || messages.latest_msg_id || 0;
    const latestTime = deps.auditTimeLabel?.(messages.latest_message_time || audit.time || "");
    const gapCount = Number(audit.gap_count || 0);
    const counts = deps.channelMessageCounts?.() || new Map();
    const html = `
      <button type="button" class="cockpit-inbox-status ${escapeAttr(status)}" data-cockpit-action="health">
        <span class="health-dot" aria-hidden="true"></span>
        <strong>${escapeHtml(deps.healthStatusLabel?.(status) || status)}</strong>
        <small>${escapeHtml(deps.listenerStatusText?.(listener, runningCount) || "")}</small>
      </button>
      <div class="cockpit-inbox-line">
        ${cockpitMetric("水位", latestMsg ? `#${formatNumber(latestMsg)}` : "未配置")}
        ${cockpitMetric("断层", `${formatNumber(gapCount)} 段`)}
        ${cockpitMetric("重点", `${formatNumber(counts.get("focus") || 0)} 条`)}
        ${cockpitMetric("最近", latestTime || "暂无")}
      </div>
    `;
    [cockpitInbox, hudInbox].filter(Boolean).forEach((root) => {
      root.innerHTML = html;
      root.querySelector('[data-cockpit-action="health"]')?.addEventListener("click", () => deps.openHealthModal?.());
    });
  }

  function renderGameActionDock(deps = {}) {
    const gameActionDock = deps.gameActionDock;
    if (!gameActionDock) return;
    const state = deps.state || {};
    const active = deps.identityById?.(state.activeIdentityId);
    const activeName = active ? (active.label || active.username || active.send_as_id) : "未选角色";
    const counts = deps.channelMessageCounts?.() || new Map();
    const focusCount = Number(counts.get("focus") || 0);
    const dungeonCount = Number(counts.get("dungeon") || 0);
    const resourceCount = Number(counts.get("resource") || 0) + Number(counts.get("training") || 0);
    const leaderCount = Number(counts.get("leader") || 0);
    const healthStatus = state.messageAudit?.status || (state.listenerSummary?.collector ? "ok" : "warn");
    const questCount = (deps.questTrackerItems?.() || []).length;
    const dungeonSummary = deps.actionableDungeonSnapshot?.() || deps.currentDungeonSnapshot?.();
    const dungeonActions = (deps.visibleDungeonActions?.(dungeonSummary) || []).length;
    const resource = deps.liveResourceSnapshot?.();
    const rareTop = resource?.rareRows?.[0] || null;
    const dungeonMeta = dungeonSummary
      ? `${deps.dungeonSummaryDisplayLabel?.(dungeonSummary) || "副本"} ${dungeonSummary.status || ""}`.trim()
      : (dungeonCount ? `${formatNumber(dungeonCount)} 条` : "房间/卦象");
    const rareMeta = rareTop
      ? `${rareTop.resource_name}${deps.formatResourceAmount?.(rareTop.total_amount, rareTop.unit) || ""}`
      : (resourceCount ? `${formatNumber(resourceCount)} 条` : "收益统计");
    const dockItems = [
      { key: "overview", label: "概览", meta: questCount ? `${formatNumber(questCount)} 待办` : (active ? "右侧面板" : "全局态势") },
      { key: "report", label: "战报", meta: "世界总览" },
      { key: "status", label: "状态", meta: active ? "角色总览" : "先选身份" },
      { key: "intel", label: "情报", meta: leaderCount ? `${formatNumber(leaderCount)} 条` : "会长频道" },
      { key: "dungeon", label: "副本", meta: dungeonActions ? `${formatNumber(dungeonActions)} 动作` : dungeonMeta },
      { key: "guide", label: "攻略", meta: "虚天卦象" },
      { key: "resource", label: "资源", meta: rareMeta },
      { key: "inventory", label: "库存", meta: "批量转移" },
      { key: "schedule", label: "定时", meta: "官方排班" },
      { key: "logs", label: "记录", meta: focusCount ? `重点 ${formatNumber(focusCount)}` : "按天查看" },
      { key: "health", label: "健康", meta: deps.healthStatusLabel?.(healthStatus) || healthStatus },
    ];
    gameActionDock.innerHTML = `
      <div class="game-dock-context">
        <span>当前</span>
        <strong>${escapeHtml(String(activeName))}</strong>
        <div class="game-dock-context-metrics">
          <span><b>待办</b>${escapeHtml(formatNumber(questCount))}</span>
          <span><b>副本</b>${escapeHtml(dungeonSummary ? (dungeonSummary.status || "线索") : "暂无")}</span>
          <span><b>收益</b>${escapeHtml(rareTop ? rareTop.resource_name : "今日")}</span>
        </div>
      </div>
      <div class="game-dock-actions">
        ${dockItems.map((item) => `
          <button type="button" data-game-dock-action="${escapeAttr(item.key)}">
            <strong>${escapeHtml(item.label)}</strong>
            <small>${escapeHtml(item.meta)}</small>
          </button>
        `).join("")}
      </div>
    `;
    gameActionDock.querySelectorAll("[data-game-dock-action]").forEach((button) => {
      button.addEventListener("click", () => handleGameDockAction(deps, button.dataset.gameDockAction || ""));
    });
  }

  async function handleGameDockAction(deps = {}, action) {
    try {
      if (action === "overview") {
        deps.openOverviewDetailPanel?.();
        return;
      }
      if (action === "report") {
        await deps.openWorldReportModal?.();
        return;
      }
      if (action === "status") {
        deps.openIdentityStatusModal?.();
        return;
      }
      if (action === "intel") {
        await deps.openLeaderIntelModal?.();
        return;
      }
      if (action === "dungeon") {
        await deps.openDungeonStatusModal?.();
        return;
      }
      if (action === "guide") {
        await deps.openXutianOracleGuideModal?.();
        return;
      }
      if (action === "resource") {
        await deps.openResourceStatsModal?.();
        return;
      }
      if (action === "inventory") {
        await deps.openInventoryModal?.();
        return;
      }
      if (action === "schedule") {
        await Promise.all([deps.loadAccounts?.(), deps.loadIdentities?.()]);
        await deps.openScheduleModal?.();
        return;
      }
      if (action === "logs") {
        await deps.openLogsModal?.();
        return;
      }
      if (action === "health") {
        await deps.openHealthModal?.();
      }
    } catch (error) {
      deps.showError?.(error);
    }
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.gameCockpit = {
    renderGameCockpit,
    renderGamePrimaryStrip,
    primaryFocusStripModel,
    primaryFocusMessage,
    primaryFocusRank,
    primaryDungeonStripModel,
    primaryStatusStripModel,
    handlePrimaryStripAction,
    openSecondaryGamePanel,
    renderCockpitIdentity,
    renderHudIdentitySelect,
    bindHudIdentitySelect,
    renderHudProfileSource,
    bindHudSourceButtons,
    cockpitMetric,
    renderCockpitModules,
    cockpitModuleChip,
    renderCockpitInbox,
    renderGameActionDock,
    handleGameDockAction,
  };
})();
