// MINIWEB-VIEW: resource stats modal and coverage renderer
(function () {
  "use strict";

  const { fetchJson, postJson } = window.MiniwebApi;
  const { openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function resourceStatsState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

async function openResourceStatsModal(deps = {}) {
  const dialog = openModal({
    title: "资源统计",
    body: `
      <section class="modal-section">
        <h4>全服资源统计</h4>
        <p class="muted">当前统计消息箱采集到的「野外历练」「风希」「极阴」「南陇侯」「非血色副本」「灵树」结算。副本可按入口单独筛选，稀有产物会优先展示。</p>
        <div class="form-grid resource-stats-controls">
          <label>
            <span>周期</span>
            <select id="resourceStatsPeriod">
              <option value="day">按天</option>
              <option value="week">按周</option>
              <option value="month">按月</option>
            </select>
          </label>
          <label>
            <span>来源</span>
            <select id="resourceStatsSource">
              <option value="all">全部</option>
              <option value="wild_training">野外历练</option>
              <option value="wind_xi">风希</option>
              <option value="jiyin">极阴</option>
              <option value="nanlong">南陇侯</option>
              <option value="tree_harvest">灵树采摘</option>
              <option value="dungeon">副本结算（全部）</option>
              <option value="dungeon|虚天殿·夺鼎">副本 · 虚天殿 · 夺鼎</option>
              <option value="dungeon|虚天殿·求稳">副本 · 虚天殿 · 求稳</option>
              <option value="dungeon|黄龙山">副本 · 黄龙山</option>
              <option value="dungeon|昆吾山">副本 · 昆吾山</option>
              <option value="dungeon|坠魔谷">副本 · 坠魔谷</option>
            </select>
          </label>
        </div>
        <div class="form-actions">
          <button type="button" id="resourceStatsRefresh">刷新统计</button>
          <button type="button" id="resourceCoverageRefresh">覆盖诊断</button>
          <button type="button" id="resourceCoverageReparse">补解析漏样本</button>
        </div>
        <p class="modal-status-line info" id="resourceStatsStatus" hidden></p>
      </section>

      <section class="modal-section">
        <div id="resourceStatsSummary" class="resource-stats-summary"></div>
        <div id="resourceCoverageBox" class="resource-stats-table-wrap" hidden></div>
        <div id="resourceStatsTable" class="resource-stats-table-wrap">
          <p class="empty inline">选择周期和来源后，点击「刷新统计」读取数据。打开面板不会自动统计。</p>
        </div>
      </section>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindResourceStatsModal(deps, dialog);
  setResourceStatsStatus(dialog, "info", "未自动统计。需要时点「刷新统计」。");
}

function bindResourceStatsModal(deps = {}, dialog) {
  dialog.querySelector("#resourceStatsRefresh")?.addEventListener("click", () => {
    refreshResourceStats(deps, dialog).catch((error) => {
      setResourceStatsStatus(dialog, "error", error.message || "刷新失败");
    });
  });
  dialog.querySelector("#resourceCoverageRefresh")?.addEventListener("click", () => {
    refreshResourceCoverage(deps, dialog).catch((error) => {
      setResourceStatsStatus(dialog, "error", error.message || "覆盖诊断失败");
    });
  });
  dialog.querySelector("#resourceCoverageReparse")?.addEventListener("click", () => {
    reparseResourceCoverage(deps, dialog).catch((error) => {
      setResourceStatsStatus(dialog, "error", error.message || "补解析失败");
    });
  });
  dialog.querySelector("#resourceStatsPeriod")?.addEventListener("change", () => {
    resetResourceStatsPlaceholder(dialog);
  });
  dialog.querySelector("#resourceStatsSource")?.addEventListener("change", () => {
    resetResourceStatsPlaceholder(dialog);
  });
}

async function reparseResourceCoverage(deps = {}, dialog) {
  const button = dialog.querySelector("#resourceCoverageReparse");
  if (button) button.disabled = true;
  setResourceStatsStatus(dialog, "info", "正在重跑最近漏解析资源候选…");
  try {
    const payload = await postJson("/api/resource-coverage/reparse", { limit: 5000 });
    if (!payload.ok) throw new Error(payload.error || "补解析失败");
    const text = `补解析完成：有效 ${payload.scanned || 0} 条，跳过噪音 ${payload.skipped || 0} 条，写入事件 ${payload.reparsed_events || 0}，流水 ${payload.reparsed_deltas || 0}，仍未识别 ${payload.still_missing || 0}`;
    setResourceStatsStatus(dialog, payload.still_missing ? "warn" : "ok", text);
    await refreshResourceCoverage(deps, dialog);
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshResourceCoverage(deps = {}, dialog) {
  const box = dialog.querySelector("#resourceCoverageBox");
  const button = dialog.querySelector("#resourceCoverageRefresh");
  if (box) {
    box.hidden = false;
    box.innerHTML = '<p class="empty inline">覆盖诊断中…</p>';
  }
  if (button) button.disabled = true;
  setResourceStatsStatus(dialog, "info", "正在扫描最近疑似资源文案…");
  try {
    const payload = await fetchJson("/api/resource-coverage?limit=5000");
    if (!payload.ok) throw new Error(payload.error || "覆盖诊断失败");
    if (box) box.innerHTML = renderResourceCoverage(payload);
    setResourceStatsStatus(
      dialog,
      payload.missing ? "warn" : "ok",
      `覆盖诊断：有效 ${payload.scanned || 0} 条，已解析 ${payload.parsed || 0} 条，疑似漏 ${payload.missing || 0} 条，已排除噪音 ${payload.ignored || 0} 条。`
    );
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshResourceStats(deps = {}, dialog) {
  const period = dialog.querySelector("#resourceStatsPeriod")?.value || "day";
  const sourceFilter = parseResourceStatsSource(dialog.querySelector("#resourceStatsSource")?.value || "all");
  const table = dialog.querySelector("#resourceStatsTable");
  const refreshButton = dialog.querySelector("#resourceStatsRefresh");
  if (table) table.innerHTML = '<p class="empty inline">加载中…</p>';
  if (refreshButton) refreshButton.disabled = true;
  setResourceStatsStatus(dialog, "info", "正在读取统计…");
  try {
    const params = new URLSearchParams({ period, source_type: sourceFilter.source_type, limit: "500" });
    if (sourceFilter.source_name) params.set("source_name", sourceFilter.source_name);
    const payload = await fetchJson(`/api/resource-stats?${params.toString()}`);
    renderResourceStats(deps, dialog, payload);
    const count = (payload.rows || []).length + (payload.events || []).length;
    setResourceStatsStatus(dialog, "ok", `已加载 ${count} 行。血色副本结算不会进入这里。`);
  } catch (error) {
    if (table) {
      table.innerHTML = `<p class="empty inline">统计读取失败：${escapeHtml(error.message || "未知错误")}</p>`;
    }
    throw error;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

function resetResourceStatsPlaceholder(dialog) {
  const summary = dialog.querySelector("#resourceStatsSummary");
  const table = dialog.querySelector("#resourceStatsTable");
  const coverage = dialog.querySelector("#resourceCoverageBox");
  if (summary) summary.innerHTML = "";
  if (coverage) {
    coverage.hidden = true;
    coverage.innerHTML = "";
  }
  if (table) {
    table.innerHTML = '<p class="empty inline">筛选条件已改变，点击「刷新统计」重新读取。</p>';
  }
  setResourceStatsStatus(dialog, "info", "未自动刷新，避免打开或切换时重复扫统计。");
}

function setResourceStatsStatus(dialog, kind, text) {
  const status = dialog.querySelector("#resourceStatsStatus");
  if (!status) return;
  status.hidden = !text;
  status.className = `modal-status-line ${kind || "info"}`;
  status.textContent = text || "";
}

function renderResourceStats(deps = {}, dialog, payload) {
  const rows = payload.rows || [];
  const events = payload.events || [];
  const eventSummary = payload.event_summary || [];
  const summary = dialog.querySelector("#resourceStatsSummary");
  const table = dialog.querySelector("#resourceStatsTable");
  if (summary) {
    summary.innerHTML = renderResourceDashboard(deps, payload);
  }
  if (!table) return;
  if (!rows.length && !events.length) {
    table.innerHTML = '<p class="empty inline">暂无统计数据。只有 listener 采到对应结算文案后才会出现。</p>';
    return;
  }
  table.innerHTML = `
    <div class="resource-stats-detail-head">
      <span>明细默认收起，避免大表拖慢弹窗。</span>
      <button type="button" id="resourceStatsToggleDetails">展开明细</button>
    </div>
    <div id="resourceStatsDetailBody" hidden>
      ${renderResourceDeltaTable(rows)}
      ${renderResourceEventTable(eventSummary)}
      ${renderResourceDiagnostics(payload.diagnostics || {})}
      ${Array.isArray(payload.notes) && payload.notes.length
        ? `<div class="resource-stats-notes">${payload.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>`
        : ""}
    </div>
  `;
  const toggle = table.querySelector("#resourceStatsToggleDetails");
  const detail = table.querySelector("#resourceStatsDetailBody");
  toggle?.addEventListener("click", () => {
    if (!detail) return;
    const hidden = detail.hidden;
    detail.hidden = !hidden;
    toggle.textContent = hidden ? "收起明细" : "展开明细";
  });
}

function renderResourceDashboard(deps = {}, payload) {
  const rows = payload.rows || [];
  const eventSummary = payload.event_summary || [];
  const latestPeriod = latestResourcePeriod(rows, eventSummary);
  const sourceType = payload.source_type || "all";
  const sections = [];
  sections.push(`
    <section class="resource-dashboard-section compact">
      <div class="resource-dashboard-head">
        <div>
          <strong>统计口径</strong>
          <span>${escapeHtml(latestPeriod || "暂无周期")}｜${escapeHtml(resourceStatsScopeLabel(payload))}</span>
        </div>
      </div>
      <div class="resource-dashboard-strip">
        ${renderResourceTrustCards(deps, payload)}
      </div>
    </section>
  `);
  if (sourceType === "all" || sourceType === "wild_training") {
    sections.push(renderWildTrainingDashboardPanel(rows, eventSummary, latestPeriod));
  }
  sections.push(renderRareResourceDashboardPanel(rows, latestPeriod));
  sections.push(renderEventOutcomeDashboardPanel(eventSummary, latestPeriod, sourceType));
  return `<div class="resource-dashboard">${sections.filter(Boolean).join("")}</div>`;
}

function renderWildTrainingDashboardPanel(rows, eventSummary, latestPeriod) {
  const strategies = ["谨慎", "均衡", "深入"];
  const periodEvents = filterResourceRowsByPeriod(eventSummary, latestPeriod)
    .filter((row) => row.source_type === "wild_training");
  const periodRows = filterResourceRowsByPeriod(rows, latestPeriod)
    .filter((row) => row.source_type === "wild_training");
  if (!periodEvents.length && !periodRows.length) return "";
  const byStrategy = new Map(strategies.map((strategy) => [strategy, {
    strategy,
    success: 0,
    failed: 0,
    cooldown: 0,
    total: 0,
    gainXiuwei: 0,
    lossXiuwei: 0,
  }]));
  for (const row of periodEvents) {
    const strategy = wildStrategyFromSourceName(row.source_name);
    if (!byStrategy.has(strategy)) continue;
    const target = byStrategy.get(strategy);
    target.success += Number(row.success || 0) + Number(row.extra_success || 0);
    target.failed += Number(row.failed || 0) + Number(row.basic_only || 0);
    target.cooldown += Number(row.cooldown || 0);
    target.total += Number(row.total || 0);
  }
  for (const row of periodRows) {
    const strategy = wildStrategyFromSourceName(row.source_name);
    if (!byStrategy.has(strategy)) continue;
    if (!String(row.resource_name || "").includes("修为")) continue;
    const target = byStrategy.get(strategy);
    const amount = Number(row.total_amount || 0);
    if (amount >= 0) target.gainXiuwei += amount;
    else target.lossXiuwei += Math.abs(amount);
  }
  return `
    <section class="resource-dashboard-section">
      <div class="resource-dashboard-head">
        <div>
          <strong>野外历练</strong>
          <span>${escapeHtml(latestPeriod || "本期")}｜三难度成功率和修为正负收益分开看</span>
        </div>
      </div>
      <div class="resource-wild-grid">
        ${strategies.map((strategy) => renderWildStrategyCard(byStrategy.get(strategy))).join("")}
      </div>
    </section>
  `;
}

function renderWildStrategyCard(item) {
  const attempts = item.success + item.failed;
  const rate = attempts ? (item.success * 100) / attempts : 0;
  return `
    <article class="resource-wild-card">
      <div class="resource-wild-card-head">
        <strong>${escapeHtml(item.strategy)}</strong>
        <span>${attempts ? `${rate.toFixed(1)}%` : "—"}</span>
      </div>
      <div class="resource-progress-bar" aria-hidden="true">
        <span style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></span>
      </div>
      <div class="resource-wild-stats">
        <span>成功 <b>${escapeHtml(formatNumber(item.success))}</b></span>
        <span>失败 <b>${escapeHtml(formatNumber(item.failed))}</b></span>
        <span>CD <b>${escapeHtml(formatNumber(item.cooldown))}</b></span>
      </div>
      <div class="resource-wild-yield">
        <span>修为 +${escapeHtml(formatNumber(item.gainXiuwei))}</span>
        <span class="negative">-${escapeHtml(formatNumber(item.lossXiuwei))}</span>
      </div>
    </article>
  `;
}

function renderRareResourceDashboardPanel(rows, latestPeriod) {
  const rareRows = aggregateRareResourceRows(filterResourceRowsByPeriod(rows, latestPeriod));
  if (!rareRows.length) return "";
  const yinNing = rareRows.find((row) => isYinNingResource(row.resource_name));
  const scarce = rareRows
    .filter((row) => !isYinNingResource(row.resource_name))
    .sort((a, b) => (
      Number(a.total_amount || 0) - Number(b.total_amount || 0)
      || Number(a.event_count || 0) - Number(b.event_count || 0)
      || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
    ))
    .slice(0, yinNing ? 5 : 6);
  const items = [yinNing, ...scarce].filter(Boolean);
  return `
    <section class="resource-dashboard-section">
      <div class="resource-dashboard-head">
        <div>
          <strong>稀有产物</strong>
          <span>${escapeHtml(latestPeriod || "本期")}｜阴凝优先，其余按低量稀有靠前</span>
        </div>
      </div>
      <div class="resource-rare-grid">
        ${items.map((item) => `
          <article class="resource-rare-card ${isYinNingResource(item.resource_name) ? "highlight" : ""}">
            <span>${escapeHtml(item.resource_name || "资源")}</span>
            <strong>${escapeHtml(formatResourceAmount(item.total_amount, item.unit))}</strong>
            <small>${escapeHtml((item.sources || []).slice(0, 2).join(" / ") || "资源")}｜${escapeHtml(formatNumber(item.event_count))} 次</small>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderEventOutcomeDashboardPanel(eventSummary, latestPeriod, sourceType) {
  const rows = filterResourceRowsByPeriod(eventSummary, latestPeriod)
    .filter((row) => row.source_type !== "wild_training");
  if (!rows.length) return "";
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.source_type || ""}|${row.source_name || ""}`;
    const item = grouped.get(key) || {
      source_type: row.source_type || "",
      source_name: row.source_name || "",
      success: 0,
      failed: 0,
      escaped: 0,
      cooldown: 0,
      extra: 0,
      basic: 0,
      settled: 0,
      total: 0,
      outcomes: [],
    };
    item.success += Number(row.success || 0);
    item.failed += Number(row.failed || 0);
    item.escaped += Number(row.escaped || 0);
    item.cooldown += Number(row.cooldown || 0);
    item.extra += Number(row.extra_success || 0);
    item.basic += Number(row.basic_only || 0);
    item.settled += Number(row.settled || 0);
    item.total += Number(row.total || 0);
    if (row.outcome && !item.outcomes.includes(row.outcome)) item.outcomes.push(row.outcome);
    grouped.set(key, item);
  }
  const title = sourceType === "dungeon" ? "副本结算" : "副本 / 奇遇";
  const items = Array.from(grouped.values())
    .sort((a, b) => outcomeSourceRank(a.source_type) - outcomeSourceRank(b.source_type) || String(a.source_name).localeCompare(String(b.source_name), "zh-CN"))
    .slice(0, 8);
  return `
    <section class="resource-dashboard-section">
      <div class="resource-dashboard-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(latestPeriod || "本期")}｜副本按入口，风希/极阴/南陇侯单列</span>
        </div>
      </div>
      <div class="resource-outcome-grid">
        ${items.map(renderOutcomeCard).join("")}
      </div>
    </section>
  `;
}

function renderOutcomeCard(item) {
  const isDungeon = item.source_type === "dungeon";
  const main = isDungeon
    ? `${formatNumber(item.extra + item.basic + item.settled)} 次`
    : `${formatNumber(item.success + item.failed + item.escaped || item.total)} 次`;
  const detail = isDungeon
    ? `额外 ${formatNumber(item.extra)}｜基础 ${formatNumber(item.basic)}｜结算 ${formatNumber(item.settled)}`
    : `成功 ${formatNumber(item.success)}｜失败 ${formatNumber(item.failed)}${item.escaped ? `｜逃脱 ${formatNumber(item.escaped)}` : ""}`;
  return `
    <article class="resource-outcome-card ${escapeAttr(item.source_type || "unknown")}">
      <span>${escapeHtml(resourceSourceLabel(item.source_type, item.source_name))}</span>
      <strong>${escapeHtml(main)}</strong>
      <small>${escapeHtml(detail)}</small>
      ${item.outcomes.length ? `<em>${escapeHtml(item.outcomes.slice(0, 2).join(" / "))}</em>` : ""}
    </article>
  `;
}

function outcomeSourceRank(sourceType) {
  return {
    dungeon: 1,
    wind_xi: 2,
    jiyin: 3,
    nanlong: 4,
    tree_harvest: 5,
  }[sourceType] || 9;
}

function renderResourceDiagnostics(diagnostics) {
  const unknown = Number(diagnostics.unknown_source_events || 0);
  const empty = Number(diagnostics.empty_outcome_events || 0);
  if (!unknown && !empty) return "";
  const chips = [];
  if (unknown) chips.push(`来源未知 ${formatNumber(unknown)} 条`);
  if (empty) chips.push(`结果细分空 ${formatNumber(empty)} 条`);
  const samples = [
    ...(diagnostics.unknown_sources || []).slice(0, 3),
    ...(diagnostics.empty_outcomes || []).slice(0, 3),
  ];
  return `
    <div class="resource-stats-notes warn">
      ${chips.map((text) => `<span>${escapeHtml(text)}</span>`).join("")}
      ${samples.map((item) => `<span>${escapeHtml(item.source || "")}｜${escapeHtml(formatNumber(item.count || 0))}</span>`).join("")}
    </div>
  `;
}

function renderResourceTrustCards(deps = {}, payload) {
  const audit = resourceStatsState(deps).messageAudit || {};
  const gapCount = Number(audit.gap_count || 0);
  const rows = payload.rows || [];
  const events = payload.events || [];
  const cards = [];
  cards.push(`
    <div class="resource-stat-card ${gapCount ? "warn" : ""}">
      <span>统计可信度</span>
      <strong>${escapeHtml(gapCount ? "需复核" : "正常")}</strong>
      <small>${gapCount ? `消息箱近24小时 ${formatNumber(gapCount)} 段断层` : "消息箱近期无明显断层"}</small>
    </div>
  `);
  cards.push(`
    <div class="resource-stat-card">
      <span>当前口径</span>
      <strong>${escapeHtml(resourceStatsScopeLabel(payload))}</strong>
      <small>${escapeHtml((payload.period || "day") === "week" ? "按周" : (payload.period || "day") === "month" ? "按月" : "按天")}｜${escapeHtml(formatNumber(events.length))} 事件行 / ${escapeHtml(formatNumber(rows.length))} 资源行</small>
    </div>
  `);
  return cards.join("");
}

function resourceStatsScopeLabel(payload) {
  const type = payload.source_type || "all";
  const name = payload.source_name || "";
  if (!type || type === "all") return "全部来源";
  return resourceSourceLabel(type, name);
}

function renderResourceCoverage(payload) {
  const rows = payload.rows || [];
  const samples = payload.missing_samples || [];
  if (!rows.length) {
    return '<p class="empty inline">最近没有命中资源统计候选文案。</p>';
  }
  return `
    <div class="resource-stats-subtitle">覆盖诊断 · 有效 ${escapeHtml(formatNumber(payload.scanned || 0))} 条 / 原始 ${escapeHtml(formatNumber(payload.candidate_rows || payload.scanned || 0))} 条</div>
    <table class="resource-stats-table">
      <thead>
        <tr>
          <th>文案类型</th>
          <th>候选</th>
          <th>已解析</th>
          <th>疑似漏</th>
          <th>覆盖率</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const total = Number(row.total || 0);
          const parsed = Number(row.parsed || 0);
          const rate = total ? `${Math.round((parsed * 1000) / total) / 10}%` : "—";
          return `
            <tr>
              <td>${escapeHtml(row.kind || "")}</td>
              <td class="num">${escapeHtml(formatNumber(total))}</td>
              <td class="num">${escapeHtml(formatNumber(parsed))}</td>
              <td class="num ${Number(row.missing || 0) ? "negative" : ""}">${escapeHtml(formatNumber(row.missing || 0))}</td>
              <td class="num">${escapeHtml(rate)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    ${samples.length ? `
      <div class="resource-stats-notes">
        ${samples.slice(0, 8).map((item) => `<span>${escapeHtml(item.kind || "")}｜#${escapeHtml(String(item.msg_id || ""))}｜${escapeHtml(clipGraphemes(item.text || "", 72))}</span>`).join("")}
      </div>
    ` : ""}
    ${Array.isArray(payload.notes) && payload.notes.length ? `<div class="resource-stats-notes">${payload.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : ""}
  `;
}

function renderResourceEventTable(summaryRows) {
  if (!summaryRows.length) return "";
  return groupResourceRowsBySource(summaryRows).map((group) => `
    <div class="resource-stats-subtitle">执行结果 · ${escapeHtml(group.label)}</div>
    <table class="resource-stats-table">
      <thead>
        <tr>
          <th>周期</th>
          <th>来源</th>
          <th>成功/额外</th>
          <th>失败/基础</th>
          <th>冷却</th>
          <th>结算</th>
          <th>成功率</th>
        </tr>
      </thead>
      <tbody>
        ${group.rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.period || "")}</td>
            <td>${escapeHtml(resourceSourceLabel(row.source_type, row.source_name))}</td>
            <td class="num">${escapeHtml(formatNumber((row.success || 0) + (row.extra_success || 0)))}</td>
            <td class="num">${escapeHtml(formatNumber((row.failed || 0) + (row.basic_only || 0)))}</td>
            <td class="num">${escapeHtml(formatNumber(row.cooldown || 0))}</td>
            <td class="num">${escapeHtml(formatNumber(row.settled || 0))}</td>
            <td class="num">${escapeHtml(formatSuccessRate(row.success_rate))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `).join("");
}

function renderResourceDeltaTable(rows) {
  if (!rows.length) return "";
  return `
    ${renderResourceDeltaAggregateTable(rows)}
    ${groupResourceRowsBySource(rows).map((group) => `
    ${renderResourceDeltaSubTable("稀有产物", group.rows.filter((row) => row.resource_category === "rare"), group.label)}
    ${renderResourceDeltaSubTable("正收益", group.rows.filter((row) => row.resource_category !== "rare" && row.amount_kind !== "loss"), group.label)}
    ${renderResourceDeltaSubTable("负收益", group.rows.filter((row) => row.amount_kind === "loss"), group.label)}
  `).join("")}
  `;
}

function renderResourceDeltaAggregateTable(rows) {
  const sourceCount = new Set(rows.map((row) => `${row.source_type || ""}|${row.source_name || ""}`)).size;
  if (sourceCount <= 1) return "";
  const isWildOnly = rows.length > 0 && rows.every((row) => row.source_type === "wild_training");
  const aggregateRows = aggregateResourceRows(rows).map((row) => (
    isWildOnly ? { ...row, source_type: "wild_training" } : row
  ));
  return `
    ${renderResourceDeltaSubTable("稀有产物", aggregateRows.filter((row) => row.resource_category === "rare"), "全部来源汇总")}
    ${renderResourceDeltaSubTable("正收益", aggregateRows.filter((row) => row.resource_category !== "rare" && row.amount_kind !== "loss"), "全部来源汇总")}
    ${renderResourceDeltaSubTable("负收益", aggregateRows.filter((row) => row.amount_kind === "loss"), "全部来源汇总")}
  `;
}

function aggregateResourceRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [
      row.period || "",
      row.resource_name || "",
      row.unit || "",
      row.basis || "",
      row.amount_kind || "",
      row.resource_category || "",
    ].join("|");
    const prev = grouped.get(key) || {
      period: row.period || "",
      source_type: "aggregate",
      source_name: "全部来源汇总",
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      amount_kind: row.amount_kind || "",
      resource_category: row.resource_category || "",
      total_amount: 0,
      event_count: 0,
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    grouped.set(key, prev);
  }
  return Array.from(grouped.values()).sort((a, b) => (
    String(b.period || "").localeCompare(String(a.period || ""), "zh-CN")
    || String(b.resource_category || "").localeCompare(String(a.resource_category || ""), "zh-CN")
    || String(a.amount_kind || "").localeCompare(String(b.amount_kind || ""), "zh-CN")
    || Math.abs(Number(b.total_amount || 0)) - Math.abs(Number(a.total_amount || 0))
    || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
  ));
}

function renderResourceDeltaSubTable(title, rows, label) {
  if (!rows.length) return "";
  const displayRows = sortResourceDeltaRowsForDisplay(rows, title);
  return `
    <div class="resource-stats-subtitle">${escapeHtml(title)} · ${escapeHtml(label)}</div>
    <table class="resource-stats-table">
      <thead>
        <tr>
          <th>周期</th>
          <th>资源</th>
          <th>合计</th>
          <th>单数</th>
          <th>口径</th>
        </tr>
      </thead>
      <tbody>
        ${displayRows.map((row) => `
          <tr>
            <td>${escapeHtml(row.period || "")}</td>
            <td>${escapeHtml(row.resource_name || "")}</td>
            <td class="num ${Number(row.total_amount || 0) < 0 ? "negative" : ""}">${escapeHtml(formatResourceAmount(row.total_amount, row.unit))}</td>
            <td class="num">${escapeHtml(formatNumber(row.event_count || 0))}</td>
            <td>${escapeHtml(resourceBasisLabel(row.basis))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function sortResourceDeltaRowsForDisplay(rows, title) {
  const items = [...(rows || [])];
  const isWildRare = title === "稀有产物" && items.some((row) => row.source_type === "wild_training");
  if (!isWildRare) return items;
  return items.sort((a, b) => (
    String(b.period || "").localeCompare(String(a.period || ""), "zh-CN")
    || Number(!isYinNingResource(a.resource_name)) - Number(!isYinNingResource(b.resource_name))
    || Number(a.total_amount || 0) - Number(b.total_amount || 0)
    || Number(a.event_count || 0) - Number(b.event_count || 0)
    || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
  ));
}

function groupResourceRowsBySource(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const label = resourceSourceLabel(row.source_type, row.source_name);
    const key = `${row.source_type || ""}|${row.source_name || ""}`;
    if (!grouped.has(key)) grouped.set(key, { label, rows: [] });
    grouped.get(key).rows.push(row);
  }
  return Array.from(grouped.values());
}

function renderResourceStatsSummary(rows, eventSummary, payload = {}) {
  if (!rows.length && !eventSummary.length) return "";
  if (payload.source_type === "wild_training") {
    return renderWildTrainingStatsSummary(rows, eventSummary);
  }
  const rareRows = rows.filter((row) => row.resource_category === "rare");
  const latestRarePeriod = latestResourcePeriod(rareRows, []);
  const latestEventPeriod = latestResourcePeriod([], eventSummary);
  const summaryRows = latestRarePeriod
    ? rareRows.filter((row) => String(row.period || "") === latestRarePeriod)
    : rareRows;
  const summaryEvents = latestEventPeriod
    ? eventSummary.filter((row) => String(row.period || "") === latestEventPeriod)
    : eventSummary;
  const cards = [];
  const totals = new Map();
  for (const row of summaryRows) {
    const key = `${row.resource_name || ""}|${row.unit || ""}|${row.basis || ""}`;
    const prev = totals.get(key) || {
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      total_amount: 0,
      event_count: 0,
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    totals.set(key, prev);
  }
  const top = Array.from(totals.values())
    .sort((a, b) => b.total_amount - a.total_amount || String(a.resource_name).localeCompare(String(b.resource_name), "zh-CN"))
    .slice(0, 4);
  cards.push(...top.map((item) => `
      <div class="resource-stat-card">
        <span>稀有｜${escapeHtml(item.resource_name || "资源")}</span>
        <strong>${escapeHtml(formatResourceAmount(item.total_amount, item.unit))}</strong>
        <small>${escapeHtml(latestRarePeriod || "本期")}｜${escapeHtml(resourceBasisLabel(item.basis))}｜${escapeHtml(formatNumber(item.event_count))} 次</small>
      </div>
  `));
  for (const item of summaryEvents.slice(0, 4)) {
    if (cards.length >= 6) break;
    const successRate = formatSuccessRate(item.success_rate);
    const eventTotal = Number(item.total || 0);
    const dungeonCount = Number((item.settled || 0) + (item.basic_only || 0) + (item.extra_success || 0));
    const main = item.source_type === "wild_training"
      ? `${formatNumber(item.success || 0)} 成 / ${formatNumber(item.failed || 0)} 败`
      : item.source_type === "wind_xi"
        ? `${formatNumber(item.success || 0)} 次成功`
        : item.source_type === "dungeon"
          ? `${formatNumber(dungeonCount)} 次`
          : `${formatNumber(eventTotal || dungeonCount)} 次`;
    const sub = item.source_type === "wild_training"
      ? `CD ${formatNumber(item.cooldown || 0)}｜成功率 ${successRate}`
      : item.source_type === "wind_xi"
        ? `成功率 ${successRate}`
        : item.source_type === "dungeon"
          ? `额外 ${formatNumber(item.extra_success || 0)}｜基础 ${formatNumber(item.basic_only || 0)}`
          : `成功 ${formatNumber(item.success || 0)}｜结算 ${formatNumber(item.settled || 0)}`;
    cards.push(`
      <div class="resource-stat-card">
        <span>${escapeHtml(resourceSourceLabel(item.source_type, item.source_name))}｜${escapeHtml(item.period || "")}</span>
        <strong>${escapeHtml(main)}</strong>
        <small>${escapeHtml(sub)}</small>
      </div>
    `);
  }
  return cards.join("");
}

function renderWildTrainingStatsSummary(rows, eventSummary) {
  const latestPeriod = latestResourcePeriod(rows, eventSummary);
  const periodEvents = latestPeriod
    ? eventSummary.filter((row) => String(row.period || "") === latestPeriod)
    : eventSummary;
  const periodRows = latestPeriod
    ? rows.filter((row) => String(row.period || "") === latestPeriod)
    : rows;
  const cards = [];
  const strategies = ["谨慎", "均衡", "深入"];
  const byStrategy = new Map(strategies.map((strategy) => [strategy, {
    strategy,
    success: 0,
    failed: 0,
    cooldown: 0,
    total: 0,
  }]));
  for (const row of periodEvents) {
    const strategy = wildStrategyFromSourceName(row.source_name);
    if (!byStrategy.has(strategy)) continue;
    const target = byStrategy.get(strategy);
    target.success += Number(row.success || 0) + Number(row.extra_success || 0);
    target.failed += Number(row.failed || 0) + Number(row.basic_only || 0);
    target.cooldown += Number(row.cooldown || 0);
    target.total += Number(row.total || 0);
  }
  for (const strategy of strategies) {
    const item = byStrategy.get(strategy);
    const attempts = item.success + item.failed;
    const rate = attempts ? `${((item.success * 100) / attempts).toFixed(1)}%` : "—";
    cards.push(`
      <div class="resource-stat-card">
        <span>野外历练·${escapeHtml(strategy)}｜${escapeHtml(latestPeriod || "本期")}</span>
        <strong>${escapeHtml(rate)}</strong>
        <small>${escapeHtml(formatNumber(item.success))} 成 / ${escapeHtml(formatNumber(item.failed))} 败｜CD ${escapeHtml(formatNumber(item.cooldown))}</small>
      </div>
    `);
  }

  const rareRows = aggregateWildRareRows(periodRows);
  const yinNing = rareRows.find((row) => isYinNingResource(row.resource_name)) || {
    resource_name: "阴凝之晶",
    total_amount: 0,
    event_count: 0,
    unit: "",
    basis: "player",
  };
  cards.push(`
    <div class="resource-stat-card">
      <span>稀有｜阴凝之晶</span>
      <strong>${escapeHtml(formatResourceAmount(yinNing.total_amount, yinNing.unit))}</strong>
      <small>${escapeHtml(latestPeriod || "本期")}｜${escapeHtml(formatNumber(yinNing.event_count))} 次</small>
    </div>
  `);

  const scarceRows = rareRows
    .filter((row) => !isYinNingResource(row.resource_name))
    .sort((a, b) => (
      Number(a.total_amount || 0) - Number(b.total_amount || 0)
      || Number(a.event_count || 0) - Number(b.event_count || 0)
      || String(a.resource_name || "").localeCompare(String(b.resource_name || ""), "zh-CN")
    ))
    .slice(0, 2);
  cards.push(...scarceRows.map((item) => `
    <div class="resource-stat-card">
      <span>低量稀有｜${escapeHtml(item.resource_name || "资源")}</span>
      <strong>${escapeHtml(formatResourceAmount(item.total_amount, item.unit))}</strong>
      <small>${escapeHtml(latestPeriod || "本期")}｜${escapeHtml(formatNumber(item.event_count))} 次</small>
    </div>
  `));
  return cards.join("");
}

function aggregateWildRareRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (row.source_type !== "wild_training") continue;
    if (row.resource_category !== "rare") continue;
    if (row.amount_kind === "loss") continue;
    const key = `${row.resource_name || ""}|${row.unit || ""}|${row.basis || ""}`;
    const prev = grouped.get(key) || {
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      total_amount: 0,
      event_count: 0,
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    grouped.set(key, prev);
  }
  return Array.from(grouped.values());
}

function aggregateRareResourceRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (row.resource_category !== "rare") continue;
    if (row.amount_kind === "loss") continue;
    const key = `${row.resource_name || ""}|${row.unit || ""}|${row.basis || ""}`;
    const prev = grouped.get(key) || {
      resource_name: row.resource_name || "",
      unit: row.unit || "",
      basis: row.basis || "",
      total_amount: 0,
      event_count: 0,
      sources: new Set(),
    };
    prev.total_amount += Number(row.total_amount || 0);
    prev.event_count += Number(row.event_count || 0);
    prev.sources.add(resourceSourceLabel(row.source_type, row.source_name));
    grouped.set(key, prev);
  }
  return Array.from(grouped.values()).map((item) => ({
    ...item,
    sources: Array.from(item.sources).filter(Boolean),
  }));
}

function filterResourceRowsByPeriod(rows, period) {
  const source = rows || [];
  if (!period) return source;
  return source.filter((row) => String(row.period || "") === String(period));
}

function wildStrategyFromSourceName(sourceName) {
  const text = String(sourceName || "");
  if (text.includes("谨慎")) return "谨慎";
  if (text.includes("均衡")) return "均衡";
  if (text.includes("深入")) return "深入";
  return "";
}

function isYinNingResource(resourceName) {
  return String(resourceName || "").includes("阴凝");
}

function latestResourcePeriod(rows, eventSummary) {
  const periods = [...rows, ...eventSummary]
    .map((row) => String(row.period || ""))
    .filter(Boolean);
  if (!periods.length) return "";
  return periods.sort((a, b) => b.localeCompare(a, "zh-CN"))[0] || "";
}

function resourceSourceLabel(sourceType, sourceName) {
  if (sourceType === "wild_training") return sourceName || "野外历练";
  if (sourceType === "wind_xi") return "风希";
  if (sourceType === "jiyin") return "极阴";
  if (sourceType === "nanlong") return "南陇侯";
  if (sourceType === "dungeon") return sourceName ? `副本 · ${sourceName}` : "副本结算";
  if (sourceType === "tree_harvest") return sourceName || "灵树采摘";
  return sourceName || sourceType || "未知";
}

function parseResourceStatsSource(value) {
  const raw = String(value || "all");
  const [sourceType, ...rest] = raw.split("|");
  return {
    source_type: sourceType || "all",
    source_name: rest.join("|").trim(),
  };
}

function resourceBasisLabel(value) {
  if (value === "run") return "单次";
  if (value === "player") return "单人";
  return value || "事件";
}

function formatSuccessRate(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
}

function formatResourceAmount(value, unit) {
  const text = formatNumber(value);
  return unit ? `${text} ${unit}` : text;
}

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.resourceStats = {
    openResourceStatsModal,
    bindResourceStatsModal,
    reparseResourceCoverage,
    refreshResourceCoverage,
    refreshResourceStats,
    resetResourceStatsPlaceholder,
    setResourceStatsStatus,
    renderResourceStats,
    renderResourceDashboard,
    renderWildTrainingDashboardPanel,
    renderWildStrategyCard,
    renderRareResourceDashboardPanel,
    renderEventOutcomeDashboardPanel,
    renderOutcomeCard,
    outcomeSourceRank,
    renderResourceDiagnostics,
    renderResourceTrustCards,
    resourceStatsScopeLabel,
    renderResourceCoverage,
    renderResourceEventTable,
    renderResourceDeltaTable,
    renderResourceDeltaAggregateTable,
    aggregateResourceRows,
    renderResourceDeltaSubTable,
    sortResourceDeltaRowsForDisplay,
    groupResourceRowsBySource,
    renderResourceStatsSummary,
    renderWildTrainingStatsSummary,
    aggregateWildRareRows,
    aggregateRareResourceRows,
    filterResourceRowsByPeriod,
    wildStrategyFromSourceName,
    isYinNingResource,
    latestResourcePeriod,
    resourceSourceLabel,
    parseResourceStatsSource,
    resourceBasisLabel,
    formatSuccessRate,
    formatResourceAmount,
  };
})();
