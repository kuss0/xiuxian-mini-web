// MINIWEB-VIEW: quest tracker and manual action filling
(function () {
  "use strict";

  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function questState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function rankComparator(deps = {}) {
    if (deps.compareRankThenRecency) {
      return deps.compareRankThenRecency((message) => questTrackerRank(deps, message));
    }
    return (a, b) => questTrackerRank(deps, a) - questTrackerRank(deps, b);
  }

  function renderQuestTracker(deps = {}) {
    const questTracker = deps.questTracker;
    if (!questTracker) return;
    const allItems = questTrackerItems(deps);
    const items = allItems.slice(0, 4);
    if (!items.length) {
      questTracker.innerHTML = `
        <div class="quest-tracker-head">
          <span>任务追踪</span>
          <strong>暂无待处理动作</strong>
          <small>风险、@我和候选命令会出现在这里</small>
        </div>
      `;
      return;
    }
    questTracker.innerHTML = `
      <div class="quest-tracker-head">
        <span>任务追踪</span>
        <strong>${escapeHtml(formatNumber(allItems.length))} 条待看</strong>
        <small>只填入发送栏，不自动发送</small>
        ${allItems.length > items.length ? `<button type="button" data-quest-more>查看全部</button>` : ""}
      </div>
      <div class="quest-tracker-list">
        ${items.map((item) => renderQuestTrackerItem(deps, item)).join("")}
      </div>
    `;
    questTracker.querySelectorAll("[data-quest-view]").forEach((button) => {
      button.addEventListener("click", async () => {
        await openQuestTrackerItem(deps, button.dataset.questView || "");
      });
    });
    questTracker.querySelectorAll("[data-quest-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const [key, indexText] = String(button.dataset.questAction || "").split("::");
        await fillQuestTrackerAction(deps, key, Number(indexText || 0), "任务动作");
      });
    });
    questTracker.querySelector("[data-quest-more]")?.addEventListener("click", () => {
      deps.openOverviewDetailPanel?.();
    });
  }

  function questTrackerItems(deps = {}) {
    const source = deps.summarySignalMessages?.() || [];
    const seen = new Set();
    const items = source
      .filter((message) => {
        if (!message?.id || seen.has(message.id)) return false;
        seen.add(message.id);
        return questTrackerRank(deps, message) < 90;
      })
      .sort(rankComparator(deps));
    const moduleQuests = currentModuleQuestItems(deps, items);
    const dungeonQuest = currentDungeonQuestItem(deps, items);
    return [dungeonQuest, ...moduleQuests, ...items]
      .filter(Boolean)
      .sort(rankComparator(deps));
  }

  function currentDungeonQuestItem(deps = {}, existingItems = []) {
    const summary = deps.actionableDungeonSnapshot?.() || deps.currentDungeonSnapshot?.();
    if (!summary || !["open", "choice", "active", "joined"].includes(summary.statusKind)) return null;
    const actions = deps.visibleDungeonActions?.(summary) || [];
    if (!actions.length) return null;
    const existingActionKeys = new Set(
      existingItems.flatMap((item) => (item.actions || []).map(questActionKey))
    );
    const missingActions = actions.filter((action) => !existingActionKeys.has(questActionKey(action)));
    if (!missingActions.length) return null;
    const title = deps.dungeonSummaryDisplayLabel?.(summary) || "副本";
    const preview = [summary.status, summary.advice, summary.routeVerdict, summary.latestStage]
      .filter(Boolean)
      .join("｜") || "副本快照里有待确认动作。";
    return {
      id: `snapshot:dungeon:${summary.key || summary.dungeonId || "current"}`,
      title,
      summary: preview,
      raw: preview,
      source: "副本快照",
      time: summary.latestMessage?.time || "",
      seq: Number(summary.latestSeq || summary.latestMessage?.seq || 0),
      channels: ["dungeon", "focus"],
      tags: ["副本", "快照", summary.status || ""].filter(Boolean),
      actions: missingActions,
      severity: summary.statusKind === "failed" ? "warning" : "normal",
      fields: {
        "副本名": summary.dungeonName || "",
        "副本ID": summary.dungeonId || "",
        "状态": summary.status || "",
        "阶段": summary.latestStage || "",
      },
      __questSnapshot: "dungeon",
      __dungeonKey: summary.key || summary.dungeonId || "current",
      __sourceMessageId: summary.latestMessage?.id || missingActions[0]?.source_message_id || "",
    };
  }

  function questActionKey(action) {
    return [
      String(action?.command || "").trim(),
      String(action?.source_message_id || ""),
      String(action?.reply_to_msg_id || ""),
    ].join("|");
  }

  function currentModuleQuestItems(deps = {}, existingItems = []) {
    const state = questState(deps);
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return [];
    const existingActionKeys = new Set(
      existingItems.flatMap((item) => (item.actions || []).map(questActionKey))
    );
    return (deps.overviewModuleRows?.(activeId) || [])
      .map((row) => currentModuleQuestItem(deps, row, activeId))
      .filter(Boolean)
      .filter((item) => {
        const action = (item.actions || [])[0];
        if (!action) return true;
        const key = questActionKey(action);
        if (existingActionKeys.has(key)) return false;
        existingActionKeys.add(key);
        return true;
      })
      .slice(0, 3);
  }

  function currentModuleQuestItem(deps = {}, row, activeId) {
    if (!row?.item) return null;
    if (!["warn", "ready"].includes(row.view?.cls)) return null;
    const skill = moduleQuestSkill(deps, row);
    if (!skill || !deps.skillIsUnlocked?.(skill)) return null;
    const command = String(skill.command || "").trim();
    if (!command || skill.reply_mode === "required") return null;
    const updatedAt = Number(row.item.updated_at || 0);
    const summary = [
      row.view.status,
      row.view.time,
      row.spec?.__groupTitle,
    ].filter(Boolean).join("｜");
    const action = {
      type: "copy",
      label: skill.label || command,
      command,
      send_mode: "copy",
      identity_id: activeId,
      skill_key: skill.key,
    };
    return {
      id: `snapshot:module:${activeId}:${row.spec.key}`,
      title: `${row.view.icon || ""} ${row.view.label || row.spec.key}`.trim(),
      summary,
      raw: summary,
      source: "状态机",
      time: updatedAt ? new Date(updatedAt * 1000).toISOString() : "",
      seq: 0,
      channels: ["focus"],
      tags: ["状态", row.spec?.__groupTitle || "", row.view.status || ""].filter(Boolean),
      actions: [action],
      severity: row.view.cls === "warn" ? "warning" : "normal",
      fields: {
        "模块": row.view.label || row.spec.key,
        "状态": row.view.status || "",
        "时间": row.view.time || "",
      },
      __questSnapshot: "module",
      __moduleKey: row.spec.key,
      __identityId: activeId,
    };
  }

  function moduleQuestSkill(deps = {}, row) {
    const spec = row?.spec || {};
    const status = String(row?.view?.status || "");
    const preferredKeys = [];
    if (status === "待结算" && spec.query) {
      preferredKeys.push(spec.query);
    }
    if (row?.view?.cls === "warn" && spec.query) {
      preferredKeys.push(spec.query);
    }
    preferredKeys.push(spec.skill, ...(spec.extraSkills || []), spec.query, spec.__groupQuery);
    for (const key of preferredKeys.filter(Boolean)) {
      const skill = deps.skillByKey?.(key);
      if (skill && String(skill.command || "").trim()) return skill;
    }
    return null;
  }

  function questTrackerRank(deps = {}, message) {
    if (message?.__questSnapshot === "dungeon") return 2;
    if (message?.__questSnapshot === "module") return 3;
    const channels = message?.channels || [message?.channel];
    const tags = message?.tags || [];
    if (message?.severity === "risk" || channels.includes("risk")) return 1;
    if ((message?.actions || []).some((action) => String(action.command || "").trim())) return 2;
    if (deps.isPersonalSignal?.(message)) return 3;
    if (channels.includes("dungeon") && ["可加入", "需要抉择"].some((tag) => tags.includes(tag))) return 4;
    return 99;
  }

  function renderQuestTrackerItem(deps = {}, message) {
    const key = questTrackerItemKey(message);
    const actionEntries = (message.actions || [])
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => String(action.command || "").trim());
    const { kind, text: kindText } = questItemKind(deps, message, actionEntries);
    const preview = clipGraphemes(
      String(message.summary || message.raw || message.title || "").replace(/\s+/g, " ").trim(),
      78
    );
    return `
      <article class="quest-card ${escapeAttr(kind)}">
        <button type="button" class="quest-card-main" data-quest-view="${escapeAttr(key)}">
          <span class="quest-kind">${escapeHtml(kindText)}</span>
          <strong>${escapeHtml(message.title || deps.displaySource?.(message.source) || "")}</strong>
          <small>${escapeHtml(deps.formatChatTime?.(message.time) || "")}｜${escapeHtml(deps.displaySource?.(message.source) || "")}</small>
          <em>${escapeHtml(preview || "（空消息）")}</em>
        </button>
        <div class="quest-card-actions">
          ${actionEntries.slice(0, 2).map(({ action, index }) => `
            <button type="button" data-quest-action="${escapeAttr(`${key}::${index}`)}" title="${escapeAttr(String(action.command || ""))}">
              ${escapeHtml(deps.quickActionLabel?.(action) || "")}
            </button>
          `).join("")}
          <button type="button" data-quest-view="${escapeAttr(key)}">查看</button>
        </div>
      </article>
    `;
  }

  function questItemKind(deps = {}, message, actionEntries = null) {
    const channels = message?.channels || [message?.channel];
    const actions = actionEntries || (message?.actions || []).filter((action) => String(action.command || "").trim());
    if (message?.__questSnapshot === "dungeon") return { kind: "dungeon", text: "副本" };
    if (message?.__questSnapshot === "module") return { kind: "module", text: "状态" };
    if (message?.severity === "risk" || channels.includes("risk")) return { kind: "risk", text: "风险" };
    if (actions.length) return { kind: "action", text: "动作" };
    if (deps.isPersonalSignal?.(message)) return { kind: "mine", text: "我的" };
    return { kind: "focus", text: "重点" };
  }

  function questTrackerItemKey(item) {
    if (!item) return "";
    if (item.__questSnapshot) {
      return `snapshot:${item.__questSnapshot}:${item.__dungeonKey || item.id || "current"}`;
    }
    return String(item.id || "");
  }

  function questTrackerItemByKey(deps = {}, key) {
    const normalized = String(key || "");
    return questTrackerItems(deps).find((item) => questTrackerItemKey(item) === normalized) || null;
  }

  async function openQuestTrackerItem(deps = {}, key) {
    const item = questTrackerItemByKey(deps, key);
    if (!item) return;
    if (item.__questSnapshot === "module") {
      deps.openIdentityStatusModal?.();
      return;
    }
    if (item.__questSnapshot === "dungeon") {
      const sourceId = item.__sourceMessageId || item.actions?.[0]?.source_message_id || "";
      const message = sourceId ? await deps.findOrFetchMessage?.(sourceId) : null;
      if (message) {
        deps.jumpToMessage?.(message);
        return;
      }
      await deps.openDungeonStatusModal?.();
      return;
    }
    const message = await deps.findOrFetchMessage?.(item.id || key);
    if (message) deps.jumpToMessage?.(message);
  }

  async function fillQuestTrackerAction(deps = {}, key, index, label) {
    const item = questTrackerItemByKey(deps, key);
    const action = (item?.actions || [])[Number(index || 0)];
    if (!item || !action?.command) return;
    const sourceId = action.source_message_id || item.__sourceMessageId || "";
    const sourceMessage = sourceId ? await deps.findOrFetchMessage?.(sourceId) : (item.__questSnapshot ? null : item);
    deps.fillDirectSendComposer?.(action.command, {
      identityId: action.identity_id,
      replyContext: deps.directReplyContextFromAction?.(action, sourceMessage || item),
      statusText: deps.quickActionNeedsManualReview?.(action)
        ? `已填入${label}，请补全内容后发送。`
        : `已填入${label}，请确认后发送。`,
      statusKind: "info",
    });
    if (sourceMessage) deps.jumpToMessage?.(sourceMessage);
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.questTracker = {
    renderQuestTracker,
    questTrackerItems,
    currentDungeonQuestItem,
    questActionKey,
    currentModuleQuestItems,
    currentModuleQuestItem,
    moduleQuestSkill,
    questTrackerRank,
    renderQuestTrackerItem,
    questItemKind,
    questTrackerItemKey,
    questTrackerItemByKey,
    openQuestTrackerItem,
    fillQuestTrackerAction,
  };
})();
