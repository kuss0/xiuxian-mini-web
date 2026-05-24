// MINIWEB-VIEW: dungeon playbook panels
(function () {
  "use strict";

  const { closeModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  function renderDungeonPlaybookPanels(summaries, guides = {}, deps = {}) {
    const cangkun = latestDungeonByName(summaries, "苍坤");
    const xutian = latestDungeonByName(summaries, "虚天");
    return `
      ${renderDungeonPlaybookCard({
        key: "xutian",
        label: "虚天殿",
        subtitle: "卦象 / 路线 / 后殿",
        summary: xutian,
        statusText: xutian ? dungeonPlaybookStatusText(xutian, deps) : "等待近期虚天线索",
        mainAdvice: xutianPlaybookAdvice(xutian, guides.xutian),
        chips: xutianPlaybookChips(xutian, guides.xutian),
        boundaries: xutianPlaybookBoundaries(xutian, guides.xutian),
        commands: xutianPlaybookCommands(xutian),
        guideLabel: "虚天攻略",
      })}
      ${renderDungeonPlaybookCard({
        key: "cangkun",
        label: "苍坤上人洞府",
        subtitle: "阶段 / 路线 / 113 边界",
        summary: cangkun,
        statusText: cangkun ? dungeonPlaybookStatusText(cangkun, deps) : "等待近期苍坤线索",
        mainAdvice: cangkunPlaybookAdvice(cangkun, guides.cangkun),
        chips: cangkunPlaybookChips(cangkun, guides.cangkun),
        boundaries: [],
        commands: cangkunPlaybookCommands(cangkun, guides.cangkun),
        guideLabel: "苍坤攻略",
      })}
    `;
  }

  function renderDungeonPlaybookCard({ key, label, subtitle, summary, statusText, mainAdvice, chips, boundaries, commands, guideLabel }) {
    const latestId = summary?.latestMessage?.id || "";
    const live = summary && ["open", "joined", "choice", "active"].includes(summary.statusKind);
    return `
      <article class="dungeon-playbook-card ${escapeAttr(key)} ${live ? "live" : ""}" data-dungeon-playbook="${escapeAttr(key)}">
        <div class="dungeon-playbook-head">
          <div>
            <span>${escapeHtml(subtitle || "")}</span>
            <strong>${escapeHtml(label || "副本")}</strong>
          </div>
          <small>${escapeHtml(statusText || "")}</small>
        </div>
        ${mainAdvice ? `
          <p class="dungeon-playbook-advice">
            <strong>${escapeHtml(mainAdvice.title || "")}</strong>
            <span>${escapeHtml(mainAdvice.text || "")}</span>
          </p>
        ` : ""}
        ${chips.length ? `
          <div class="dungeon-playbook-chips">
            ${chips.map(([chipLabel, value]) => `<span><b>${escapeHtml(chipLabel)}</b>${escapeHtml(value)}</span>`).join("")}
          </div>
        ` : ""}
        <div class="dungeon-playbook-actions">
          ${(commands || []).slice(0, 4).map((command) => `<button type="button" data-playbook-command="${escapeAttr(command)}">${escapeHtml(command)}</button>`).join("")}
          <button type="button" data-playbook-guide="${escapeAttr(key)}">${escapeHtml(guideLabel || "攻略")}</button>
          ${latestId ? `<button type="button" data-playbook-jump="${escapeAttr(latestId)}">最新消息</button>` : ""}
        </div>
        ${(boundaries || []).length ? `
          <div class="dungeon-playbook-boundaries">
            ${(boundaries || []).map(([boundaryLabel, value]) => `
              <span><b>${escapeHtml(boundaryLabel)}</b>${escapeHtml(value)}</span>
            `).join("")}
          </div>
        ` : ""}
      </article>
    `;
  }

  function latestDungeonByName(summaries, keyword) {
    const needle = String(keyword || "");
    return (summaries || []).find((item) => String(item.dungeonName || "").includes(needle)) || null;
  }

  function dungeonPlaybookStatusText(summary, deps = {}) {
    const formatChatTime = typeof deps.formatChatTime === "function" ? deps.formatChatTime : (value) => value || "";
    const parts = [
      summary.status || "",
      summary.dungeonId ? `#${summary.dungeonId}` : "",
      formatChatTime(summary.latestMessage?.time) || "",
    ].filter(Boolean);
    return parts.join(" / ");
  }

  function xutianPlaybookAdvice(summary, guide) {
    if (summary?.advice || summary?.adviceBasis) {
      return {
        title: summary.advice || summary.routeVerdict || "看卦象",
        text: summary.adviceBasis || summary.adviceConfidence || "按当前副本消息里的卦象和队伍契合判断。",
      };
    }
    const counts = guide?.counts || {};
    const total = Number(counts.explicit || 0) + Number(counts.success || 0) + Number(counts.failure || 0);
    return {
      title: "先看明示,再看顺例/反例",
      text: total ? `样本库已有 ${formatNumber(total)} 条,优先明示,反例只用于避坑。` : "暂无样本统计,等虚天消息出现后再判断。",
    };
  }

  function cangkunPlaybookAdvice(summary, guide) {
    if (summary?.cangkunAdvice) {
      return {
        title: `${summary.cangkunAdvice.stage || "苍坤"}: ${summary.cangkunAdvice.label || "看原文"}`,
        text: summary.cangkunAdvice.reason || "按当前阶段建议处理。",
      };
    }
    return {
      title: `默认 ${guide?.default_route || "1 -> 1 -> 2"}`,
      text: "主线按 112 收束;113/五幕 3 是明确高风险贪法。",
    };
  }

  function xutianPlaybookChips(summary, guide) {
    return [
      ["卦象", summary?.oracle || "未读"],
      ["阶段", summary?.latestStage || "待定"],
      ["路线", summary?.route || "待定"],
      ["阵策", summary?.strategy || "待定"],
      ["明示", formatNumber(guide?.counts?.explicit || 0)],
      ["反例", formatNumber(guide?.counts?.failure || 0)],
    ].filter(([, value]) => value);
  }

  function xutianPlaybookBoundaries(summary, guide) {
    const rows = [];
    if (!summary) {
      rows.push(["边界", "等待虚天消息后再给阶段/后殿判断。"]);
      return rows;
    }
    const statusText = `${summary.status || ""} ${summary.latestStage || ""} ${summary.latestMessage?.title || ""}`;
    const failureText = (summary.failures || []).join("；");
    if (/后殿冲关止步/.test(`${statusText} ${failureText}`)) {
      rows.push(["后殿止步", "第三关结算已锁定; 失去的是后殿追加机缘,不是全本收益。"]);
    } else if (/后殿/.test(statusText)) {
      rows.push(["后殿边界", "后殿属于追加机缘,先守住前置结算,再看是否继续压鼎。"]);
    }
    for (const failure of (summary.failures || []).slice(0, 2)) {
      rows.push(["近期失败", failure]);
    }
    const negativeExamples = xutianNegativeExamplesForSummary(summary, guide).slice(0, 2);
    for (const example of negativeExamples) {
      rows.push(["避坑反例", example]);
    }
    if (!rows.length) {
      rows.push(["边界", "明示优先; 反例只用于避坑,不反推唯一答案。"]);
    }
    return rows.slice(0, 2);
  }

  function xutianNegativeExamplesForSummary(summary, guide) {
    if ((summary?.negativeExamples || []).length) return summary.negativeExamples;
    const oracle = String(summary?.oracle || "").trim();
    if (!oracle) return [];
    const current = (guide?.cases?.failure || []).find((item) => String(item.gua || "").trim() === oracle);
    if (!current) return [];
    return (current.negative_examples || [])
      .concat((current.examples || []).map((example) => [example.route, example.strategy, example.source].filter(Boolean).join(" / ")))
      .filter(Boolean);
  }

  function cangkunPlaybookChips(summary, guide) {
    const stateRows = summary?.cangkunAdvice?.stateRows || [];
    const state = new Map(stateRows);
    return [
      ["默认线", guide?.default_route || "1 -> 1 -> 2"],
      ["阶段", summary?.latestStage || summary?.cangkunAdvice?.stage || "待定"],
      ["推荐", summary?.cangkunAdvice?.label || "夺图先遁"],
      ["裂隙", state.get("禁制裂隙") || ""],
      ["卷轴", state.get("卷轴线索") || ""],
    ].filter(([, value]) => value);
  }

  function xutianPlaybookCommands(summary) {
    const commands = [];
    for (const route of splitDungeonChoices(summary?.route)) {
      if (route.includes("冰")) commands.push(".选择道路 冰");
      if (route.includes("火")) commands.push(".选择道路 火");
    }
    for (const strategy of splitDungeonChoices(summary?.strategy)) {
      if (strategy.includes("稳")) commands.push(".阵策 稳");
      if (strategy.includes("压")) commands.push(".阵策 压");
      if (strategy.includes("势")) commands.push(".阵策 势");
    }
    return [...new Set(commands)];
  }

  function cangkunPlaybookCommands(summary, guide) {
    const commands = [];
    if (summary?.cangkunAdvice?.command) commands.push(summary.cangkunAdvice.command);
    for (const command of guide?.default_commands || []) commands.push(command);
    return [...new Set(commands)];
  }

  function splitDungeonChoices(value) {
    return String(value || "")
      .split(/[\/／、；,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function bindDungeonPlaybookPanels(root, deps = {}) {
    root.onclick = async (event) => {
      const button = event.target?.closest?.("button");
      if (!button || !root.contains(button)) return;
      if (button.dataset.playbookCommand !== undefined) {
        const command = button.dataset.playbookCommand || "";
        if (!command) return;
        closeModal();
        deps.fillCommand?.(command);
        return;
      }
      if (button.dataset.playbookGuide === "xutian") {
        await deps.openXutianGuide?.();
        return;
      }
      if (button.dataset.playbookGuide === "cangkun") {
        await deps.openCangkunGuide?.();
        return;
      }
      if (button.dataset.playbookJump !== undefined) {
        const id = button.dataset.playbookJump || "";
        if (!id) return;
        const target = await deps.findMessageById?.(id);
        if (target) {
          closeModal();
          deps.jumpToMessage?.(target);
        }
      }
    };
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.dungeonPlaybook = {
    bindDungeonPlaybookPanels,
    renderDungeonPlaybookPanels,
  };
})();
