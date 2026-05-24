// MINIWEB-VIEW: dungeon status modal shell
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

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
        renderDungeonStatusModal(
          dialog,
          dialog._dungeonSummaries || [],
          dialog._dungeonRawCount || 0,
          dialog._dungeonTotalCount || 0,
          dialog._dungeonContextMode || "",
          deps
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
      if (typeof deps.loadDungeonStatus !== "function") {
        throw new Error("dungeonStatus missing dependency: loadDungeonStatus");
      }
      if (typeof deps.loadCangkunGuide !== "function") {
        throw new Error("dungeonStatus missing dependency: loadCangkunGuide");
      }
      if (typeof deps.loadXutianOracleGuide !== "function") {
        throw new Error("dungeonStatus missing dependency: loadXutianOracleGuide");
      }
      const [payload, cangkunGuide, xutianGuide] = await Promise.all([
        deps.loadDungeonStatus({ scanLimit, summaryLimit }),
        deps.loadCangkunGuide().catch((error) => ({ ok: false, error: error.message || "读取苍坤攻略失败" })),
        deps.loadXutianOracleGuide().catch((error) => ({ ok: false, error: error.message || "读取虚天攻略失败" })),
      ]);
      const summaries = (payload.summaries || []).map(normalizeDungeonStatusSummary);
      dialog._dungeonSummaries = summaries;
      dialog._dungeonRawCount = payload.raw_count || 0;
      dialog._dungeonTotalCount = payload.total_summaries || summaries.length;
      dialog._dungeonContextMode = payload.context_mode || "";
      dialog._dungeonGuides = {
        cangkun: cangkunGuide?.ok === false ? null : cangkunGuide,
        xutian: xutianGuide?.ok === false ? null : xutianGuide,
      };
      renderDungeonStatusModal(
        dialog,
        summaries,
        payload.raw_count || 0,
        payload.total_summaries || summaries.length,
        payload.context_mode || "",
        deps
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

  function normalizeDungeonStatusSummary(item) {
    const messages = (item.messages || []).map((message) => ({
      seq: Number(message.seq || 0),
      id: message.id,
      title: message.title,
      summary: message.summary,
      time: message.time,
      chat_id: message.chat_id,
      msg_id: message.msg_id,
      reply_to_msg_id: message.reply_to_msg_id,
    }));
    return {
      key: item.key || "",
      latestSeq: Number(item.latest_seq || 0),
      dungeonId: item.dungeon_id || "",
      dungeonName: item.dungeon_name || "副本",
      status: item.status || "副本消息",
      statusKind: item.status_kind || "info",
      latestStage: item.latest_stage || "",
      openedBy: item.opened_by || "",
      capacity: item.capacity || "",
      oracle: item.oracle || "",
      advice: item.advice || "",
      routeVerdict: item.route_verdict || "",
      adviceBasis: item.advice_basis || "",
      adviceConfidence: item.advice_confidence || "",
      teamFit: item.team_fit || "",
      positiveExamples: Array.isArray(item.positive_examples) ? item.positive_examples : [],
      negativeExamples: Array.isArray(item.negative_examples) ? item.negative_examples : [],
      route: item.route || "",
      strategy: item.strategy || "",
      silenceOrder: item.silence_order || "",
      cangkunState: item.cangkun_state || {},
      cangkunAdvice: normalizeCangkunAdvice(item.cangkun_advice),
      contextSource: item.context_source || "",
      messageCount: Number(item.message_count || messages.length || 0),
      joinSuccess: item.join_success || [],
      failures: item.failures || [],
      actions: item.actions || [],
      messages,
      latestMessage: messages[0] || { id: item.latest_message_id || "", time: item.latest_time || "" },
    };
  }

  function normalizeCangkunAdvice(value) {
    if (!value || typeof value !== "object") return null;
    const hasContent = Boolean(value.label || value.command || value.reason || value.stage || (value.state_rows || []).length);
    if (!hasContent) return null;
    return {
      stage: value.stage || "",
      label: value.label || "",
      command: value.command || "",
      reason: value.reason || "",
      stateRows: Array.isArray(value.state_rows) ? value.state_rows : [],
    };
  }

  function renderDungeonStatusModal(dialog, summaries, rawCount, totalCount = summaries.length, contextMode = "", deps = {}) {
    const list = dialog.querySelector("#dungeonStatusList");
    const summary = dialog.querySelector("#dungeonStatusSummary");
    const playbooks = dialog.querySelector("#dungeonPlaybookPanels");
    const filter = dialog.querySelector("[data-dungeon-status-filter].active")?.dataset.dungeonStatusFilter || "all";
    const visible = filterDungeonStatusSummaries(summaries, filter);
    const liveCount = summaries.filter((item) => ["open", "joined", "choice", "active"].includes(item.statusKind)).length;
    const actionCount = summaries.reduce((total, item) => total + visibleDungeonActions(item).length, 0);
    const modeText = contextMode === "fast_window" ? "快速窗口" : "完整关联";
    const idGapNotes = dungeonIdGapNotes(visible);
    if (summary) {
      summary.innerHTML = `
        <div class="resource-stat-card">
          <span>读取消息</span>
          <strong>${escapeHtml(formatNumber(rawCount))}</strong>
          <small>最近副本频道卡片</small>
        </div>
        <div class="resource-stat-card">
          <span>活跃副本</span>
          <strong>${escapeHtml(formatNumber(liveCount))}</strong>
          <small>可加入 / 已加入 / 进行中 / 需要抉择</small>
        </div>
        <div class="resource-stat-card">
          <span>可用动作</span>
          <strong>${escapeHtml(formatNumber(actionCount))}</strong>
          <small>只复制或跳转，不自动发送</small>
        </div>
        <div class="resource-stat-card">
          <span>模式</span>
          <strong>${escapeHtml(modeText)}</strong>
          <small>${contextMode === "fast_window" ? "最近3次默认加速" : "含历史关联回填"}</small>
        </div>
      `;
    }
    if (playbooks) {
      playbooks.innerHTML = window.MiniwebViews.dungeonPlaybook.renderDungeonPlaybookPanels(summaries, dialog._dungeonGuides || {}, {
        formatChatTime: deps.formatChatTime,
      });
      window.MiniwebViews.dungeonPlaybook.bindDungeonPlaybookPanels(playbooks, {
        fillCommand: deps.fillDungeonCommand,
        openXutianGuide: deps.openXutianOracleGuideModal,
        openCangkunGuide: deps.openCangkunGuideModal,
        findMessageById: deps.findMessageById,
        jumpToMessage: deps.jumpToMessage,
      });
    }
    if (!list) return;
    if (!summaries.length) {
      list.innerHTML = '<p class="empty inline">最近没有采集到副本消息。先确认 listener 正在采集，或去「日志」里看全部消息。</p>';
      return;
    }
    if (!visible.length) {
      list.innerHTML = '<p class="empty inline">当前筛选下没有副本线索。</p>';
      setDungeonStatusLine(dialog, "ok", `已汇总 ${summaries.length}/${totalCount} 个近期副本线索。`);
      return;
    }
    const current = pickCurrentDungeonSummary(visible);
    const recent = current ? visible.filter((item) => item.key !== current.key) : visible;
    list.innerHTML = `
      ${idGapNotes.length ? `
        <div class="dungeon-id-gap-note">
          <strong>副本 ID 跳号</strong>
          ${idGapNotes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}
        </div>
      ` : ""}
      ${current ? renderCurrentDungeonPanel(current, deps) : ""}
      ${recent.length ? `
        <div class="dungeon-recent-head">
          <strong>最近副本</strong>
          <span>${escapeHtml(formatNumber(recent.length))} 条线索</span>
        </div>
        <div class="dungeon-recent-grid">
          ${recent.map((item) => renderDungeonStatusCard(item, { compact: true }, deps)).join("")}
        </div>
      ` : ""}
    `;
    bindDungeonStatusCards(list, visible, deps);
    setDungeonStatusLine(
      dialog,
      idGapNotes.length ? "warn" : "ok",
      `已显示 ${visible.length} 个，接口返回 ${summaries.length}/${totalCount} 个近期副本线索。${idGapNotes.length ? "存在跳号，可能是中间副本未采到或被过滤。" : ""}`
    );
  }

  function pickCurrentDungeonSummary(summaries) {
    const live = (summaries || []).filter((item) => ["choice", "active", "open", "joined"].includes(item.statusKind));
    const actionable = live.filter((item) => visibleDungeonActions(item).length > 0);
    if (actionable.length) {
      return [...actionable].sort(compareActionableDungeonSummary)[0] || null;
    }
    return live[0] || summaries[0] || null;
  }

  function visibleDungeonActions(summary) {
    if (!summary || ["closed", "failed"].includes(summary.statusKind)) return [];
    const latestCangkunChoiceSeq = latestCangkunChoiceActionSeq(summary);
    return (summary.actions || []).filter((action) => {
      const command = String(action?.command || "").trim();
      if (!command) return false;
      if (/^\.加入(?:副本|苍坤洞府)(?:\s|$)/.test(command)) {
        return summary.statusKind === "open";
      }
      if (/^\.苍坤抉择(?:\s|$)/.test(command) && latestCangkunChoiceSeq > 0) {
        return Number(action.source_seq || 0) === latestCangkunChoiceSeq;
      }
      return true;
    });
  }

  function latestCangkunChoiceActionSeq(summary) {
    if (!isCangkunDungeon(summary)) return 0;
    return Math.max(
      0,
      ...(summary.actions || [])
        .filter((action) => /^\.苍坤抉择(?:\s|$)/.test(String(action?.command || "").trim()))
        .map((action) => Number(action.source_seq || 0))
        .filter((seq) => Number.isFinite(seq))
    );
  }

  function compareActionableDungeonSummary(a, b) {
    const liveRanks = { choice: 0, open: 1, active: 2, joined: 3 };
    return (
      (liveRanks[a?.statusKind] ?? 9) - (liveRanks[b?.statusKind] ?? 9)
      || compareDungeonSummariesByRecency(a, b)
    );
  }

  function compareDungeonSummariesByRecency(a, b) {
    const aLatest = a?.latestMessage || {};
    const bLatest = b?.latestMessage || {};
    const timeDiff = messageTimeValue(bLatest) - messageTimeValue(aLatest);
    if (timeDiff) return timeDiff;
    const msgDiff = numericMessageField(bLatest, "msg_id") - numericMessageField(aLatest, "msg_id");
    if (msgDiff) return msgDiff;
    return Number(b?.latestSeq || bLatest.seq || 0) - Number(a?.latestSeq || aLatest.seq || 0);
  }

  function messageTimeValue(message) {
    const parsed = Date.parse(String(message?.time || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function numericMessageField(message, key) {
    const value = Number(message?.[key] || 0);
    return Number.isFinite(value) ? value : 0;
  }

  function filterDungeonStatusSummaries(summaries, filter) {
    if (filter === "live") return summaries.filter((item) => ["choice", "active", "open", "joined"].includes(item.statusKind));
    if (filter === "open") return summaries.filter((item) => item.statusKind === "open");
    if (filter === "done") return summaries.filter((item) => ["closed", "failed"].includes(item.statusKind));
    return summaries;
  }

  function dungeonIdGapNotes(summaries) {
    const ids = [...new Set((summaries || [])
      .map((item) => Number(String(item.dungeonId || "").replace(/[^\d]/g, "")))
      .filter((id) => Number.isInteger(id) && id > 0))]
      .sort((a, b) => b - a);
    const notes = [];
    for (let i = 0; i < ids.length - 1; i += 1) {
      const current = ids[i];
      const next = ids[i + 1];
      if (current - next > 1) {
        notes.push(`#${next} → #${current} 缺 ${formatNumber(current - next - 1)} 个编号`);
      }
      if (notes.length >= 3) break;
    }
    return notes;
  }

  function renderCurrentDungeonPanel(summary, deps = {}) {
    const contextText = dungeonContextLabel(summary.contextSource);
    const verdictText = dungeonRouteVerdictLabel(summary);
    const oracleRows = dungeonOracleRows(summary, verdictText);
    const cangkunAdvice = summary.cangkunAdvice;
    const joins = summary.joinSuccess.length ? summary.joinSuccess.map((user) => `@${user}`).join("、") : "";
    const latestId = summary.latestMessage?.id || "";
    const title = `${summary.dungeonName || "副本"}${summary.dungeonId ? ` #${summary.dungeonId}` : ""}`;
    const primaryActions = visibleDungeonActions(summary).slice(0, 8);
    const formatChatTime = typeof deps.formatChatTime === "function" ? deps.formatChatTime : (value) => value || "";
    return `
      <article class="dungeon-current-panel ${escapeAttr(summary.statusKind)}" data-dungeon-key="${escapeAttr(summary.key)}">
        <div class="dungeon-current-main">
          <div class="dungeon-current-title">
            <span>当前副本</span>
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(formatChatTime(summary.latestMessage?.time) || summary.latestMessage?.time || "")}</small>
          </div>
          <span class="status-pill ${escapeAttr(dungeonStatusPillClass(summary.statusKind))}">${escapeHtml(summary.status)}</span>
        </div>
        <div class="dungeon-current-metrics">
          ${dungeonMetric("阶段", summary.latestStage || "未读")}
          ${dungeonMetric("开门", summary.openedBy || "未读")}
          ${dungeonMetric("人数", summary.capacity || (summary.joinSuccess.length ? `${summary.joinSuccess.length} 人` : "未读"))}
          ${dungeonMetric("关联", contextText || "消息")}
        </div>
        ${oracleRows.length ? `
          <div class="dungeon-current-oracle">
            ${oracleRows.slice(0, 6).map(([key, value]) => `
              <div>
                <span>${escapeHtml(key)}</span>
                <strong>${escapeHtml(value)}</strong>
              </div>
            `).join("")}
          </div>
        ` : ""}
        ${cangkunAdvice ? renderCangkunCurrentAdvice(cangkunAdvice) : ""}
        ${(joins || summary.failures.length) ? `
          <div class="dungeon-current-feedback">
            ${joins ? `<p class="dungeon-status-note ok">已加入：${escapeHtml(joins)}</p>` : ""}
            ${summary.failures.length ? `<p class="dungeon-status-note warn">失败：${escapeHtml(summary.failures.slice(0, 3).join("；"))}</p>` : ""}
          </div>
        ` : ""}
        ${primaryActions.length ? `
          <div class="dungeon-current-actions">
            ${primaryActions.map((action, index) => `
              <button type="button" data-dungeon-key="${escapeAttr(summary.key)}" data-dungeon-action-index="${index}" title="复制命令，不会直接发送">
                <strong>${escapeHtml(action.label || action.command || "动作")}</strong>
                <small>${escapeHtml(action.command || "")}</small>
              </button>
            `).join("")}
          </div>
        ` : ""}
        <div class="dungeon-current-timeline">
          ${summary.messages.slice(0, 4).map((message) => `
            <button type="button" data-dungeon-jump="${escapeAttr(message.id)}">
              <span>${escapeHtml(formatChatTime(message.time) || "时间")}</span>
              <strong>${escapeHtml(message.title || "副本消息")}</strong>
              <small>${escapeHtml(clipGraphemes(String(message.summary || message.raw || "").replace(/\s+/g, " "), 72))}</small>
            </button>
          `).join("")}
          ${latestId ? `<button type="button" class="dungeon-current-open" data-dungeon-jump="${escapeAttr(latestId)}">查看最新消息</button>` : ""}
        </div>
      </article>
    `;
  }

  function isCangkunDungeon(summary) {
    const name = String(summary?.dungeonName || "");
    return name.includes("苍坤");
  }

  function renderCangkunCurrentAdvice(advice) {
    return `
      <div class="dungeon-cangkun-advice">
        <div class="dungeon-cangkun-advice-main">
          <span>${escapeHtml(advice.stage || "苍坤")}</span>
          <strong>${escapeHtml(advice.label || "看原文")}</strong>
          <small>${escapeHtml(advice.reason || "")}</small>
        </div>
        ${advice.stateRows.length ? `
          <div class="dungeon-cangkun-state">
            ${advice.stateRows.map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join("")}
          </div>
        ` : ""}
        <div class="dungeon-cangkun-actions">
          ${advice.command ? `<button type="button" data-cangkun-fill="${escapeAttr(advice.command)}">${escapeHtml(advice.command)}</button>` : ""}
          <button type="button" data-cangkun-guide>苍坤攻略</button>
        </div>
      </div>
    `;
  }

  function dungeonMetric(label, value) {
    return `
      <div class="dungeon-current-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value || "—"))}</strong>
      </div>
    `;
  }

  function renderDungeonStatusCard(summary, options = {}, deps = {}) {
    const compact = Boolean(options.compact);
    const contextText = dungeonContextLabel(summary.contextSource);
    const verdictText = dungeonRouteVerdictLabel(summary);
    const formatChatTime = typeof deps.formatChatTime === "function" ? deps.formatChatTime : (value) => value || "";
    const chips = [
      ["副本ID", summary.dungeonId ? `#${summary.dungeonId}` : ""],
      ["阶段", summary.latestStage],
      ["开门人", summary.openedBy],
      ["人数", summary.capacity],
      ["路线", summary.route],
      ["阵策", summary.strategy],
      ["静场令", summary.silenceOrder],
      ["关联", contextText],
      ["消息", summary.messageCount > summary.messages.length ? `${summary.messages.length}/${summary.messageCount}` : ""],
    ].filter(([, value]) => value);
    const oracleRows = dungeonOracleRows(summary, verdictText);
    const latestId = summary.latestMessage?.id || "";
    const joins = summary.joinSuccess.length ? summary.joinSuccess.map((user) => `@${user}`).join("、") : "";
    const actions = visibleDungeonActions(summary);
    return `
      <article class="dungeon-status-card ${compact ? "compact" : ""} ${escapeAttr(summary.statusKind)}" data-dungeon-key="${escapeAttr(summary.key)}">
        <div class="dungeon-status-head">
          <div class="dungeon-status-title">
            <strong>${escapeHtml(summary.dungeonName || "副本")}${summary.dungeonId ? ` #${escapeHtml(summary.dungeonId)}` : ""}</strong>
            <span class="status-pill ${escapeAttr(dungeonStatusPillClass(summary.statusKind))}">${escapeHtml(summary.status)}</span>
          </div>
          <small>${escapeHtml(formatChatTime(summary.latestMessage?.time) || summary.latestMessage?.time || "")}</small>
        </div>
        ${chips.length ? `<div class="dungeon-status-meta">${chips.map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
        ${oracleRows.length && !compact ? `<div class="dungeon-oracle-panel">${oracleRows.map(([key, value]) => `<div><b>${escapeHtml(key)}</b><span>${escapeHtml(value)}</span></div>`).join("")}</div>` : ""}
        ${joins ? `<p class="dungeon-status-note ok">已成功加入：${escapeHtml(joins)}</p>` : ""}
        ${summary.failures.length ? `<p class="dungeon-status-note warn">失败：${escapeHtml(summary.failures.slice(0, 2).join("；"))}</p>` : ""}
        ${actions.length ? `
          <div class="dungeon-status-actions">
            ${actions.slice(0, 4).map((action, index) => `
              <button type="button" data-dungeon-key="${escapeAttr(summary.key)}" data-dungeon-action-index="${index}" title="复制命令，不会直接发送">${escapeHtml(action.command || "复制命令")}</button>
            `).join("")}
          </div>
        ` : ""}
        <ol class="dungeon-status-timeline">
          ${summary.messages.slice(0, 5).map((message) => `
            <li>
              <button type="button" data-dungeon-jump="${escapeAttr(message.id)}">${escapeHtml(formatChatTime(message.time) || "时间")}</button>
              <span>${escapeHtml(message.title || "副本消息")}</span>
              <small>${escapeHtml(clipGraphemes(String(message.summary || message.raw || "").replace(/\s+/g, " "), 90))}</small>
            </li>
          `).join("")}
        </ol>
        ${latestId ? `<button type="button" class="dungeon-status-open" data-dungeon-jump="${escapeAttr(latestId)}">查看最新消息</button>` : ""}
      </article>
    `;
  }

  function dungeonOracleRows(summary, verdictText) {
    return [
      ["卦象", summary.oracle],
      ["顺逆", verdictText],
      ["队伍契合", summary.teamFit],
      ["建议", summary.advice],
      ["依据", summary.adviceBasis],
      ["置信", summary.adviceConfidence],
      ["顺例", summary.positiveExamples.slice(0, 2).join("；")],
      ["反例", summary.negativeExamples.slice(0, 2).join("；")],
    ].filter(([, value]) => value);
  }

  function dungeonRouteVerdictLabel(summary) {
    const verdict = cleanText(summary.routeVerdict);
    if (verdict) return verdict;
    if ((summary.dungeonName === "虚天殿" || summary.oracle) && summary.oracle) return "待验证";
    return "";
  }

  function normalizeDungeonExamples(value) {
    if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean);
    const text = cleanText(value);
    return text ? [text] : [];
  }

  function bindDungeonStatusCards(root, summaries, deps = {}) {
    const byKey = new Map(summaries.map((item) => [item.key, item]));
    root.onclick = async (event) => {
      const button = event.target?.closest?.("button");
      if (!button || !root.contains(button)) return;
      if (button.dataset.cangkunFill !== undefined) {
        const command = button.dataset.cangkunFill || "";
        if (!command) return;
        closeModal();
        deps.fillCangkunCommand?.(command);
        return;
      }
      if (button.dataset.cangkunGuide !== undefined) {
        await deps.openCangkunGuideModal?.();
        return;
      }
      if (button.dataset.dungeonActionIndex !== undefined) {
        const key = button.dataset.dungeonKey || "";
        const summary = byKey.get(key);
        const action = visibleDungeonActions(summary)[Number(button.dataset.dungeonActionIndex || 0)];
        if (!action?.command) return;
        await deps.copyCommandToClipboard?.(action.command, button);
        return;
      }
      if (button.dataset.dungeonJump !== undefined) {
        const id = button.dataset.dungeonJump || "";
        if (!id) return;
        const target = await deps.findMessageById?.(id);
        if (target) {
          closeModal();
          deps.jumpToMessage?.(target);
        }
      }
    };
  }

  function dungeonContextLabel(source) {
    if (source === "open_lookup") return "回查开门";
    if (source === "open_in_window") return "本窗开门";
    if (source === "id_in_window" || source === "explicit_id") return "副本ID";
    if (source === "time_segment") return "时间段";
    return "";
  }

  function dungeonStatusPillClass(kind) {
    if (kind === "open" || kind === "joined") return "ok";
    if (kind === "choice" || kind === "active") return "warn";
    if (kind === "failed" || kind === "closed") return "risk";
    return "info";
  }

  function cleanText(value) {
    return String(value ?? "").trim();
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.dungeonStatus = {
    bindDungeonStatusCards,
    compareActionableDungeonSummary,
    cleanText,
    dungeonContextLabel,
    dungeonStatusPillClass,
    normalizeDungeonExamples,
    normalizeDungeonStatusSummary,
    openDungeonStatusModal,
    pickCurrentDungeonSummary,
    renderCurrentDungeonPanel,
    renderDungeonStatusModal,
    setDungeonStatusLine,
    visibleDungeonActions,
  };
})();
