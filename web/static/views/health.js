// MINIWEB-VIEW: health audit modal
(function () {
  "use strict";

  const { openModal } = window.MiniwebModal;
  const { escapeHtml, formatNumber } = window.MiniwebFormat;

  async function openHealthModal({
    auditTimeLabel,
    formatChatTime,
    getInitialAudit,
    healthStatusLabel,
    listenerStatusText,
    loadMessageAudit,
    renderResourceCoverage,
    updateGlobalBanner,
  }) {
    const initialAudit = getInitialAudit ? getInitialAudit() : null;
    const dialog = openModal({
      title: "运行健康",
      body: `
        <section class="modal-section">
          <h4>消息箱审计</h4>
          <p class="muted">这里直接读取消息箱水位、监听状态和近期 msg_id 断层。资源统计和副本页都以消息箱为事实来源。</p>
          <div id="healthAuditBody" class="health-audit-body">
            ${renderHealthAuditBody(initialAudit, {
              auditTimeLabel,
              formatChatTime,
              healthStatusLabel,
              listenerStatusText,
              renderResourceCoverage,
            })}
          </div>
        </section>
      `,
      footer: `
        <button type="button" id="healthAuditRefresh">刷新审计</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;
    const refresh = dialog.querySelector("#healthAuditRefresh");
    const body = dialog.querySelector("#healthAuditBody");
    const refreshAudit = async () => {
      if (!refresh || !body) return;
      refresh.disabled = true;
      body.innerHTML = '<p class="empty inline">深度审计中…</p>';
      try {
        const payload = await loadMessageAudit({ silent: true, deep: true });
        body.innerHTML = renderHealthAuditBody(payload, {
          auditTimeLabel,
          formatChatTime,
          healthStatusLabel,
          listenerStatusText,
          renderResourceCoverage,
        });
        updateGlobalBanner();
      } catch (error) {
        body.innerHTML = `<p class="empty inline">审计失败：${escapeHtml(error.message || "未知错误")}</p>`;
      } finally {
        refresh.disabled = false;
      }
    };
    refresh?.addEventListener("click", refreshAudit);
    if (!initialAudit?.deep) {
      refreshAudit();
    }
  }

  function renderHealthAuditBody(
    audit,
    {
      auditTimeLabel,
      formatChatTime,
      healthStatusLabel,
      listenerStatusText,
      renderResourceCoverage,
    },
  ) {
    if (!audit) {
      return '<p class="empty inline">尚未读取健康审计。</p>';
    }
    const messages = audit.messages || {};
    const listener = audit.listener || {};
    const running = listener.running || {};
    const runningRows = Object.entries(running).map(([key, value]) => ({
      key,
      status: value?.status || "",
      message: value?.message || "",
    }));
    const gaps = audit.gaps || [];
    const advice = healthAuditAdvice(audit, runningRows);
    const target = audit.target_chat
      ? `${audit.target_chat}${audit.target_topic_id ? ` / topic ${audit.target_topic_id}` : ""}`
      : "未配置";
    return `
      <div class="resource-stats-summary health-summary">
        <div class="resource-stat-card">
          <span>状态</span>
          <strong>${escapeHtml(healthStatusLabel(audit.status || "ok"))}</strong>
          <small>${escapeHtml(listenerStatusText(listener, runningRows.length))}</small>
        </div>
        <div class="resource-stat-card">
          <span>目标</span>
          <strong>${escapeHtml(target)}</strong>
          <small>监听群 / 话题</small>
        </div>
        <div class="resource-stat-card">
          <span>最新水位</span>
          <strong>#${escapeHtml(formatNumber(audit.latest_target_msg_id || messages.latest_msg_id || 0))}</strong>
          <small>${escapeHtml(auditTimeLabel(messages.latest_message_time || ""))}</small>
        </div>
        <div class="resource-stat-card ${Number(audit.gap_count || 0) ? "warn" : ""}">
          <span>近期断层</span>
          <strong>${escapeHtml(formatNumber(audit.gap_count || 0))}</strong>
          <small>近 ${escapeHtml(String(audit.since_hours || 24))} 小时 / ${escapeHtml(String(audit.min_gap_seconds || 300))} 秒阈值</small>
        </div>
        <div class="resource-stat-card">
          <span>消息/卡片</span>
          <strong>${escapeHtml(formatNumber(messages.real_raw_total || messages.raw_total || 0))}</strong>
          <small>卡片 ${escapeHtml(formatNumber(messages.parsed_cards || 0))}｜资源 ${escapeHtml(formatNumber(messages.resource_events || 0))}</small>
        </div>
      </div>
      ${advice.length ? `
        <div class="health-advice">
          <strong>建议检查</strong>
          ${advice.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
      ` : ""}
      ${runningRows.length ? `
        <div class="resource-stats-subtitle">监听</div>
        <div class="health-list">
          ${runningRows.map((row) => `
            <div>
              <strong>${escapeHtml(row.key)}</strong>
              <span>${escapeHtml(row.status || "unknown")}</span>
              <small>${escapeHtml(row.message || "")}</small>
            </div>
          `).join("")}
        </div>
      ` : '<p class="modal-status-line error">没有运行中的只读监听。</p>'}
      ${gaps.length ? `
        <div class="resource-stats-subtitle">近期断层</div>
        <table class="resource-stats-table health-gap-table">
          <thead>
            <tr>
              <th>起点</th>
              <th>终点</th>
              <th>缺失 msg_id</th>
              <th>间隔</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            ${gaps.map((gap) => gap.error ? `
              <tr><td colspan="5">${escapeHtml(gap.error)}</td></tr>
            ` : `
              <tr>
                <td>#${escapeHtml(formatNumber(gap.after_msg_id || 0))}</td>
                <td>#${escapeHtml(formatNumber(gap.before_msg_id || 0))}</td>
                <td class="num">${escapeHtml(formatNumber(gap.missing_msg_ids || 0))}</td>
                <td class="num">${escapeHtml(formatDurationShort(gap.gap_seconds || 0))}</td>
                <td>${escapeHtml(auditTimeLabel(gap.after_date || ""))} → ${escapeHtml(auditTimeLabel(gap.before_date || ""))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : '<p class="modal-status-line ok">近期没有命中明显断层。</p>'}
      ${Array.isArray(audit.notes) && audit.notes.length ? `<div class="resource-stats-notes">${audit.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : ""}
      ${audit.deep ? renderHealthDeepSections(audit, { formatChatTime, renderResourceCoverage }) : ""}
    `;
  }

  function renderHealthDeepSections(audit, { formatChatTime, renderResourceCoverage }) {
    const resourceCoverage = audit.resource_coverage || {};
    const filterDiagnostics = audit.filter_diagnostics || {};
    const dungeonAudit = audit.dungeon_audit || {};
    const deepNotes = audit.deep_notes || [];
    return `
      <section class="health-deep-section">
        <div class="resource-stats-subtitle">深度复盘</div>
        <div class="health-deep-grid">
          <div class="health-deep-block">
            <strong>资源覆盖</strong>
            ${renderHealthResourceCoverage(resourceCoverage, { renderResourceCoverage })}
          </div>
          <div class="health-deep-block">
            <strong>过滤分流</strong>
            ${renderHealthFilterDiagnostics(filterDiagnostics)}
          </div>
          <div class="health-deep-block">
            <strong>副本跳号</strong>
            ${renderHealthDungeonAudit(dungeonAudit, { formatChatTime })}
          </div>
        </div>
        ${deepNotes.length ? `
          <div class="health-deep-notes">
            ${deepNotes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}
          </div>
        ` : ""}
      </section>
    `;
  }

  function renderHealthResourceCoverage(payload, { renderResourceCoverage }) {
    if (!payload || !payload.ok) {
      return '<p class="empty inline">资源覆盖数据不可用。</p>';
    }
    const rows = payload.rows || [];
    return `
      <div class="health-mini-summary">
        <span>候选 ${escapeHtml(formatNumber(payload.candidate_rows || 0))}</span>
        <span>已扫 ${escapeHtml(formatNumber(payload.scanned || 0))}</span>
        <span>已解析 ${escapeHtml(formatNumber(payload.parsed || 0))}</span>
        <span>漏样 ${escapeHtml(formatNumber(payload.missing || 0))}</span>
      </div>
      ${renderResourceCoverage(payload)}
      ${rows.length ? `<p class="health-deep-hint">资源统计页遇到漏样时，先看覆盖诊断，再决定是否补解析。</p>` : ""}
    `;
  }

  function renderHealthFilterDiagnostics(payload) {
    if (!payload || !payload.ok) {
      return '<p class="empty inline">过滤分流数据不可用。</p>';
    }
    const reasons = payload.reason_rows || [];
    const senders = payload.focus_sender_rows || [];
    const samples = payload.samples || [];
    return `
      <div class="health-mini-summary">
        <span>重点 ${escapeHtml(formatNumber(payload.focus_count || 0))}</span>
        <span>归档 ${escapeHtml(formatNumber(payload.archive_count || 0))}</span>
        <span>会长 ${escapeHtml(formatNumber(payload.leader_count || 0))}</span>
      </div>
      <div class="health-inline-columns">
        <div>
          <small>入流原因</small>
          <ul class="health-mini-list">
            ${reasons.slice(0, 6).map((item) => `<li><span>${escapeHtml(item.reason || "")}</span><small>${escapeHtml(formatNumber(item.count || 0))}</small></li>`).join("") || "<li><span>暂无</span><small>0</small></li>"}
          </ul>
        </div>
        <div>
          <small>重点发送者</small>
          <ul class="health-mini-list">
            ${senders.slice(0, 6).map((item) => `<li><span>${escapeHtml(item.sender || "")}</span><small>${escapeHtml(formatNumber(item.count || 0))}</small></li>`).join("") || "<li><span>暂无</span><small>0</small></li>"}
          </ul>
        </div>
      </div>
      ${samples.length ? `
        <div class="health-deep-samples">
          ${samples.slice(0, 4).map((item) => `
            <p>
              <b>#${escapeHtml(String(item.seq || ""))}</b>
              <span>${escapeHtml((item.channels || []).join("/"))}</span>
              <small>${escapeHtml((item.reasons || []).join("、") || "无理由")}</small>
            </p>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  function renderHealthDungeonAudit(payload, { formatChatTime }) {
    if (!payload || !payload.ok) {
      return '<p class="empty inline">副本状态数据不可用。</p>';
    }
    const summaries = payload.summaries || [];
    const gaps = payload.gap_notes || [];
    return `
      <div class="health-mini-summary">
        <span>总计 ${escapeHtml(formatNumber(payload.total_summaries || 0))}</span>
        <span>可见 ${escapeHtml(formatNumber(summaries.length || 0))}</span>
        <span>${escapeHtml(String(payload.context_mode || ""))}</span>
      </div>
      ${gaps.length ? `<div class="health-deep-notes">${gaps.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : '<p class="health-deep-hint">最近没有明显副本跳号。</p>'}
      <div class="health-dungeon-preview">
        ${summaries.slice(0, 3).map((summary) => `
          <article class="health-dungeon-card">
            <strong>${escapeHtml(summary.dungeon_name || "副本")} #${escapeHtml(summary.dungeon_id || "—")}</strong>
            <small>${escapeHtml(summary.status || summary.status_kind || "")}</small>
            <span>${escapeHtml(formatChatTime(summary.latest_time || summary.latestMessage?.time || "") || summary.latest_time || "")}</span>
          </article>
        `).join("")}
      </div>
    `;
  }

  function healthAuditAdvice(audit, runningRows) {
    const messages = audit.messages || {};
    const advice = [];
    if (!audit.target_chat) {
      advice.push("监听目标群未配置，消息箱不会有稳定水位。");
    }
    if (!runningRows.length || audit.status === "error") {
      advice.push("没有运行中的监听，先在接入配置里恢复只读采集。");
    }
    if (Number(audit.gap_count || 0) > 0) {
      advice.push("近期存在 msg_id 断层，副本和资源统计需要先看覆盖诊断。");
    }
    if (Number(messages.invalid_date_total || 0) > 0) {
      advice.push("存在异常日期消息，可能影响按天/周/月统计。");
    }
    if (!Number(messages.resource_events || 0)) {
      advice.push("资源事件为 0，资源统计页应先跑覆盖诊断。");
    }
    return advice;
  }

  function formatDurationShort(seconds) {
    const n = Math.max(0, Number(seconds || 0));
    if (n >= 3600) return `${Math.round(n / 360) / 10}h`;
    if (n >= 60) return `${Math.round(n / 60)}m`;
    return `${Math.round(n)}s`;
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.health = { openHealthModal };
})();
