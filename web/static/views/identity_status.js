// MINIWEB-VIEW: identity status modal and shared module helpers
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml } = window.MiniwebFormat;

  const IDENTITY_STATUS_GROUPS = [
    {
      key: "daily",
      title: "日常",
      hint: "常规循环和会卡行动的长 CD。",
      modules: [
        { key: "wild_training", skill: "wild_training" },
        { key: "checkin", skill: "checkin" },
        { key: "tower", skill: "tower" },
        { key: "deep_retreat", skill: "deep_retreat", query: "deep_retreat_query" },
        { key: "retreat_shallow", skill: "retreat_shallow" },
        { key: "yuanying", skill: "yuanying", query: "yuanying_status" },
        { key: "second_soul", skill: "second_soul_train", query: "second_soul_status" },
        { key: "ranch", skill: "ranch" },
      ],
    },
    {
      key: "artifact",
      title: "器灵",
      hint: "抚摸、温养、试炼三块合并看。",
      modules: [
        { key: "pet_touch", skill: "pet_touch" },
        { key: "pet_warm", skill: "pet_warm" },
        { key: "pet_trial", skill: "pet_trial" },
      ],
    },
    {
      key: "concubine",
      title: "侍妾",
      hint: "入梦、代卜、心劫分开显示，查询走我的侍妾。",
      query: "concubine_status",
      modules: [
        { key: "concubine_dream", skill: "concubine_dream" },
        { key: "concubine_tianji", skill: "concubine_tianji" },
        { key: "concubine_heart", skill: "concubine_heart" },
      ],
    },
    {
      key: "stargazer",
      title: "星宫",
      hint: "观星台三项独立 CD，按宗门解锁快捷按钮。",
      query: "stargazer_panel",
      modules: [
        { key: "stargazer_guide", skill: "stargazer_guide" },
        { key: "stargazer_soothe", skill: "stargazer_soothe" },
        { key: "stargazer_collect", skill: "stargazer_collect" },
      ],
    },
    {
      key: "tianti",
      title: "天阶",
      hint: "登天阶、问心台、九天罡风分开观测。",
      query: "tianti_status",
      modules: [
        { key: "tianti_climb", skill: "tianti_climb" },
        { key: "tianti_wenxin", skill: "tianti_wenxin" },
        { key: "tianti_gangfeng", skill: "tianti_gangfeng" },
      ],
    },
    {
      key: "taiyi",
      title: "太一 / 问道",
      hint: "问道、引道、搜寻节点按真实回复分别观测；太一周期仅保留旧状态兼容。",
      query: "taiyi",
      modules: [
        { key: "wendao", skill: "wendao" },
        { key: "yindao", skill: "yindao" },
        { key: "search_node", skill: "node_search" },
        { key: "taiyi_cycle", label: "太一周期(兼容)", icon: "•" },
      ],
    },
  ];

  function identityStatusState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function openIdentityStatusModal(deps = {}) {
    const state = identityStatusState(deps);
    const active = deps.identityById?.(state.activeIdentityId);
    const titleSuffix = active ? `｜${active.label || active.username || active.send_as_id}` : "";
    const dialog = openModal({
      title: `角色状态${titleSuffix}`,
      body: `
        <section class="modal-section identity-status-modal">
          <div id="identityStatusBody" class="identity-status-body">
            ${renderIdentityStatusBody(deps)}
          </div>
        </section>
      `,
      footer: `
        <button type="button" data-identity-status-action="refresh">刷新状态</button>
        <button type="button" data-modal-close>关闭</button>
      `,
    });
    if (!dialog) return;
    bindIdentityStatusModal(deps, dialog);
  }

  function renderIdentityStatusBody(deps = {}) {
    const state = identityStatusState(deps);
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) {
      return '<p class="empty">先在左侧或顶部选择一个身份。</p>';
    }
    const identity = deps.identityById?.(activeId);
    const patches = deps.activeIdentityPatches?.() || [];
    const patchMap = new Map(patches.map((item) => [item.key, item.value]));
    const stateItems = state.identityModuleStates.get(activeId) || [];
    const byKey = new Map(stateItems.map((item) => [item.module_key, item]));
    const titleParts = [
      patchMap.get("境界"),
      String(patchMap.get("宗门") || "").replace(/^【|】$/g, ""),
      patchMap.get("灵根"),
    ].filter(Boolean);
    const name =
      patchMap.get("角色名") ||
      patchMap.get("道号") ||
      identity?.label ||
      identity?.username ||
      String(activeId);
    const profileChips = [
      ["角色", name],
      ["境界", patchMap.get("境界") || "未读"],
      ["灵根", patchMap.get("灵根") || "未读"],
      ["战力", patchMap.get("综合战力") || "未读"],
      ["修为", patchMap.get("修为") || "未读"],
    ];
    const sourceRows = identityProfileSourceRows(patches);
    return `
      <div class="identity-status-profile">
        <div>
          <strong>${escapeHtml(String(name))}</strong>
          <span>${escapeHtml(titleParts.join("｜") || "等待消息箱补全角色资料")}</span>
        </div>
        <div class="identity-status-profile-grid">
          ${profileChips.map(([label, value]) => deps.cockpitMetric?.(label, value) || "").join("")}
        </div>
        ${renderIdentityProfileSources(deps, sourceRows)}
      </div>
      ${renderIdentityObservationSummary(deps, activeId)}
      <div class="identity-status-groups">
        ${IDENTITY_STATUS_GROUPS.map((group) => renderIdentityStatusGroup(deps, group, byKey)).join("")}
      </div>
    `;
  }

  function identityProfileSourceRows(patches) {
    const wanted = ["角色名", "境界", "宗门", "灵根", "修为", "综合战力"];
    const byKey = new Map((patches || []).map((item) => [item.key, item]));
    return wanted
      .map((key) => byKey.get(key))
      .filter(Boolean)
      .map((item) => ({
        key: item.key,
        value: item.value,
        sourceMessageId: item.source_message_id || "",
        sourceKind: String(item.source_message_id || "").startsWith("tianjige:") ? "tianjige" : "message",
        updatedAt: item.updated_at || "",
      }));
  }

  function renderIdentityProfileSources(deps = {}, rows) {
    if (!rows.length) {
      return '<p class="identity-source-empty">暂无投影来源。发送或监听“我的灵根 / 战力”后会更新。</p>';
    }
    const latest = rows
      .map((row) => row.updatedAt)
      .filter(Boolean)
      .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
    return `
      <details class="identity-source-panel">
        <summary>
          <span>资料来源</span>
          <strong>${escapeHtml(latest ? `最近 ${deps.auditTimeLabel?.(latest) || ""}` : "等待消息箱")}</strong>
        </summary>
        <div class="identity-source-list">
          ${rows.map((row) => `
            <div class="identity-source-row">
              <span>${escapeHtml(row.key)}</span>
              <strong>${escapeHtml(deps.formatFieldValue?.(row.value) || "")}</strong>
              <small>${escapeHtml(deps.auditTimeLabel?.(row.updatedAt) || "未知时间")}</small>
              ${row.sourceKind === "tianjige" ? '<em>API</em>' : row.sourceMessageId ? `
                <button type="button" data-identity-source-jump="${escapeAttr(row.sourceMessageId)}">
                  来源
                </button>
              ` : '<em>无来源</em>'}
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }

  function renderIdentityObservationSummary(deps = {}, activeId) {
    const state = identityStatusState(deps);
    const summary = state.identityStateObservationSummary || {};
    const recentGaps = (summary.recent_gaps || [])
      .filter((item) => {
        const sid = Number(item.send_as_id || 0);
        return sid === 0 || sid === Number(activeId || 0);
      })
      .slice(0, 5);
    const reasonRows = (summary.by_reason || []).slice(0, 4);
    const gapRows = recentGaps.length
      ? recentGaps.map((item) => `
        <button type="button" class="identity-observation-gap" data-identity-source-jump="${escapeAttr(item.source_message_id || "")}" ${item.source_message_id ? "" : "disabled"}>
          <span>${escapeHtml(observationModuleLabel(deps, item.module_key || item.family))}</span>
          <strong>${escapeHtml(observationReasonLabel(item.reason))}</strong>
          <em>${escapeHtml(observationTimeLabel(deps, item.observed_at))}</em>
        </button>
      `).join("")
      : '<span class="identity-observation-empty">最近无状态机缺口</span>';
    return `
      <section class="identity-observation-panel">
        <div class="identity-observation-head">
          <strong>状态机账本</strong>
          <span>${escapeHtml(String(summary.total || 0))} 条最近观测</span>
        </div>
        <div class="identity-observation-reasons">
          ${reasonRows.map((item) => `
            <span>${escapeHtml(observationReasonLabel(item.key))}<em>${escapeHtml(String(item.count || 0))}</em></span>
          `).join("") || '<span>等待监听<em>0</em></span>'}
        </div>
        <div class="identity-observation-gaps">${gapRows}</div>
      </section>
    `;
  }

  function renderIdentityStatusGroup(deps = {}, group, byKey) {
    const querySkill = group.query ? skillByKey(deps, group.query) : null;
    const queryButton = querySkill && deps.skillIsUnlocked?.(querySkill)
      ? `<button type="button" class="identity-status-query" data-status-skill="${escapeAttr(querySkill.key)}">${escapeHtml(querySkill.label || "查询")}</button>`
      : "";
    return `
      <section class="identity-status-group ${escapeAttr(group.key)}">
        <div class="identity-status-group-head">
          <div>
            <strong>${escapeHtml(group.title)}</strong>
            <span>${escapeHtml(group.hint || "")}</span>
          </div>
          ${queryButton}
        </div>
        <div class="identity-status-grid">
          ${group.modules.map((spec) => renderIdentityStatusCard(deps, spec, byKey.get(spec.key))).join("")}
        </div>
      </section>
    `;
  }

  function renderIdentityStatusCard(deps = {}, spec, item) {
    const view = identityModuleView(deps, spec, item);
    const actionButtons = identityStatusActions(deps, spec)
      .map((skill) => {
        const disabled = !deps.skillIsUnlocked?.(skill);
        return `
          <button type="button" data-status-skill="${escapeAttr(skill.key)}" ${disabled ? "disabled" : ""}>
            ${escapeHtml(skill.label || skill.command || "填入")}
          </button>
        `;
      })
      .join("");
    const scheduleButton = `
      <button type="button" data-status-schedule-module="${escapeAttr(spec.key)}">
        定时
      </button>
    `;
    const excerpt = String(item?.state?.last_text_excerpt || "").trim();
    return `
      <article class="identity-status-card ${escapeAttr(view.cls)}" data-status-module="${escapeAttr(spec.key)}">
        <div class="identity-status-card-head">
          <span class="identity-status-icon">${escapeHtml(view.icon)}</span>
          <strong>${escapeHtml(view.label)}</strong>
          <em>${escapeHtml(view.status)}</em>
        </div>
        <div class="identity-status-card-main">
          <span class="identity-status-time" ${view.nextAt ? `data-status-timer="1" data-next-at="${view.nextAt}" data-start-at="${view.startAt}"` : ""}>
            ${escapeHtml(view.time)}
          </span>
          <span class="identity-status-bar"><span style="width:${view.pct.toFixed(1)}%"></span></span>
        </div>
        ${excerpt ? `<p>${escapeHtml(clipGraphemes(excerpt.replace(/\s+/g, " "), 82))}</p>` : '<p class="muted">暂无最近文案。</p>'}
        ${renderIdentityObservationLine(deps, spec, item)}
        <div class="identity-status-actions">${scheduleButton}${actionButtons}</div>
      </article>
    `;
  }

  function renderIdentityObservationLine(deps = {}, spec, item) {
    const observation = item?.observation || null;
    const gap = item?.latest_gap || null;
    if (!observation && !gap) {
      return '<small class="identity-observation-line empty">未见本地文案证据</small>';
    }
    const primary = observation || gap;
    const kind = observation ? "证据" : "缺口";
    const reason = observation ? observation.family || spec.key : observationReasonLabel(gap.reason);
    const time = observationTimeLabel(deps, primary.observed_at);
    const jump = primary.source_message_id
      ? `<button type="button" data-identity-source-jump="${escapeAttr(primary.source_message_id)}">来源</button>`
      : "";
    const gapHint = observation && gap ? `<em>${escapeHtml(observationReasonLabel(gap.reason))}</em>` : "";
    return `
      <small class="identity-observation-line ${observation ? "ok" : "warn"}">
        <span>${escapeHtml(kind)}: ${escapeHtml(reason)}</span>
        <time>${escapeHtml(time)}</time>
        ${gapHint}
        ${jump}
      </small>
    `;
  }

  function observationModuleLabel(deps = {}, moduleKey) {
    const key = String(moduleKey || "");
    const spec = identityStatusFlatSpecs().find((item) => item.key === key);
    if (spec) {
      const skill = skillByKey(deps, spec.skill);
      return skill?.label || spec.label || spec.key;
    }
    return key || "unknown";
  }

  function observationReasonLabel(reason) {
    const key = String(reason || "").trim();
    const labels = {
      state_updated: "已更新",
      reply_context_no_identity: "未绑定身份",
      module_no_match: "模块未命中",
      unhandled_family: "未接状态机",
      sender_not_game_bot: "非游戏 bot",
      observe_exception: "解析异常",
    };
    return labels[key] || key || "未知";
  }

  function observationTimeLabel(deps = {}, value) {
    const numeric = Number(value || 0);
    if (numeric > 0) {
      return deps.auditTimeLabel?.(new Date(numeric * 1000).toISOString()) || "未知时间";
    }
    return deps.auditTimeLabel?.(value) || "未知时间";
  }

  function identityModuleView(deps = {}, spec, item) {
    const skill = spec.skill ? skillByKey(deps, spec.skill) : null;
    const now = Date.now() / 1000;
    const summary = item?.summary || {};
    const st = item?.state || {};
    const label = item?.label || skill?.label || spec.label || spec.key;
    const icon = skill?.icon || spec.icon || "•";
    const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
    const startAt = deps.moduleStartTs?.(st) || 0;
    const lastStatus = String(summary.status || st.last_status || "");
    if (!item) {
      return { label, icon, cls: "unknown", status: "未观测", time: "未知", nextAt: 0, startAt: 0, pct: 0 };
    }
    if (String(summary.phase || st.phase || "") === "running") {
      if (nextAt > now) {
        const remaining = nextAt - now;
        return moduleTimingView(deps, { label, icon, cls: "running", status: "进行中", nextAt, startAt, remaining });
      }
      return { label, icon, cls: "ready", status: "待结算", time: "已到点", nextAt: 0, startAt, pct: 100 };
    }
    if (!nextAt || nextAt <= now || summary.ready === true) {
      const status = lastStatus === "failed" ? "上次失败" : lastStatus === "cooldown" ? "已过 CD" : "已就绪";
      const cls = lastStatus === "failed" ? "warn" : "ready";
      return { label, icon, cls, status, time: summary.text || "已就绪", nextAt: 0, startAt, pct: 100 };
    }
    return moduleTimingView(deps, { label, icon, cls: "cooling", status: lastStatus === "cooldown" ? "冷却中" : "等待中", nextAt, startAt, remaining: nextAt - now });
  }

  function moduleTimingView(deps = {}, { label, icon, cls, status, nextAt, startAt, remaining }) {
    const total = Math.max(1, nextAt - startAt);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    return {
      label,
      icon,
      cls,
      status,
      time: `剩 ${deps.fmtCountdown?.(remaining) || ""}`,
      nextAt,
      startAt,
      pct,
    };
  }

  function identityStatusActions(deps = {}, spec) {
    const keys = [spec.skill, ...(spec.extraSkills || []), spec.query].filter(Boolean);
    const seen = new Set();
    return keys
      .map((key) => skillByKey(deps, key))
      .filter(Boolean)
      .filter((skill) => {
        if (skill.reply_mode === "required" || !String(skill.command || "").trim()) return false;
        if (seen.has(skill.key)) return false;
        seen.add(skill.key);
        return true;
      });
  }

  function skillByKey(deps = {}, skillKey) {
    if (!skillKey) return null;
    return (identityStatusState(deps).skills || []).find((skill) => skill.key === skillKey) || null;
  }

  function bindIdentityStatusModal(deps = {}, dialog) {
    bindIdentityStatusBody(deps, dialog);
    dialog.querySelector('[data-identity-status-action="refresh"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const old = button.textContent;
      button.disabled = true;
      button.textContent = "刷新中...";
      try {
        await Promise.all([
          deps.loadIdentityModuleStates?.(),
          deps.loadIdentityPatches?.({ reset: true }),
        ]);
        const body = dialog.querySelector("#identityStatusBody");
        if (body) body.innerHTML = renderIdentityStatusBody(deps);
        bindIdentityStatusBody(deps, dialog);
        deps.renderGameCockpit?.();
        deps.renderSkillViews?.();
      } catch (error) {
        deps.showSkillToast?.(`刷新失败: ${error.message || error}`, "err");
      } finally {
        button.disabled = false;
        button.textContent = old || "刷新状态";
      }
    });
  }

  function bindIdentityStatusBody(deps = {}, dialog) {
    dialog.querySelectorAll("[data-status-skill]").forEach((button) => {
      button.addEventListener("click", () => deps.fillSkillIntoComposer?.(button.dataset.statusSkill, button));
    });
    dialog.querySelectorAll("[data-status-schedule-module]").forEach((button) => {
      button.addEventListener("click", async () => {
        const moduleKey = String(button.dataset.statusScheduleModule || "").trim();
        const sendAsId = Number(identityStatusState(deps).activeIdentityId || 0);
        if (!moduleKey) return;
        try {
          await Promise.all([
            deps.loadAccounts?.() || Promise.resolve(),
            deps.loadIdentities?.() || Promise.resolve(),
          ]);
          if (typeof deps.openScheduleModuleQuickModal === "function") {
            await deps.openScheduleModuleQuickModal({ sendAsId, moduleKey });
          } else {
            await deps.openScheduleModal?.({ sendAsId, moduleKey, mode: "state" });
          }
        } catch (error) {
          deps.showSkillToast?.(`打开定时失败: ${error.message || error}`, "err");
        }
      });
    });
    dialog.querySelectorAll("[data-identity-source-jump]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.identitySourceJump || "";
        if (!id) return;
        const message = await deps.findOrFetchMessage?.(id);
        if (message) {
          closeModal();
          deps.jumpToMessage?.(message);
        }
      });
    });
  }

  function identityStatusFlatSpecs() {
    return IDENTITY_STATUS_GROUPS.flatMap((group, groupIndex) => (
      group.modules.map((spec, moduleIndex) => ({
        ...spec,
        __groupKey: group.key,
        __groupTitle: group.title,
        __groupQuery: group.query || "",
        __rank: groupIndex * 100 + moduleIndex,
      }))
    ));
  }

  function tickIdentityStatusCards(deps = {}) {
    const timers = document.querySelectorAll('[data-status-timer="1"]');
    if (!timers.length) return;
    const nowSec = Date.now() / 1000;
    let shouldRerender = false;
    timers.forEach((timer) => {
      const nextAt = Number(timer.dataset.nextAt || 0);
      const startAt = Number(timer.dataset.startAt || 0);
      const remaining = nextAt - nowSec;
      if (remaining <= 0) {
        shouldRerender = true;
        return;
      }
      timer.textContent = `剩 ${deps.fmtCountdown?.(remaining) || ""}`;
      const card = timer.closest(".identity-status-card");
      const fill = card?.querySelector(".identity-status-bar span");
      if (fill) {
        const total = Math.max(1, nextAt - startAt);
        const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
        fill.style.width = `${pct.toFixed(1)}%`;
      }
    });
    if (shouldRerender) {
      const body = deps.modalRoot?.querySelector("#identityStatusBody");
      if (body) {
        body.innerHTML = renderIdentityStatusBody(deps);
        bindIdentityStatusBody(deps, deps.modalRoot);
      }
    }
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.identityStatus = {
    IDENTITY_STATUS_GROUPS,
    openIdentityStatusModal,
    renderIdentityStatusBody,
    identityProfileSourceRows,
    renderIdentityProfileSources,
    renderIdentityObservationSummary,
    renderIdentityStatusGroup,
    renderIdentityStatusCard,
    renderIdentityObservationLine,
    observationReasonLabel,
    observationTimeLabel,
    identityModuleView,
    moduleTimingView,
    identityStatusActions,
    skillByKey,
    bindIdentityStatusModal,
    bindIdentityStatusBody,
    identityStatusFlatSpecs,
    tickIdentityStatusCards,
  };
})();
