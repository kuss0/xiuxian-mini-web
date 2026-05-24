// MINIWEB-VIEW: game scene board and manual scene actions
(function () {
  "use strict";

  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function gameSceneState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderGameSceneBoard(deps = {}) {
    const gameSceneBoard = deps.gameSceneBoard;
    if (!gameSceneBoard) return;
    const scenes = gameSceneSummaries(deps);
    gameSceneBoard.innerHTML = scenes.map((scene) => `
      <article class="game-scene-card ${escapeAttr(scene.kind)} ${scene.message ? "" : "empty"}">
        <button type="button" class="game-scene-main" data-scene-channel="${escapeAttr(scene.channel)}">
          <span class="game-scene-icon">${escapeHtml(scene.icon)}</span>
          <span class="game-scene-title">
            <strong>${escapeHtml(scene.title)}</strong>
            <small>${escapeHtml(scene.subtitle)}</small>
          </span>
          <span class="game-scene-count">${escapeHtml(formatNumber(scene.count))}</span>
          <em>${escapeHtml(scene.preview)}</em>
          ${scene.badges && scene.badges.length ? `
            <span class="game-scene-badges">
              ${scene.badges.map((badge) => `
                <span class="${escapeAttr(badge.kind || "")}">
                  <b>${escapeHtml(badge.label)}</b>${escapeHtml(String(badge.value))}
                </span>
              `).join("")}
            </span>
          ` : ""}
        </button>
        ${scene.skillActions && scene.skillActions.length ? `
          <div class="game-scene-skill-actions">
            ${scene.skillActions.map((action) => `
              <button type="button" class="${escapeAttr(action.cls)}"
                      ${action.disabled ? "disabled" : ""}
                      data-scene-skill="${escapeAttr(action.key)}"
                      title="${escapeAttr(action.title)}">
                ${action.icon ? `<span>${escapeHtml(action.icon)}</span>` : ""}
                <strong>${escapeHtml(action.label)}</strong>
                ${action.meta ? `<small>${escapeHtml(action.meta)}</small>` : ""}
              </button>
            `).join("")}
          </div>
        ` : ""}
        ${scene.commandActions && scene.commandActions.length ? `
          <div class="game-scene-skill-actions game-scene-command-actions">
            ${scene.commandActions.map((action, index) => `
              <button type="button" class="${escapeAttr(action.cls || "")}"
                      data-scene-command-action="${index}"
                      title="${escapeAttr(action.command || "")}">
                <span>${escapeHtml(action.icon || "令")}</span>
                <strong>${escapeHtml(action.label || action.command || "动作")}</strong>
                ${action.meta ? `<small>${escapeHtml(action.meta)}</small>` : ""}
              </button>
            `).join("")}
          </div>
        ` : ""}
        <div class="game-scene-actions">
          ${scene.actions.map((action) => `
            <button type="button" data-scene-panel="${escapeAttr(action.panel)}">${escapeHtml(action.label)}</button>
          `).join("")}
        </div>
      </article>
    `).join("");
    bindGameSceneBoard(deps, gameSceneBoard);
  }

  function bindGameSceneBoard(deps = {}, gameSceneBoard) {
    gameSceneBoard.querySelectorAll("[data-scene-channel]").forEach((button) => {
      button.addEventListener("click", () => {
        const channel = button.dataset.sceneChannel || "focus";
        deps.applyChannelSelection?.([channel]).catch((error) => deps.showSkillToast?.(`频道加载失败: ${error.message || error}`, "err"));
      });
    });
    gameSceneBoard.querySelectorAll("[data-scene-panel]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        await openGameScenePanel(deps, button.dataset.scenePanel || "");
      });
    });
    gameSceneBoard.querySelectorAll("[data-scene-skill]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (button.disabled) return;
        deps.fillSkillIntoComposer?.(button.dataset.sceneSkill || "", button);
      });
    });
    gameSceneBoard.querySelectorAll("[data-scene-command-action]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const action = gameSceneCommandActions(deps, { key: "dungeon" })[Number(button.dataset.sceneCommandAction || 0)];
        if (!action?.command || !action.rawAction) return;
        const sourceId = action.rawAction.source_message_id || "";
        const sourceMessage = sourceId ? await deps.findOrFetchMessage?.(sourceId) : null;
        deps.fillDirectSendComposer?.(action.command, {
          replyContext: deps.directReplyContextFromAction?.(action.rawAction, sourceMessage),
          statusText: "已填入副本动作，请确认原文后发送。",
          statusKind: "info",
        });
        if (sourceMessage) deps.jumpToMessage?.(sourceMessage);
      });
    });
  }

  function gameSceneDefs() {
    return [
      {
        key: "home",
        kind: "home",
        icon: "府",
        title: "洞府",
        channel: "home",
        channels: ["home", "mine"],
        fallback: "洞府、角色回复和个人状态会汇入这里。",
        modules: ["pet_touch", "pet_warm", "pet_trial", "concubine_dream", "concubine_tianji", "concubine_heart"],
        actionSkills: ["concubine_status", "pet_touch", "pet_warm", "pet_trial", "concubine_dream", "concubine_tianji"],
        actions: [
          { label: "状态", panel: "status" },
          { label: "我的", panel: "mine" },
        ],
      },
      {
        key: "training",
        kind: "training",
        icon: "野",
        title: "历练",
        channel: "training",
        channels: ["training", "resource"],
        fallback: "野外历练、奇遇和资源结算会汇入这里。",
        modules: ["wild_training", "checkin", "tower", "deep_retreat", "retreat_shallow", "yuanying", "second_soul", "ranch"],
        actionSkills: ["wild_training", "deep_retreat", "tower", "checkin", "yuanying", "second_soul_train", "retreat_shallow", "ranch"],
        actions: [
          { label: "资源", panel: "resource" },
          { label: "记录", panel: "training" },
        ],
      },
      {
        key: "dungeon",
        kind: "dungeon",
        icon: "副",
        title: "副本",
        channel: "dungeon",
        channels: ["dungeon"],
        fallback: "副本开房、加入、卦象和推进会汇入这里。",
        modules: [],
        actionSkills: [],
        actions: [
          { label: "状态", panel: "dungeon" },
          { label: "攻略", panel: "guide" },
        ],
      },
      {
        key: "intel",
        kind: "leader",
        icon: "天",
        title: "天机",
        channel: "leader",
        channels: ["leader", "focus", "risk"],
        fallback: "会长、重点、风险和新玩法线索会汇入这里。",
        modules: ["stargazer_guide", "stargazer_soothe", "stargazer_collect", "tianti_climb", "tianti_wenxin", "tianti_gangfeng", "taiyi_cycle"],
        actionSkills: ["tianti_status", "tianti_climb", "tianti_wenxin", "tianti_gangfeng", "stargazer_panel", "stargazer_guide", "stargazer_soothe", "taiyi", "yindao", "node_search"],
        actions: [
          { label: "情报", panel: "intel" },
          { label: "健康", panel: "health" },
        ],
      },
    ];
  }

  function gameSceneSummaries(deps = {}) {
    const source = deps.summarySignalMessages?.() || [];
    return gameSceneDefs().map((def) => {
      const messages = source
        .filter((message) => gameSceneMatch(def, message))
        .sort(deps.compareMessagesByRecency || (() => 0));
      const message = messages[0] || null;
      const snapshot = gameSceneSnapshot(deps, def);
      if (snapshot) {
        return {
          ...def,
          ...snapshot,
          badges: snapshot.badges || gameSceneModuleBadges(deps, def),
          skillActions: gameSceneSkillActions(deps, def),
          commandActions: gameSceneCommandActions(deps, def),
          count: Number(snapshot.count ?? messages.length ?? 0),
          message: snapshot.message || message || { id: "" },
        };
      }
      const subtitle = message
        ? `${deps.formatChatTime?.(message.time) || "最近"}｜${deps.displaySource?.(message.source) || ""}`
        : "等待消息箱";
      const preview = message
        ? clipGraphemes(String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim(), 86)
        : def.fallback;
      return {
        ...def,
        count: messages.length,
        message,
        subtitle,
        preview: preview || def.fallback,
        badges: gameSceneModuleBadges(deps, def),
        skillActions: gameSceneSkillActions(deps, def),
        commandActions: gameSceneCommandActions(deps, def),
      };
    });
  }

  function gameSceneSnapshot(deps = {}, def) {
    const state = gameSceneState(deps);
    if (def.key === "home") {
      const identity = deps.identityById?.(state.activeIdentityId);
      const patches = deps.activeIdentityPatches?.() || [];
      const patchMap = new Map(patches.map((item) => [item.key, item.value]));
      if (!identity && !patches.length) return null;
      const realm = patchMap.get("境界") || patchMap.get("灵根") || "角色资料";
      const sourceRows = deps.identityProfileSourceRows?.(patches) || [];
      const source = sourceRows.find((row) => row.sourceMessageId);
      return {
        subtitle: identity ? `${identity.label || identity.username || identity.send_as_id}` : "当前身份",
        preview: `${realm}｜资料来源 ${sourceRows.length || 0} 项`,
        count: sourceRows.length,
        badges: gameSceneModuleBadges(deps, def),
        message: source ? { id: source.sourceMessageId } : null,
      };
    }
    if (def.key === "training") {
      const resource = deps.liveResourceSnapshot?.();
      if (!resource) return null;
      const attempts = resource.wild.success + resource.wild.failed;
      const rate = attempts ? `${Math.round((resource.wild.success * 100) / attempts)}%` : "暂无";
      const rare = resource.rareRows.length
        ? resource.rareRows.map((row) => `${row.resource_name}${deps.formatResourceAmount?.(row.total_amount, row.unit) || ""}`).join(" / ")
        : "暂无稀有";
      return {
        subtitle: `${resource.latestPeriod || "本期"}｜野外成功率 ${rate}`,
        preview: rare,
        count: resource.eventCount,
        badges: gameSceneModuleBadges(deps, def, [{ label: "成功率", value: rate, kind: attempts ? "ok" : "muted" }]),
      };
    }
    if (def.key === "dungeon") {
      const summaries = ((state.worldSnapshot?.dungeon || {}).summaries || []).map((item) => deps.normalizeDungeonStatusSummary?.(item) || item);
      const latestSummary = summaries[0] || null;
      const actionSummary = actionableDungeonSnapshot(deps);
      const summary = actionSummary || deps.pickCurrentDungeonSummary?.(summaries);
      if (!summary) return null;
      const title = dungeonSummaryDisplayLabel(summary);
      const latestDiffers = latestSummary && summary.key !== latestSummary.key;
      const actionCount = (deps.visibleDungeonActions?.(summary) || []).length;
      const previewParts = [summary.advice, summary.routeVerdict, summary.latestStage, summary.openedBy].filter(Boolean);
      if (latestDiffers) {
        previewParts.unshift(`最新 ${dungeonSummaryDisplayLabel(latestSummary)} ${latestSummary.status || ""}`.trim());
      }
      return {
        title,
        subtitle: `${actionSummary ? "可操作" : (summary.status || "副本")}｜${deps.formatChatTime?.(summary.latestMessage?.time) || "最近"}`,
        preview: previewParts.join("｜") || "副本状态已汇总。",
        count: Number((state.worldSnapshot?.dungeon || {}).total_summaries || summary.messageCount || 0),
        badges: [
          { label: "状态", value: summary.status || "副本", kind: ["open", "joined"].includes(summary.statusKind) ? "ok" : ["choice", "active"].includes(summary.statusKind) ? "warn" : "muted" },
          { label: "动作", value: actionCount, kind: actionCount ? "warn" : "muted" },
          latestDiffers ? { label: "最新", value: latestSummary.status || "线索", kind: "muted" } : null,
        ].filter(Boolean),
        message: summary.latestMessage || null,
      };
    }
    if (def.key === "intel") {
      const leaderMessages = ((state.worldSnapshot?.leader || {}).messages || []);
      if (!leaderMessages.length) return null;
      const first = leaderMessages[0];
      return {
        subtitle: `${deps.formatChatTime?.(first.time) || "最近"}｜${deps.displaySource?.(first.source) || ""}`,
        preview: deps.liveMessagePreview?.(first, 86) || "会长频道消息",
        count: leaderMessages.length,
        badges: gameSceneModuleBadges(deps, def, [{ label: "情报", value: leaderMessages.length, kind: leaderMessages.length ? "ok" : "muted" }]),
        message: first,
      };
    }
    return null;
  }

  function gameSceneModuleBadges(deps = {}, def, extras = []) {
    const stats = gameSceneModuleStats(deps, def?.modules || []);
    const badges = [];
    if (stats.total) {
      badges.push({ label: "就绪", value: stats.ready, kind: stats.ready ? "ok" : "muted" });
      if (stats.warn) badges.push({ label: "异常", value: stats.warn, kind: "warn" });
      if (stats.running) badges.push({ label: "进行", value: stats.running, kind: "running" });
      badges.push({ label: "冷却", value: stats.cooling, kind: stats.cooling ? "cooling" : "muted" });
    }
    return [...extras, ...badges].slice(0, 4);
  }

  function gameSceneModuleStats(deps = {}, keys) {
    const state = gameSceneState(deps);
    const wanted = new Set((keys || []).filter(Boolean));
    if (!wanted.size) return { total: 0, ready: 0, warn: 0, running: 0, cooling: 0, unknown: 0 };
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return { total: wanted.size, ready: 0, warn: 0, running: 0, cooling: 0, unknown: wanted.size };
    const rows = (deps.overviewModuleRows?.(activeId) || []).filter((row) => wanted.has(row.spec.key));
    const stats = { total: wanted.size, ready: 0, warn: 0, running: 0, cooling: 0, unknown: 0 };
    for (const row of rows) {
      const cls = String(row.view?.cls || "unknown");
      if (cls === "ready") stats.ready += 1;
      else if (cls === "warn") stats.warn += 1;
      else if (cls === "running") stats.running += 1;
      else if (cls === "cooling") stats.cooling += 1;
      else stats.unknown += 1;
    }
    stats.unknown += Math.max(0, wanted.size - rows.length);
    return stats;
  }

  function gameSceneSkillActions(deps = {}, def) {
    const state = gameSceneState(deps);
    const keys = Array.isArray(def?.actionSkills) ? def.actionSkills : [];
    if (!keys.length) return [];
    const activeId = Number(state.activeIdentityId || 0) || null;
    const now = Date.now() / 1000;
    const modulesByKey = activeId
      ? new Map((state.identityModuleStates.get(activeId) || []).map((item) => [item.module_key, item]))
      : new Map();
    const seen = new Set();
    return keys
      .map((key) => deps.skillByKey?.(key))
      .filter(Boolean)
      .filter((skill) => {
        if (seen.has(skill.key)) return false;
        seen.add(skill.key);
        return skill.reply_mode !== "required" && String(skill.command || "").trim() && deps.skillIsUnlocked?.(skill);
      })
      .map((skill) => {
        const moduleState = skill.cd_module ? modulesByKey.get(skill.cd_module) : null;
        const cdUntil = moduleState
          ? Number((moduleState.summary && moduleState.summary.next_at) || (moduleState.state && moduleState.state.cooldown_until) || 0)
          : 0;
        const cooling = cdUntil > now;
        const busy = state.skillBarBusyKeys.has(skill.key);
        const disabled = !activeId || busy || cooling;
        return {
          key: skill.key,
          label: skill.label || skill.command || skill.key,
          icon: skill.icon || "",
          meta: cooling ? `剩 ${deps.fmtCountdown?.(cdUntil - now) || ""}` : busy ? "发送中" : "填入",
          cls: [cooling ? "cooling" : "ready", busy ? "busy" : ""].filter(Boolean).join(" "),
          disabled,
          order: (cooling ? 2 : 0) + (busy ? 1 : 0),
          title: skill.note || skill.command || skill.label || "",
        };
      })
      .sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label), "zh-Hans-CN"))
      .slice(0, 4);
  }

  function gameSceneCommandActions(deps = {}, def) {
    if (def?.key !== "dungeon") return [];
    const summary = actionableDungeonSnapshot(deps);
    if (!summary) return [];
    const dungeonLabel = dungeonSummaryDisplayLabel(summary);
    return (deps.visibleDungeonActions?.(summary) || [])
      .slice(0, 4)
      .map((action) => ({
        label: action.label || action.command || "动作",
        command: action.command || "",
        icon: "副",
        meta: dungeonLabel,
        cls: "dungeon",
        rawAction: action,
      }));
  }

  function dungeonSummaryDisplayLabel(summary) {
    if (!summary) return "副本";
    return `${summary.dungeonName || "副本"}${summary.dungeonId ? ` #${summary.dungeonId}` : ""}`;
  }

  function actionableDungeonSnapshot(deps = {}) {
    const state = gameSceneState(deps);
    const summaries = ((state.worldSnapshot?.dungeon || {}).summaries || []).map((item) => deps.normalizeDungeonStatusSummary?.(item) || item);
    return summaries
      .filter((summary) => ["choice", "open", "active", "joined"].includes(summary.statusKind))
      .filter((summary) => (deps.visibleDungeonActions?.(summary) || []).length > 0)
      .sort(deps.compareActionableDungeonSummary || (() => 0))[0] || null;
  }

  function gameSceneMatch(def, message) {
    if (!message) return false;
    const channels = message.channels || [message.channel];
    return def.channels.some((channel) => channels.includes(channel));
  }

  async function openGameScenePanel(deps = {}, panel) {
    try {
      if (panel === "status") {
        deps.openIdentityStatusModal?.();
        return;
      }
      if (panel === "mine") {
        await deps.applyChannelSelection?.(["mine"]);
        return;
      }
      if (panel === "resource") {
        await deps.openResourceStatsModal?.();
        return;
      }
      if (panel === "training") {
        await deps.applyChannelSelection?.(["training"]);
        return;
      }
      if (panel === "dungeon") {
        await deps.openDungeonStatusModal?.();
        return;
      }
      if (panel === "guide") {
        await deps.openXutianOracleGuideModal?.();
        return;
      }
      if (panel === "intel") {
        await deps.openLeaderIntelModal?.();
        return;
      }
      if (panel === "health") {
        await deps.openHealthModal?.();
      }
    } catch (error) {
      deps.showError?.(error);
    }
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.gameScene = {
    renderGameSceneBoard,
    bindGameSceneBoard,
    gameSceneDefs,
    gameSceneSummaries,
    gameSceneSnapshot,
    gameSceneModuleBadges,
    gameSceneModuleStats,
    gameSceneSkillActions,
    gameSceneCommandActions,
    dungeonSummaryDisplayLabel,
    actionableDungeonSnapshot,
    gameSceneMatch,
    openGameScenePanel,
  };
})();
