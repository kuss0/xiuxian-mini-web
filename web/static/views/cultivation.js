// MINIWEB-VIEW: cultivation status modal and timers
(function () {
  "use strict";

  const { openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  const CULTIVATION_MODULE_SPECS = [
    { key: "deep_retreat", icon: "📿", label: "深度闭关", note: "8h CD",
      fire_skill: "deep_retreat", query_skill: "deep_retreat_query" },
    { key: "yuanying",     icon: "🔮", label: "元婴",     note: "元婴初期+",
      fire_skill: "yuanying", query_skill: "yuanying_status" },
    { key: "second_soul",  icon: "🪞", label: "第二元神", note: "训练 / 抉择",
      fire_skill: "second_soul_train", query_skill: "second_soul_status" },
  ];

  function cultivationState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderCultivationModules(deps = {}) {
    renderCultivationModal(deps);
    deps.renderGameCockpit?.();
  }

  function renderCultivationModulesInto(deps = {}, container) {
    if (!container) return;
    const state = cultivationState(deps);
    const activeId = state.activeIdentityId;
    if (!activeId) {
      container.innerHTML = '<p class="empty">选一个身份后,这里显示模块状态。</p>';
      return;
    }
    const moduleStates = state.identityModuleStates.get(Number(activeId)) || [];
    const byKey = new Map(moduleStates.map((m) => [m.module_key, m]));
    const now = Date.now() / 1000;
    container.innerHTML = CULTIVATION_MODULE_SPECS.map((spec) => {
      const ms = byKey.get(spec.key);
      let timerText = "—";
      let timerCls = "muted";
      if (ms) {
        const summary = ms.summary || {};
        const st = ms.state || {};
        const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
        const ready = summary.ready === true || (nextAt > 0 && nextAt <= now) || nextAt === 0;
        if (ready) {
          timerText = "已就绪";
          timerCls = "ready";
        } else {
          const remaining = nextAt - now;
          timerText = `剩 ${deps.fmtCountdown?.(remaining) || ""}`;
          timerCls = "cooling";
          const startTs = deps.moduleStartTs?.(st) || 0;
          const total = Math.max(1, nextAt - startTs);
          const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
          return cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs);
        }
      }
      return cultivationCardHtml(spec, timerText, timerCls, 0, 0, 0);
    }).join("");
    bindCultivationModuleActions(deps, container);
  }

  function renderCultivationModal(deps = {}) {
    const container = deps.modalRoot?.querySelector("#cultivationModalModules");
    if (!container) return;
    renderCultivationModulesInto(deps, container);
  }

  function openCultivationModal(deps = {}) {
    const state = cultivationState(deps);
    const active = deps.identityById?.(state.activeIdentityId);
    const titleSuffix = active ? `｜${active.label || active.username || active.send_as_id}` : "";
    const dialog = openModal({
      title: `修炼状态${titleSuffix}`,
      body: `
        <section class="modal-section cultivation-menu-modal">
          <div id="cultivationModalModules" class="cultivation-modules">
            <p class="empty">正在载入...</p>
          </div>
        </section>
      `,
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    renderCultivationModal(deps);
  }

  function cultivationCardHtml(spec, timerText, timerCls, pct, nextAt, startTs) {
    const fireDisabled = timerCls === "cooling" ? "disabled" : "";
    return `
      <div class="cult-card ${timerCls}" data-module="${escapeAttr(spec.key)}">
        <div class="cult-card-head">
          <span class="cult-icon">${escapeHtml(spec.icon)}</span>
          <span class="cult-label">${escapeHtml(spec.label)}</span>
          <span class="cult-timer ${escapeAttr(timerCls)}"
                data-cult-timer="1"
                data-next-at="${escapeAttr(nextAt)}"
                data-start-at="${escapeAttr(startTs)}">${escapeHtml(timerText)}</span>
        </div>
        <div class="cult-card-bar"><div class="cult-card-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="cult-card-actions">
          <button type="button" data-cult-fire="${escapeAttr(spec.fire_skill)}" ${fireDisabled}>${escapeHtml(spec.icon)} 出手</button>
          <button type="button" class="secondary" data-cult-query="${escapeAttr(spec.query_skill)}">🔍 查询</button>
        </div>
      </div>
    `;
  }

  function bindCultivationModuleActions(deps = {}, container) {
    container.querySelectorAll("[data-cult-fire]").forEach((btn) => {
      btn.addEventListener("click", () => deps.fillSkillIntoComposer?.(btn.dataset.cultFire, btn));
    });
    container.querySelectorAll("[data-cult-query]").forEach((btn) => {
      btn.addEventListener("click", () => deps.fillSkillIntoComposer?.(btn.dataset.cultQuery, btn));
    });
  }

  function tickCultivationModules(deps = {}) {
    const timers = document.querySelectorAll("[data-cult-timer]");
    if (!timers.length) return;
    const now = Date.now() / 1000;
    let needRerender = false;
    timers.forEach((el) => {
      const nextAt = Number(el.dataset.nextAt || 0);
      if (nextAt === 0) return;
      const remaining = nextAt - now;
      if (remaining <= 0) {
        needRerender = true;
        return;
      }
      el.textContent = `剩 ${deps.fmtCountdown?.(remaining) || ""}`;
      const card = el.closest(".cult-card");
      if (card) {
        const fill = card.querySelector(".cult-card-bar-fill");
        const startTs = Number(el.dataset.startAt || 0);
        const total = Math.max(1, nextAt - startTs);
        const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
        if (fill) fill.style.width = `${pct.toFixed(1)}%`;
      }
    });
    if (needRerender) renderCultivationModules(deps);
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.cultivation = {
    CULTIVATION_MODULE_SPECS,
    renderCultivationModules,
    renderCultivationModulesInto,
    renderCultivationModal,
    openCultivationModal,
    cultivationCardHtml,
    bindCultivationModuleActions,
    tickCultivationModules,
  };
})();
