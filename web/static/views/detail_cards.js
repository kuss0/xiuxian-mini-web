// MINIWEB-VIEW: detail rich cards and field formatting
(function () {
  "use strict";

  const { clipGraphemes, escapeAttr, escapeHtml } = window.MiniwebFormat;

  function detailCardsState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  const cardRenderers = {
    "战力评估": renderBattlePowerCard,
    "角色信息": renderProfileCard,
    "深度闭关总结": renderDeepRetreatSummaryCard,
    "闭关成功": renderRetreatSuccessCard,
    "试炼古塔战报": renderTowerTrialCard,
    "储物袋快照": renderInventoryCard,
    "第二元神归位": renderSecondSoulCard,
    "登天阶面板": renderTiantiPanelCard,
    "观星台面板": renderStargazerPanelCard,
    "星盘显化": renderStargazerResultCard,
    "天机阁快报": renderStargazerResultCard,
    "小世界面板": renderSmallWorldPanelCard,
    "侍妾面板": renderConcubinePanelCard,
    "灵树面板": renderTreePanelCard,
    "灵树采摘": renderTreeHarvestCard,
    "抚摸法宝": renderPetPanelCard,
    "温养器灵": renderPetPanelCard,
    "器灵试炼": renderPetPanelCard,
    "引动大道": renderTaiyiPanelCard,
    "空间节点": renderTaiyiPanelCard,
    "定星成功": renderTaiyiPanelCard,
    "虚天殿开启": renderDungeonCard,
    "风险提醒": renderRiskCard,
  };

  function renderEnhancedBlock(deps = {}, message) {
    const title = String(message.title || "").trim();
    const renderer = cardRenderers[title];
    if (renderer) {
      try {
        return renderer(deps, message);
      } catch (err) {
        console.warn("[card-render]", title, err);
        return renderDetailFields(message.fields);
      }
    }
    if ((message.channels || []).includes("dungeon")) {
      return renderDungeonCard(deps, message);
    }
    if (shouldRenderGenericGameplayCard(message)) {
      return renderGenericGameplayCard(deps, message);
    }
    return renderDetailFields(message.fields);
  }

  function shouldRenderGenericGameplayCard(message) {
    const fields = message.fields || {};
    if (!Object.keys(fields).some((key) => isPresentValue(fields[key]))) return false;
    const channels = message.channels || [message.channel];
    return ["home", "training", "resource", "system", "mine", "risk"].some((channel) => channels.includes(channel));
  }

  function richHero(icon, label, value) {
    return `
      <div class="rich-hero">
        <div class="rich-hero-icon">${icon}</div>
        <div class="rich-hero-text">
          <span class="rich-hero-label">${escapeHtml(label)}</span>
          <strong class="rich-hero-value">${escapeHtml(value)}</strong>
        </div>
      </div>
    `;
  }

  function richChips(pairs) {
    const html = pairs
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `<span class="rich-chip"><span class="rich-chip-k">${escapeHtml(k)}</span>${escapeHtml(String(v))}</span>`)
      .join("");
    return html ? `<div class="rich-chips">${html}</div>` : "";
  }

  function renderBattlePowerCard(deps = {}, message) {
    const f = message.fields || {};
    const power = f["综合战力"] ? formatFieldValue(f["综合战力"]) : "—";
    const realm = f["境界"] ? formatFieldValue(f["境界"]) : "未知";
    return `
      <div class="card-rich card-rich-stat">
        ${richHero("⚔️", "综合战力", power)}
        ${richChips([["境界", realm]])}
      </div>
    `;
  }

  function renderProfileCard(deps = {}, message) {
    const f = message.fields || {};
    const root = f["灵根"] ? formatFieldValue(f["灵根"]) : "—";
    const sect = f["宗门"] ? formatFieldValue(f["宗门"]) : "散修";
    const owner = String(message.source || "").trim() || "本尊";
    return `
      <div class="card-rich card-rich-profile">
        ${richHero("📜", "天命玉牒", owner)}
        ${richChips([["灵根", root], ["宗门", sect]])}
      </div>
    `;
  }

  function richStatGrid(pairs) {
    const cells = pairs
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(
        ([k, v]) => `
          <div class="rich-stat-cell">
            <span class="rich-stat-cell-k">${escapeHtml(k)}</span>
            <span class="rich-stat-cell-v">${escapeHtml(String(v))}</span>
          </div>`
      )
      .join("");
    return cells ? `<div class="rich-stat-grid">${cells}</div>` : "";
  }

  function richCollapsibleList(label, items, maxVisible = 4) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const head = items.slice(0, maxVisible);
    const tail = items.slice(maxVisible);
    const headHtml = head.map((it) => `<li>${escapeHtml(String(it))}</li>`).join("");
    const tailHtml = tail.length
      ? `<ul class="rich-list rich-list-collapsed" hidden>${tail
          .map((it) => `<li>${escapeHtml(String(it))}</li>`)
          .join("")}</ul>
         <button type="button" class="rich-collapse-toggle" data-rich-collapse="1">展开剩余 ${tail.length} 条</button>`
      : "";
    return `
      <div class="rich-progress">
        <div class="rich-progress-head"><span>${escapeHtml(label)}</span></div>
        <ul class="rich-list">${headHtml}</ul>
        ${tailHtml}
      </div>
    `;
  }

  function richProgress(label, current, max, suffix = "") {
    const c = Number(current) || 0;
    const m = Number(max) || 0;
    const pct = m > 0 ? Math.min(100, Math.max(0, (c / m) * 100)) : 0;
    return `
      <div class="rich-progress">
        <div class="rich-progress-head">
          <span>${escapeHtml(label)}</span>
          <span>${escapeHtml(`${c} / ${m}${suffix ? " " + suffix : ""}`)}</span>
        </div>
        <div class="rich-progress-bar"><span class="rich-progress-fill" style="width:${pct.toFixed(1)}%"></span></div>
      </div>
    `;
  }

  function renderDeepRetreatSummaryCard(deps = {}, message) {
    const f = message.fields || {};
    const gain = f["修为变化"] ? formatFieldValue(f["修为变化"]) : "—";
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("📿", "深度闭关 · 修为变化", gain)}
        ${richStatGrid([
          ["结算时长", f["结算时长"] || ""],
          ["神魂吐纳", f["神魂吐纳"] || ""],
          ["修行有成", f["修行有成"] || ""],
          ["心神不宁", f["心神不宁"] || ""],
          ["走火入魔", f["走火入魔"] || ""],
          ["天降奇遇", f["天降奇遇"] || ""],
        ])}
        ${f["状态加持"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">状态加持</span>${escapeHtml(String(f["状态加持"]))}</span></div>` : ""}
        ${richCollapsibleList("奇遇详情", f["奇遇详情"] || [], 4)}
      </div>
    `;
  }

  function renderRetreatSuccessCard(deps = {}, message) {
    const f = message.fields || {};
    const total = f["本次总收益"] ? formatFieldValue(f["本次总收益"]) : "—";
    const realm = f["当前境界"] ? formatFieldValue(f["当前境界"]) : "";
    const cooldown = f["调息冷却"] ? formatFieldValue(f["调息冷却"]) : "";
    const progress = f["修为进度"] && typeof f["修为进度"] === "object" ? f["修为进度"] : null;
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🧘", "本次总收益", total)}
        ${richStatGrid([
          ["基础修为", f["基础修为"] || ""],
          ["灵脉加成", f["灵脉加成"] || ""],
          ["阵法加成", f["阵法加成"] || ""],
          ["当前境界", realm],
          ["调息冷却", cooldown],
        ])}
        ${progress ? richProgress("当前修为", progress.current, progress.max) : ""}
        ${f["奇遇"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">奇遇</span>${escapeHtml(String(f["奇遇"]))}</span></div>` : ""}
      </div>
    `;
  }

  function renderTowerTrialCard(deps = {}, message) {
    const f = message.fields || {};
    const floors = f["闯过层数"] ? formatFieldValue(f["闯过层数"]) : "—";
    const detailFloors = Array.isArray(f["逐层详情"]) ? f["逐层详情"] : [];
    const floorRows = detailFloors
      .map((fl) => {
        const outcome = String(fl.outcome || "");
        const cls = outcome === "败北" ? "out-fail" : outcome === "险胜" ? "out-win" : "out-crush";
        return `<li><span class="tower-floor-num">第 ${escapeHtml(String(fl.floor))} 层</span> <span class="tower-floor-realm">${escapeHtml(String(fl.realm))} / ${escapeHtml(String(fl.kind))}</span> <span class="tower-floor-outcome ${cls}">${escapeHtml(outcome)}</span></li>`;
      })
      .join("");
    return `
      <div class="card-rich card-rich-tower">
        ${richHero("⚔️", "试炼古塔 · 闯过", floors)}
        ${richStatGrid([
          ["修为增长", f["修为增长"] || ""],
          ["塔印", f["塔印"] || ""],
          ["同境界超过", f["同境界超过"] || ""],
        ])}
        ${f["本次构筑"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">构筑</span>${escapeHtml(String(f["本次构筑"]))}</span></div>` : ""}
        ${f["塔相轨迹"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">塔相</span>${escapeHtml(String(f["塔相轨迹"]))}</span></div>` : ""}
        ${f["触发奇遇"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">奇遇</span>${escapeHtml(String(f["触发奇遇"]))}</span></div>` : ""}
        ${f["遭遇词缀"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">词缀</span>${escapeHtml(String(f["遭遇词缀"]))}</span></div>` : ""}
        ${richCollapsibleList("收获", f["收获列表"] || [], 4)}
        ${floorRows ? `<div class="rich-progress"><div class="rich-progress-head"><span>逐层概要</span></div><ul class="tower-floor-list">${floorRows}</ul></div>` : ""}
      </div>
    `;
  }

  function renderInventoryCard(deps = {}, message) {
    const summary = String(message.summary || "已识别背包/资源类消息").trim();
    return `
      <div class="card-rich card-rich-loot">
        ${richHero("📦", "储物袋", "已识别")}
        <p class="muted" style="margin:0;font-size:12px;">${escapeHtml(summary)}</p>
        ${richChips([["类型", "资源快照"]])}
      </div>
    `;
  }

  function renderSecondSoulCard(deps = {}, message) {
    const summary = String(message.summary || "第二元神已结束修炼。").trim();
    return `
      <div class="card-rich card-rich-soul">
        ${richHero("🔮", "第二元神", "归位")}
        <p class="muted" style="margin:0;font-size:12px;">${escapeHtml(summary)}</p>
        ${richChips([["阶段", "回归窍中温养"], ["建议", "去 actions 区抉择 / 修炼"]])}
      </div>
    `;
  }

  function renderTiantiPanelCard(deps = {}, message) {
    const f = message.fields || {};
    const raw = String(message.raw || "");
    const stepProgress =
      f["阶进度数值"] ||
      parseProgressObject(f["阶进度"]) ||
      parseProgressObject(rawMatch(raw, /当前(?:云阶)?进度[:：]\s*(\d+\s*\/\s*\d+)/));
    const gangfeng = f["罡风淬体"] || rawMatch(raw, /罡风淬体[:：]\s*([^\n。]+)/);
    const currentStep = rawMatch(raw, /踏上了第\s*(\d+)\s*阶/) || rawMatch(raw, /第\s*(\d+)\s*阶云阶/);
    const gain = rawMatch(raw, /本次获得\s*([^。\n]+)/);
    const extra = rawLineValue(raw, "额外收获");
    const heroValue = stepProgress ? `${stepProgress.current} / ${stepProgress.max} 阶` : (currentStep ? `第 ${currentStep} 阶` : "凌霄云阶");
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🪜", "登天阶", heroValue)}
        ${richStatGrid([
          ["当前阶数", currentStep ? `第 ${currentStep} 阶` : ""],
          ["周天", f["周天"] || ""],
          ["罡风淬体", gangfeng || ""],
          ["问心", f["问心"] || ""],
          ["登阶冷却", f["登阶冷却"] || ""],
          ["本次获得", gain || ""],
          ["额外收获", extra || ""],
        ])}
        ${stepProgress ? richProgress("云阶进度", stepProgress.current, stepProgress.max, "阶") : ""}
      </div>
    `;
  }

  function renderStargazerPanelCard(deps = {}, message) {
    const f = message.fields || {};
    const slots = Array.isArray(f["引星盘"]) ? f["引星盘"] : [];
    const slotLines = slots.map((slot) => `${slot.idx || "?"} 号：${slot.status || ""}`);
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🔭", "观星台", f["引星盘总数"] ? `${f["引星盘总数"]} 座` : `${slots.length || 0} 座`)}
        ${richStatGrid([
          ["引星盘总数", f["引星盘总数"] || ""],
          ["可用星盘", slots.filter((slot) => /可|空|未/.test(String(slot.status || ""))).length || ""],
        ])}
        ${richCollapsibleList("引星盘状态", slotLines, 6)}
      </div>
    `;
  }

  function renderStargazerResultCard(deps = {}, message) {
    const f = message.fields || {};
    const result = f["演化结果"] || f["下次事件"] || message.summary || "天机演化";
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🌌", message.title || "天机", String(result))}
        ${richStatGrid([
          ["下次事件", f["下次事件"] || ""],
          ["天命所归", f["天命所归"] || ""],
          ["演化结果", f["演化结果"] || ""],
        ])}
        ${richChips([["来源", displaySource(deps, message.source)]])}
      </div>
    `;
  }

  function renderSmallWorldPanelCard(deps = {}, message) {
    const f = message.fields || {};
    const faith = parseProgressObject(f["信仰"]);
    const prayer = f["凡人祈愿"] || rawLineValue(message.raw, "凡人祈愿");
    const wait = f["下次祈愿"] || rawMatch(message.raw, /下一次祈愿感应需等待[:：]\s*([^)）\n]+)/);
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🌍", "小世界", f["主人"] ? `${f["主人"]}` : "凡间状态")}
        ${richStatGrid([
          ["待收香火", f["待收香火"] || ""],
          ["香火库存", f["香火库存"] || ""],
          ["凡人祈愿", prayer || ""],
          ["下次祈愿", wait || ""],
        ])}
        ${faith ? richProgress("信仰", faith.current, faith.max) : ""}
        ${richChips([["原则", "祈愿优先，香火只是刷新工具"]])}
      </div>
    `;
  }

  function renderConcubinePanelCard(deps = {}, message) {
    const f = message.fields || {};
    const fragments = parseProgressObject(f["拼片"]);
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🌙", f["类型"] || "侍妾", f["侍妾"] || "未识别")}
        ${richStatGrid([
          ["状态", f["状态"] || ""],
          ["情缘值", f["情缘值"] || ""],
          ["当前誓约", f["当前誓约"] || ""],
          ["入梦寻图", f["入梦寻图冷却"] || ""],
          ["共历心劫", f["共历心劫冷却"] || ""],
          ["天机代卜", f["天机代卜冷却"] || ""],
        ])}
        ${fragments ? richProgress("虚天残图拼片", fragments.current, fragments.max) : ""}
      </div>
    `;
  }

  function renderTreePanelCard(deps = {}, message) {
    const raw = String(message.raw || "");
    const progress = parseProgressObject(rawMatch(raw, /进度[:：][\s\S]*?(\d+(?:\.\d+)?)%/), 100);
    const trend = rawLineValue(raw, "倾向");
    const current = rawLineValue(raw, "你的当前状态");
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🌲", "灵眼之树", rawLineValue(raw, "阶段") || "落云宗灵树")}
        ${richStatGrid([
          ["环境", rawLineValue(raw, "环境") || ""],
          ["阶段", rawLineValue(raw, "阶段") || ""],
          ["倾向", trend || ""],
          ["灵纹", rawLineValue(raw, "灵纹") || ""],
          ["本轮走向", rawLineValue(raw, "本轮走向") || ""],
          ["我的状态", current || ""],
        ])}
        ${progress ? richProgress("成熟进度", progress.current, progress.max, "%") : ""}
        ${rawLineValue(raw, "若此刻成熟") ? richChips([["成熟收益", rawLineValue(raw, "若此刻成熟")]]) : ""}
      </div>
    `;
  }

  function renderTreeHarvestCard(deps = {}, message) {
    const f = message.fields || {};
    return `
      <div class="card-rich card-rich-loot">
        ${richHero("🌰", "灵树采摘", f["采摘果实"] || "已采摘")}
        ${richStatGrid([
          ["果实", f["采摘果实"] || ""],
          ["修为增长", f["修为增长"] || ""],
        ])}
      </div>
    `;
  }

  function renderPetPanelCard(deps = {}, message) {
    const f = message.fields || {};
    const raw = String(message.raw || "");
    const resonance = rawLineValue(raw, "当前共鸣");
    const bonus = rawLineValue(raw, "当前总加成");
    const cost = rawLineValue(raw, "- 消耗") || rawLineValue(raw, "消耗");
    return `
      <div class="card-rich card-rich-loot">
        ${richHero("🗡️", message.title || "器灵", message.summary || "已记录")}
        ${richStatGrid([
          ["默契", f["默契"] != null ? `+${f["默契"]}` : rawLineValue(raw, "- 默契提升")],
          ["经验", f["经验"] != null ? `+${f["经验"]}` : rawLineValue(raw, "- 经验提升")],
          ["当前共鸣", resonance || ""],
          ["总加成", bonus || ""],
          ["消耗", cost || ""],
        ])}
        ${richChips([["类型", (message.tags || []).join(" / ")]])}
      </div>
    `;
  }

  function renderTaiyiPanelCard(deps = {}, message) {
    const f = message.fields || {};
    const value = f["节点"] || f["五行"] || message.summary || "太一记录";
    return `
      <div class="card-rich card-rich-summary">
        ${richHero("🧭", message.title || "太一", String(value))}
        ${richStatGrid([
          ["五行", f["五行"] || ""],
          ["空间节点", f["节点"] || ""],
        ])}
        ${richChips([["状态", message.summary || ""], ["提醒", "只展示，不自动发搜寻 / 定星"]])}
      </div>
    `;
  }

  function rawMatch(raw, regex) {
    const m = regex.exec(String(raw || ""));
    return m ? String(m[1] || "").trim() : "";
  }

  function rawLineValue(raw, label) {
    const escaped = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]+)`).exec(String(raw || ""));
    return m ? m[1].trim() : "";
  }

  function parseProgressObject(value, implicitMax = 0) {
    if (!value) return null;
    if (typeof value === "object" && Number(value.current) >= 0 && Number(value.max) > 0) {
      return { current: Number(value.current), max: Number(value.max) };
    }
    const text = String(value);
    const pair = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
    if (pair) {
      return { current: Number(pair[1]), max: Number(pair[2]) };
    }
    const single = /(\d+(?:\.\d+)?)/.exec(text);
    if (single && implicitMax > 0) {
      return { current: Number(single[1]), max: Number(implicitMax) };
    }
    return null;
  }

  function renderDungeonCard(deps = {}, message) {
    const f = message.fields || {};
    const tags = message.tags || [];
    const title = String(message.title || "副本消息").trim();
    const dungeonName = String(f["副本名"] || "").trim()
      || (/加入副本|副本房间/.test(title) ? "副本" : title.replace(/(开启|推进)$/, ""))
      || "副本";
    const dungeonId = f["副本ID"] ? String(f["副本ID"]).trim() : "—";
    const stage = f["阶段"] ? String(f["阶段"]).trim() : "";
    const status = String(f["状态"] || "").trim()
      || (tags.includes("失败") ? "加入失败" : tags.includes("解散") ? "已解散" : tags.includes("可加入") ? "可加入" : tags.includes("加入") ? "已加入" : "副本消息");
    const heroValue = dungeonId !== "—" ? `#${dungeonId}` : (stage || status);
    const paths = Array.isArray(f["可选路径"]) ? f["可选路径"] : [];
    const successExamples = Array.isArray(f["历史顺例"]) ? f["历史顺例"] : [];
    const failureExamples = Array.isArray(f["历史反例"]) ? f["历史反例"] : [];
    const summary = String(message.summary || "").trim();
    return `
      <div class="card-rich card-rich-dungeon">
        ${richHero("🛡️", `${dungeonName} · ${status}`, heroValue)}
        ${summary ? `<p class="muted" style="margin:0;font-size:12px;">${escapeHtml(summary)}</p>` : ""}
        ${richStatGrid([
          ["副本ID", dungeonId !== "—" ? dungeonId : ""],
          ["阶段", stage],
          ["卦象", f["卦象"] || ""],
          ["行运建议", f["行运建议"] || ""],
          ["路策判定", f["路策判定"] || ""],
          ["开门人", f["开门人"] || ""],
          ["人数上限", f["人数上限"] || ""],
          ["失败原因", f["失败原因"] || ""],
        ])}
        ${richChips([
          ["依据", f["建议依据"] || ""],
          ["置信", f["建议置信"] || ""],
          ["队伍契合", f["队伍契合"] || ""],
          ["路线", f["路线"] || ""],
          ["阵策", f["阵策"] || ""],
          ["静场令", f["静场令"] || ""],
          ["消耗道具", f["消耗道具"] || ""],
          ["操作", (message.actions || []).length ? "下方按钮手动发送" : ""],
        ])}
        ${richCollapsibleList("可选路径", paths, 3)}
        ${richCollapsibleList("历史顺例", successExamples, 3)}
        ${richCollapsibleList("历史反例", failureExamples, 3)}
      </div>
    `;
  }

  function renderRiskCard(deps = {}, message) {
    const summary = String(message.summary || "检测到高危消息,需要玩家手动处理。").trim();
    const f = message.fields || {};
    const handling = f["处理方式"] ? formatFieldValue(f["处理方式"]) : "人工查看原文";
    return `
      <div class="card-rich card-rich-risk">
        ${richHero("⚠️", "风险提醒", "需人工介入")}
        <p style="margin:0;font-size:12.5px;color:#fecaca;">${escapeHtml(summary)}</p>
        ${richChips([["处理方式", handling]])}
      </div>
    `;
  }

  function renderGenericGameplayCard(deps = {}, message) {
    const f = message.fields || {};
    const title = String(message.title || "修仙事件").trim();
    const icon = genericGameplayIcon(message);
    const heroValue = String(
      f["状态"] ||
      f["阶段"] ||
      f["结果"] ||
      f["当前境界"] ||
      f["副本名"] ||
      f["玩法"] ||
      clipGraphemes(String(message.summary || "").replace(/\s+/g, " ").trim(), 24) ||
      "已记录"
    );
    const entries = Object.entries(f).filter(([, value]) => isPresentValue(value));
    const primary = entries.slice(0, 10);
    const rest = entries.slice(10).map(([key, value]) => `${key}: ${formatFieldValue(value)}`);
    const chips = [
      ["来源", displaySource(deps, message.source)],
      ["频道", genericGameplayChannelLabel(deps, message)],
      ["动作", (message.actions || []).length ? `${message.actions.length} 个候选` : ""],
    ];
    const summary = String(message.summary || "").trim();
    return `
      <div class="card-rich card-rich-generic ${escapeAttr(genericGameplayClass(message))}">
        ${richHero(icon, title, heroValue)}
        ${summary ? `<p class="rich-card-summary">${escapeHtml(summary)}</p>` : ""}
        ${richStatGrid(primary.map(([key, value]) => [key, formatFieldValue(value)]))}
        ${richChips(chips)}
        ${richCollapsibleList("更多字段", rest, 4)}
      </div>
    `;
  }

  function genericGameplayIcon(message) {
    const title = String(message.title || "");
    const channels = message.channels || [message.channel];
    if (/灵树|小世界|侍妾|器灵|法宝|灵兽|观星|星盘|定星|空间节点/.test(title) || channels.includes("home")) return "🏡";
    if (/闭关|元婴|元神|修炼|闯塔|登天阶|悟道/.test(title) || channels.includes("training")) return "🧘";
    if (/储物袋|资源|交易|货摊|战利品|野外/.test(title) || channels.includes("resource")) return "📦";
    if (channels.includes("risk")) return "⚠️";
    return "✨";
  }

  function genericGameplayClass(message) {
    const title = String(message.title || "");
    const channels = message.channels || [message.channel];
    if (/灵树|小世界|侍妾|器灵|法宝|灵兽|观星|星盘|定星|空间节点/.test(title) || channels.includes("home")) return "home";
    if (/闭关|元婴|元神|修炼|闯塔|登天阶|悟道/.test(title) || channels.includes("training")) return "training";
    if (/储物袋|资源|交易|货摊|战利品|野外/.test(title) || channels.includes("resource")) return "resource";
    if (channels.includes("risk")) return "risk";
    return "system";
  }

  function genericGameplayChannelLabel(deps = {}, message) {
    const state = detailCardsState(deps);
    const channels = message.channels || [message.channel];
    const known = new Map((state.channels || []).map((channel) => [channel.key, channel.label]));
    return channels.map((channel) => known.get(channel) || channel).slice(0, 3).join(" / ");
  }

  function displaySource(deps = {}, source) {
    return deps.displaySource?.(source) || String(source || "未知发送者");
  }

  function renderDetailFields(fields) {
    const entries = Object.entries(fields || {}).filter(([, value]) => isPresentValue(value));
    if (entries.length === 0) {
      return '<p class="empty inline">解析器没有从这条消息中识别出结构化字段,可以直接看 Telegram 原文。</p>';
    }
    const items = entries
      .map(
        ([key, value]) => `
          <div>
            <span>${escapeHtml(key)}</span>
            <strong>${escapeHtml(formatFieldValue(value))}</strong>
          </div>
        `
      )
      .join("");
    return `<div class="field-grid">${items}</div>`;
  }

  function isPresentValue(value) {
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "string" && value.trim() === "") {
      return false;
    }
    if (Array.isArray(value) && value.length === 0) {
      return false;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).length > 0;
    }
    return true;
  }

  function formatFieldValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => formatFieldValue(item)).join("、");
    }
    if (value && typeof value === "object") {
      return Object.entries(value)
        .filter(([, v]) => isPresentValue(v))
        .map(([k, v]) => `${k}：${formatFieldValue(v)}`)
        .join("，");
    }
    return String(value);
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.detailCards = {
    renderEnhancedBlock,
    renderDetailFields,
    isPresentValue,
    formatFieldValue,
    rawMatch,
    rawLineValue,
    parseProgressObject,
  };
})();
