// MINIWEB-VIEW: world event strip and manual event actions
(function () {
  "use strict";

  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function worldEventState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderWorldEventStrip(deps = {}) {
    const worldEventStrip = deps.worldEventStrip;
    if (!worldEventStrip) return;
    const slots = worldEventSlots(deps);
    worldEventStrip.innerHTML = slots.map(({ def, message, count, snapshot }) => {
      const firstAction =
        snapshot?.action ||
        (message?.actions || []).find((item) => String(item.command || "").trim());
      const preview = clipGraphemes(
        String(snapshot?.preview || message?.summary || message?.raw || message?.title || def.emptyText || "").replace(/\s+/g, " ").trim(),
        78
      );
      const title = snapshot?.title || message?.title || def.emptyTitle;
      const subline = snapshot?.subline || (
        message
          ? `${deps.formatChatTime?.(message.time) || ""}｜${deps.displaySource?.(message.source) || ""}`
          : def.emptySubline
      );
      const mainAttrs = message?.id
        ? `data-world-event-id="${escapeAttr(message.id || "")}"`
        : snapshot?.panel
          ? `data-world-event-panel="${escapeAttr(snapshot.panel)}"`
          : `data-world-event-channel="${escapeAttr(def.channel || "focus")}"`;
      return `
        <article class="world-event-card ${escapeAttr(def.kind)} ${message || snapshot ? "" : "empty"}"
                 title="${escapeAttr(preview || title || "消息")}">
          <button type="button" class="world-event-main"
                  ${mainAttrs}>
            <span class="world-event-kind">${escapeHtml(def.label)}</span>
            <strong>${escapeHtml(title || def.label)}</strong>
            <small>${escapeHtml(subline || "")}${count ? `｜${escapeHtml(formatNumber(count))} 条` : ""}</small>
            <em>${escapeHtml(preview || "暂无消息")}</em>
          </button>
          ${firstAction ? `
            <button type="button" class="world-event-action"
                    ${snapshot?.action ? `data-world-event-snapshot-action="${escapeAttr(def.key)}"` : `data-world-event-action="${escapeAttr(message.id || "")}"`}
                    title="${escapeAttr(String(firstAction.command || ""))}">
              填入
            </button>
          ` : ""}
        </article>
      `;
    }).join("");
    bindWorldEventStrip(deps, worldEventStrip);
  }

  function bindWorldEventStrip(deps = {}, worldEventStrip) {
    worldEventStrip.querySelectorAll("[data-world-event-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.worldEventId || "";
        if (!id) return;
        const message = await deps.findOrFetchMessage?.(id);
        if (message) deps.jumpToMessage?.(message);
      });
    });
    worldEventStrip.querySelectorAll("[data-world-event-action]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const id = button.dataset.worldEventAction || "";
        if (!id) return;
        const message = await deps.findOrFetchMessage?.(id);
        const action = (message?.actions || []).find((item) => String(item.command || "").trim());
        if (!message || !action) return;
        deps.fillDirectSendComposer?.(action.command, {
          identityId: action.identity_id,
          replyContext: deps.directReplyContextFromAction?.(action, message),
          statusText: "已填入世界事件候选动作，请确认后发送。",
          statusKind: "info",
        });
        deps.jumpToMessage?.(message);
      });
    });
    worldEventStrip.querySelectorAll("[data-world-event-channel]").forEach((button) => {
      button.addEventListener("click", () => {
        const channel = button.dataset.worldEventChannel || "focus";
        const selection = deps.applyChannelSelection?.([channel]);
        selection?.catch?.((error) => deps.showSkillToast?.(`频道加载失败: ${error.message || error}`, "err"));
      });
    });
    worldEventStrip.querySelectorAll("[data-world-event-panel]").forEach((button) => {
      button.addEventListener("click", async () => {
        await deps.openGameScenePanel?.(button.dataset.worldEventPanel || "");
      });
    });
    worldEventStrip.querySelectorAll("[data-world-event-snapshot-action]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const key = button.dataset.worldEventSnapshotAction || "";
        const snapshot = worldEventSlotSnapshot(deps, { key }) || {};
        const action = snapshot.action || null;
        if (!action?.command) return;
        deps.fillDirectSendComposer?.(action.command, {
          identityId: action.identity_id,
          replyContext: deps.directReplyContextFromAction?.(action),
          statusText: "已填入事件带候选动作，请确认后发送。",
          statusKind: "info",
        });
        const message = action.source_message_id ? await deps.findOrFetchMessage?.(action.source_message_id) : null;
        if (message) deps.jumpToMessage?.(message);
      });
    });
  }

  function worldEventSlotDefs() {
    return [
      {
        key: "mine",
        kind: "mine",
        label: "我的",
        channel: "mine",
        emptyTitle: "暂无个人回复",
        emptySubline: "回复 / 提及 / 风险",
        emptyText: "天尊回复我或有人提到我时显示在这里。",
      },
      {
        key: "dungeon",
        kind: "dungeon",
        label: "副本",
        channel: "dungeon",
        emptyTitle: "暂无副本线索",
        emptySubline: "开房 / 加入 / 推进",
        emptyText: "副本开启、卦象、抉择和战利品线索会显示在这里。",
      },
      {
        key: "resource",
        kind: "resource",
        label: "收益",
        channel: "resource",
        emptyTitle: "暂无收益记录",
        emptySubline: "野外 / 副本 / 奇遇",
        emptyText: "野外历练、副本掉落和奇遇资源会显示在这里。",
      },
      {
        key: "leader",
        kind: "leader",
        label: "情报",
        channel: "leader",
        emptyTitle: "暂无情报",
        emptySubline: "会长 / 天尊普通发言",
        emptyText: "新玩法线索、本人上号和会长发言会显示在这里。",
      },
      {
        key: "focus",
        kind: "focus",
        label: "重点",
        channel: "focus",
        emptyTitle: "等待消息箱",
        emptySubline: "关注关键词",
        emptyText: "采集到重点消息后会显示在这里。",
      },
    ];
  }

  function rankComparator(deps = {}) {
    if (deps.compareRankThenRecency) {
      return deps.compareRankThenRecency((message) => worldEventRank(deps, message));
    }
    return (a, b) => worldEventRank(deps, a) - worldEventRank(deps, b);
  }

  function worldEventSlots(deps = {}) {
    const source = deps.summarySignalMessages?.() || [];
    const sorted = [...source].sort(rankComparator(deps));
    const used = new Set();
    return worldEventSlotDefs().map((def) => {
      const matches = sorted.filter((message) => worldEventSlotMatch(deps, def, message));
      const snapshot = worldEventSlotSnapshot(deps, def, matches);
      const message = matches.find((item) => !used.has(item.id)) || snapshot?.message || matches[0] || null;
      if (message?.id) used.add(message.id);
      return { def, message, count: Number(snapshot?.count ?? matches.length), snapshot };
    });
  }

  function worldEventSlotSnapshot(deps = {}, def, matches = []) {
    const state = worldEventState(deps);
    if (!def) return null;
    if (def.key === "dungeon") {
      const summary = deps.actionableDungeonSnapshot?.() || deps.currentDungeonSnapshot?.();
      if (!summary) return null;
      const title = deps.dungeonSummaryDisplayLabel?.(summary) || "副本";
      return {
        title,
        subline: `${summary.status || "副本"}｜${deps.formatChatTime?.(summary.latestMessage?.time) || "最近"}`,
        preview: [summary.advice, summary.routeVerdict, summary.latestStage, summary.openedBy].filter(Boolean).join("｜") || "副本状态已从消息箱汇总。",
        panel: "dungeon",
        count: Number((state.worldSnapshot?.dungeon || {}).total_summaries || summary.messageCount || matches.length || 0),
        message: summary.latestMessage || null,
        action: (deps.visibleDungeonActions?.(summary) || [])[0] || null,
      };
    }
    if (def.key === "resource") {
      const resource = deps.liveResourceSnapshot?.();
      if (!resource) return null;
      const attempts = resource.wild.success + resource.wild.failed;
      const rate = attempts ? `${Math.round((resource.wild.success * 100) / attempts)}%` : "暂无";
      const rare = resource.rareRows.length
        ? resource.rareRows.map((row) => `${row.resource_name}${deps.formatResourceAmount?.(row.total_amount, row.unit) || ""}`).join(" / ")
        : "暂无稀有产物";
      return {
        title: "今日收益",
        subline: `${resource.latestPeriod || "本期"}｜野外成功率 ${rate}`,
        preview: rare,
        panel: "resource",
        count: resource.eventCount || matches.length || 0,
      };
    }
    if (def.key === "leader") {
      const message = deps.latestLeaderSnapshotMessage?.();
      if (!message) return null;
      return {
        title: message.title || "情报",
        subline: `${deps.formatChatTime?.(message.time) || "最近"}｜${deps.displaySource?.(message.source) || ""}`,
        preview: deps.liveMessagePreview?.(message, 78) || "",
        panel: "intel",
        count: ((state.worldSnapshot?.leader || {}).messages || []).length || matches.length || 0,
        message,
      };
    }
    return null;
  }

  function worldEventSlotMatch(deps = {}, def, message) {
    if (!message) return false;
    const channels = message.channels || [message.channel];
    const tags = message.tags || [];
    if (def.key === "mine") {
      return deps.isPersonalSignal?.(message) || false;
    }
    if (def.key === "dungeon") return channels.includes("dungeon");
    if (def.key === "resource") return channels.includes("resource") || channels.includes("training") || channels.includes("home");
    if (def.key === "leader") return channels.includes("leader") || tags.includes("会长");
    if (def.key === "focus") return channels.includes("focus");
    return false;
  }

  function worldEventCandidates(deps = {}) {
    const source = deps.summarySignalMessages?.() || [];
    const seen = new Set();
    return source
      .filter((message) => {
        if (!message || !message.id || seen.has(message.id)) return false;
        seen.add(message.id);
        return worldEventRank(deps, message) < 90;
      })
      .sort(rankComparator(deps));
  }

  function worldEventRank(deps = {}, message) {
    const channels = message?.channels || [message?.channel];
    const tags = message?.tags || [];
    if (message?.severity === "risk" || channels.includes("risk")) return 1;
    if (deps.isPersonalSignal?.(message)) return 2;
    if (channels.includes("dungeon")) return 3;
    if (channels.includes("leader") || tags.includes("会长")) return 4;
    if (channels.includes("resource") || channels.includes("training") || channels.includes("home")) return 5;
    if ((message?.actions || []).length) return 6;
    if (channels.includes("focus")) return 8;
    return 99;
  }

  function worldEventMeta(deps = {}, message) {
    const channels = message?.channels || [message?.channel];
    const tags = message?.tags || [];
    if (message?.severity === "risk" || channels.includes("risk")) return { kind: "risk", label: "风险" };
    if (deps.isPersonalSignal?.(message)) return { kind: "mine", label: "我的" };
    if (channels.includes("dungeon")) return { kind: "dungeon", label: "副本" };
    if (channels.includes("leader") || tags.includes("会长")) return { kind: "leader", label: "会长" };
    if (channels.includes("resource")) return { kind: "resource", label: "资源" };
    if (channels.includes("training")) return { kind: "training", label: "修炼" };
    if (channels.includes("home")) return { kind: "home", label: "洞府" };
    if ((message?.actions || []).length) return { kind: "action", label: "候选" };
    return { kind: "focus", label: "重点" };
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.worldEvent = {
    renderWorldEventStrip,
    bindWorldEventStrip,
    worldEventSlotDefs,
    worldEventSlots,
    worldEventSlotSnapshot,
    worldEventSlotMatch,
    worldEventCandidates,
    worldEventRank,
    worldEventMeta,
  };
})();
