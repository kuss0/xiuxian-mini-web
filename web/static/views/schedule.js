// MINIWEB-VIEW: official schedule rail and modal
(function () {
  "use strict";

  const { fetchJson, postJson } = window.MiniwebApi;
  const { openModal } = window.MiniwebModal;
  const {
    DISPLAY_TIME_ZONE = "Asia/Shanghai",
    clipGraphemes,
    escapeAttr,
    escapeHtml,
  } = window.MiniwebFormat;
  const SCHEDULE_BOOTSTRAP_URL = "/api/schedule/bootstrap?include=presets,modules,templates";
  const SCHEDULE_TIME_ZONE_LABEL = DISPLAY_TIME_ZONE === "Asia/Shanghai" ? "上海时间" : DISPLAY_TIME_ZONE;
  const SCHEDULE_SHANGHAI_OFFSET_MINUTES = 8 * 60;
  const SCHEDULE_RENEW_ALLOWED_PRESETS = {
    deep_retreat: "deep_retreat",
    wild_training: "wild_training",
    checkin: "checkin",
    tower: "tower",
    daily_check_core: "checkin",
    daily_essentials: "checkin",
    ranch: "ranch",
    concubine_dream: "concubine_dream",
    concubine_tianji: "concubine_tianji",
    tianti_wenxin: "tianti_wenxin",
    tianti_gangfeng: "tianti_gangfeng",
    lingxiao_standard: "tianti_climb",
    lingxiao_elder: "tianti_climb",
    second_soul: "second_soul",
    taiyi_cycle: "taiyi_cycle",
    wendao: "wendao",
    yindao: "yindao",
  };
  const SCHEDULE_RAIL_GROUP_META = {
    daily: { label: "日常", order: 1 },
    sect: { label: "宗门", order: 2 },
    concubine: { label: "侍妾", order: 3 },
  };
  const SCHEDULE_RAIL_CONCUBINE_KEYS = new Set([
    "concubine_dream",
    "concubine_tianji",
    "concubine_heart",
  ]);
  const SCHEDULE_RAIL_SECT_KEYS = new Set([
    "ranch",
    "stargazer_guide",
    "stargazer_soothe",
    "stargazer_collect",
    "stargazer_care",
    "stargazer_bamboo_thunder",
    "tianti_climb",
    "tianti_climb_elder",
    "tianti_wenxin",
    "tianti_gangfeng",
    "lingxiao_standard",
    "lingxiao_elder",
    "second_soul",
    "taiyi_cycle",
    "taiyi_patrol",
    "wendao",
    "yindao",
    "search_node",
  ]);
  const SCHEDULE_HIDDEN_SHORTCUT_PRESETS = new Set([
    "tianti_climb_elder",
  ]);
  const SCHEDULE_PRESET_CATEGORY_META = {
    daily: { label: "常用", order: 1 },
    package: { label: "联动包", order: 2 },
    sect: { label: "宗门", order: 3 },
    concubine: { label: "侍妾", order: 4 },
    fabao: { label: "法宝", order: 5 },
    phase: { label: "阶段型", order: 6 },
    custom: { label: "自定义", order: 7 },
  };
  const SCHEDULE_AUTOMATION_LABELS = {
    renewable: { label: "可续", tone: "ok" },
    semiauto: { label: "可半自动", tone: "ok" },
    one_click: { label: "可排", tone: "ok" },
    manual_followup: { label: "需接力", tone: "warn" },
    state_only: { label: "仅观测", tone: "" },
    manual: { label: "手动", tone: "" },
  };
  const SCHEDULE_PINNED_PRESETS = [
    "daily_essentials",
    "daily_check_core",
    "wild_training",
    "deep_retreat",
    "retreat_shallow",
    "concubine_tianji",
    "concubine_cycle",
    "concubine_dream",
    "lingxiao_elder",
    "lingxiao_standard",
    "stargazer_bamboo_thunder",
    "stargazer_care",
    "taiyi_patrol",
    "ranch",
    "second_soul",
  ];
  const SCHEDULE_CUSTOM_EXAMPLES = [
    {
      key: "daily_pair",
      label: "点卯 + 闯塔",
      command: ".宗门点卯\n.闯塔",
      interval_sec: 86400,
      count: 3,
      command_gap_sec: 180,
    },
    {
      key: "concubine_pair",
      label: "入梦 + 天机",
      command: ".入梦寻图\n.天机代卜",
      interval_sec: 43200,
      count: 4,
      command_gap_sec: 240,
    },
    {
      key: "manual_chain",
      label: "临时多指令",
      command: ".宗门点卯\n.闯塔\n.野外历练 谨慎",
      interval_sec: 86400,
      count: 2,
      command_gap_sec: 180,
    },
  ];

  function scheduleTimeZonePill() {
    return `<span class="status-pill schedule-timezone-pill">${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}</span>`;
  }

  function parseScheduleShanghaiLocalTimestamp(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const utcMs = wallMs - SCHEDULE_SHANGHAI_OFFSET_MINUTES * 60 * 1000;
    const check = new Date(utcMs + SCHEDULE_SHANGHAI_OFFSET_MINUTES * 60 * 1000);
    if (
      check.getUTCFullYear() !== year
      || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day
      || check.getUTCHours() !== hour
      || check.getUTCMinutes() !== minute
      || check.getUTCSeconds() !== second
    ) {
      return null;
    }
    return Math.floor(utcMs / 1000);
  }

  function scheduleState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function scheduleRailElement(deps = {}) {
    return deps.scheduleRail || document.querySelector("#scheduleRail");
  }

  function scheduleRailIsWorkbench(deps = {}) {
    return Boolean(scheduleRailElement(deps)?.closest(".schedule-workbench"));
  }

  function scheduleSelectedSendAsIds(deps = {}) {
    const state = scheduleState(deps);
    const identities = state.identities || [];
    const known = new Set(identities.map((item) => Number(item.send_as_id || 0)).filter(Boolean));
    return (state.scheduleSelectedSendAsIds || [])
      .map((id) => Number(id || 0))
      .filter((id) => id && known.has(id));
  }

  function setScheduleSelectedSendAsIds(deps = {}, ids = []) {
    const state = scheduleState(deps);
    state.scheduleSelectedSendAsIds = (ids || []).map((id) => Number(id || 0)).filter(Boolean);
    renderScheduleIdentityDock(deps);
    renderScheduleRail(deps);
  }

  async function loadScheduleRail(deps = {}, { silent = false } = {}) {
    const state = scheduleState(deps);
    const scheduleRail = scheduleRailElement(deps);
    if (!scheduleRail) return [];
    if (!silent) {
      state.scheduleLoading = true;
      state.scheduleError = "";
      renderScheduleRail(deps);
    }
    try {
      const payload = await fetchJson("/api/schedule?summary=1&history=0");
      const batches = syncScheduleBatches(deps, payload, { fullPreview: false });
      loadScheduleRenewSummary(deps, { silent: true }).catch((error) => {
        console.warn("[mini-web] schedule renew rail status:", error);
      });
      return batches;
    } catch (error) {
      state.scheduleError = error.message || String(error);
      if (!silent || !(state.scheduleBatches || []).length) {
        renderScheduleRail(deps);
      }
      throw error;
    } finally {
      state.scheduleLoading = false;
      if (!silent) renderScheduleRail(deps);
    }
  }

  function syncScheduleBatches(deps = {}, payload, options = {}) {
    const state = scheduleState(deps);
    const batches = Array.isArray(payload?.batches) ? payload.batches : [];
    state.scheduleBatches = batches;
    state.scheduleError = "";
    state.scheduleLoading = false;
    if (Object.prototype.hasOwnProperty.call(options || {}, "fullPreview")) {
      state.scheduleRailFullPreviewLoaded = Boolean(options.fullPreview);
    }
    if ((options || {}).render !== false) {
      renderScheduleIdentityDock(deps);
      renderScheduleRail(deps);
    }
    return batches;
  }

  async function loadScheduleRenewSummary(deps = {}, { silent = false } = {}) {
    const state = scheduleState(deps);
    if (!silent) {
      state.scheduleRenewLoading = true;
      state.scheduleRenewError = "";
      renderScheduleRail(deps);
    }
    try {
      const payload = await fetchJson("/api/schedule/renew");
      return syncScheduleRenewProfiles(deps, payload);
    } catch (error) {
      state.scheduleRenewError = error.message || String(error);
      renderScheduleRail(deps);
      throw error;
    } finally {
      state.scheduleRenewLoading = false;
      if (!silent) renderScheduleRail(deps);
    }
  }

  function syncScheduleRenewProfiles(deps = {}, payload = {}) {
    const state = scheduleState(deps);
    if (payload?.ok === false) {
      state.scheduleRenewError = payload.error || "续期状态读取失败";
    } else {
      state.scheduleRenewProfiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
      state.scheduleRenewAllowedPresets = Array.isArray(payload?.allowed_presets) ? payload.allowed_presets : [];
      state.scheduleRenewWorker = payload?.worker || null;
      state.scheduleRenewError = "";
    }
    state.scheduleRenewLoading = false;
    renderScheduleRail(deps);
    return state.scheduleRenewProfiles || [];
  }

  function renderScheduleRail(deps = {}) {
    const state = scheduleState(deps);
    const scheduleRail = scheduleRailElement(deps);
    if (!scheduleRail) return;
    const batches = state.scheduleBatches || [];
    if (state.scheduleLoading && !batches.length) {
      scheduleRail.innerHTML = '<p class="empty inline">正在读取官方定时...</p>';
      return;
    }
    if (state.scheduleError && !batches.length) {
      scheduleRail.innerHTML = `
        <div class="schedule-rail-empty warn">
          <strong>定时读取失败</strong>
          <span>${escapeHtml(state.scheduleError)}</span>
        </div>
      `;
      return;
    }
    if (!batches.length) {
      scheduleRail.innerHTML = `
        <div class="schedule-rail-empty">
          <strong>还没有排班</strong>
          <span>点“新建”把深闭、法宝、日常命令排进 Telegram 官方定时。</span>
        </div>
      `;
      return;
    }
    const scopedBatches = scheduleRailScopedBatches(deps, batches);
    const railBatches = scheduleVisibleRailBatches(deps, batches);
    if (!railBatches.length) {
      const selectedIds = scheduleRailSelectedSendAsIds(deps);
      const previewCount = scopedBatches.filter(scheduleBatchIsDryRun).length;
      const hiddenText = previewCount
        ? `本地预演 ${previewCount} 批已收起。`
        : selectedIds.length
          ? "当前身份没有进行中的排班。"
          : "过期历史已收起。";
      scheduleRail.innerHTML = `
        <div class="schedule-rail-empty">
          <strong>没有进行中的排班</strong>
          <span>${escapeHtml(hiddenText)}</span>
        </div>
        <button type="button" class="schedule-rail-more" data-schedule-open>管理排班</button>
      `;
      bindScheduleOpenButtons(deps, scheduleRail);
      return;
    }
    const totals = railBatches.reduce((acc, batch) => {
      const counts = scheduleCurrentCounts(batch.counts || {});
      acc.planned += Number(counts.planned || 0);
      acc.scheduled += Number(counts.scheduled || 0);
      acc.failed += Number(counts.failed || 0);
      acc.sending += batch.status === "sending" ? 1 : 0;
      return acc;
    }, { planned: 0, scheduled: 0, failed: 0, sending: 0 });
    const visibleLimit = scheduleRailIsWorkbench(deps) ? 12 : 4;
    const visible = railBatches.slice(0, visibleLimit);
    const showManageButton = scheduleRailIsWorkbench(deps) || railBatches.length > visible.length || scopedBatches.length > railBatches.length;
    const renewSummary = renderScheduleRailRenewSummary(deps);
    scheduleRail.innerHTML = `
      <div class="schedule-rail-summary schedule-tool-summary">
        <div class="schedule-tool-summary-title">
          <strong>官方定时</strong>
          <span>${totals.sending ? `${escapeHtml(String(totals.sending))} 批发送中` : "TG 排班工作台"}</span>
        </div>
        <div class="schedule-tool-metrics">
          <span><b>${escapeHtml(String(railBatches.length))}</b><small>分组</small></span>
          <span><b>${escapeHtml(String(totals.scheduled))}</b><small>已排</small></span>
          <span><b>${escapeHtml(String(totals.planned))}</b><small>待排</small></span>
          <span class="${totals.failed ? "warn" : ""}"><b>${escapeHtml(String(totals.failed))}</b><small>失败</small></span>
        </div>
        <div class="schedule-tool-renew-line">${renewSummary}</div>
      </div>
      <div class="schedule-rail-list">
        ${visible.map((batch) => renderScheduleRailRow(deps, batch)).join("")}
      </div>
      ${showManageButton ? `<button type="button" class="schedule-rail-more" data-schedule-open>管理排班</button>` : ""}
    `;
    bindScheduleOpenButtons(deps, scheduleRail);
  }

  function scheduleRailSelectedSendAsIds(deps = {}) {
    const explicit = scheduleSelectedSendAsIds(deps);
    if (explicit.length) return explicit;
    const state = scheduleState(deps);
    const active = Number(state.activeIdentityId || 0);
    const known = new Set((state.identities || []).map((item) => Number(item.send_as_id || 0)).filter(Boolean));
    if (active && known.has(active)) return [active];
    return [];
  }

  function scheduleRailScopedBatches(deps = {}, batches = []) {
    const selected = scheduleRailSelectedSendAsIds(deps);
    if (!selected.length) return batches || [];
    const selectedSet = new Set(selected);
    return (batches || []).filter((batch) => selectedSet.has(Number(batch?.send_as_id || 0)));
  }

  function scheduleVisibleRailBatches(deps = {}, batches = []) {
    return aggregateScheduleRailBatches(scheduleRailScopedBatches(deps, batches).filter(scheduleBatchHasCurrentWork));
  }

  function scheduleRailRenewSummaryData(deps = {}) {
    const state = scheduleState(deps);
    const selectedIds = scheduleRailSelectedSendAsIds(deps);
    const selectedSet = new Set(selectedIds);
    const profiles = (state.scheduleRenewProfiles || []).filter((profile) => {
      if (!selectedSet.size) return true;
      return selectedSet.has(Number(profile.send_as_id || 0));
    });
    const allowedPresets = Array.isArray(state.scheduleRenewAllowedPresets)
      ? state.scheduleRenewAllowedPresets
      : [];
    const targetIds = selectedIds.length
      ? selectedIds
      : Array.from(new Set(profiles.map((profile) => Number(profile.send_as_id || 0)).filter(Boolean)));
    const configured = new Set(profiles.map((profile) => scheduleRenewProfileKey(profile.send_as_id, profile.preset_key)));
    let addable = 0;
    if (targetIds.length && allowedPresets.length) {
      targetIds.forEach((sendAsId) => {
        allowedPresets.forEach((row) => {
          const presetKey = String(row?.preset_key || "").trim();
          if (presetKey && !configured.has(scheduleRenewProfileKey(sendAsId, presetKey))) addable += 1;
        });
      });
    }
    const enabled = profiles.filter((profile) => profile.enabled !== false);
    const automatic = enabled.filter((profile) => scheduleRenewProfileReady(profile) && !String(profile.last_error || "").trim());
    const waiting = enabled.filter((profile) => !scheduleRenewProfileReady(profile) || String(profile.last_error || "").trim());
    const disabled = profiles.filter((profile) => profile.enabled === false);
    return {
      loading: Boolean(state.scheduleRenewLoading),
      error: String(state.scheduleRenewError || ""),
      automatic: automatic.length,
      waiting: waiting.length,
      disabled: disabled.length,
      configured: profiles.length,
      addable,
    };
  }

  function renderScheduleRailRenewSummary(deps = {}) {
    const summary = scheduleRailRenewSummaryData(deps);
    if (summary.loading && !summary.configured) {
      return '<div class="schedule-rail-renew-summary"><span><b>续约</b><small>读取中</small></span></div>';
    }
    if (summary.error) {
      return `<div class="schedule-rail-renew-summary"><span class="warn"><b>续约</b><small>${escapeHtml(summary.error)}</small></span></div>`;
    }
    if (!summary.configured && !summary.addable) {
      return '<div class="schedule-rail-renew-summary"><span><b>续约</b><small>未配置</small></span></div>';
    }
    return `
      <div class="schedule-rail-renew-summary" aria-label="续约覆盖摘要">
        <span class="ok"><b>${escapeHtml(String(summary.automatic))}</b><small>自动中</small></span>
        <span class="${summary.waiting ? "warn" : ""}"><b>${escapeHtml(String(summary.waiting))}</b><small>待处理</small></span>
        <span><b>${escapeHtml(String(summary.disabled))}</b><small>停用</small></span>
        <span class="${summary.addable ? "accent" : ""}"><b>${escapeHtml(String(summary.addable))}</b><small>可新增</small></span>
      </div>
    `;
  }

  function bindScheduleOpenButtons(deps = {}, root) {
    root.querySelectorAll("[data-schedule-open]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          Promise.allSettled([
            deps.loadAccounts?.() || Promise.resolve(),
            deps.loadIdentities?.() || Promise.resolve(),
          ]).catch(() => {});
          await openScheduleModal(deps);
        } catch (error) {
          deps.showError?.(error);
        }
      });
    });
    root.querySelectorAll("[data-schedule-preview-toggle]").forEach((button) => {
      const openPreview = async () => {
        const key = String(button.dataset.schedulePreviewKey || "");
        if (!key) return;
        await openScheduleRailPreviewModal(deps, key);
      };
      button.addEventListener("click", (event) => {
        event.preventDefault();
        openPreview().catch((error) => {
          scheduleState(deps).scheduleRailPreviewError = error.message || String(error);
          deps.showError?.(error);
        });
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openPreview().catch((error) => {
          scheduleState(deps).scheduleRailPreviewError = error.message || String(error);
          deps.showError?.(error);
        });
      });
    });
    root.querySelectorAll("[data-schedule-renew-toggle]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const profileIds = String(button.dataset.profileIds || button.dataset.profileId || "")
          .split(",")
          .map((id) => Number(id || 0))
          .filter(Boolean);
        const profiles = profileIds.map((id) => scheduleRenewProfileById(deps, id)).filter(Boolean);
        if (!profiles.length) return;
        button.disabled = true;
        const nextEnabled = !profiles.some((profile) => profile.enabled !== false);
        try {
          let result = null;
          for (const profile of profiles) {
            result = await postJson("/api/schedule/renew/save", scheduleRenewTogglePayload(profile, nextEnabled));
            if (!result.ok) throw new Error(result.error || "切换续约失败");
          }
          if (result) syncScheduleRenewProfiles(deps, result);
        } catch (error) {
          const state = scheduleState(deps);
          state.scheduleRenewError = error.message || String(error);
          deps.showError?.(error);
          renderScheduleRail(deps);
        }
      });
    });
    root.querySelectorAll("[data-schedule-renew-config]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await openScheduleModal(deps);
        } catch (error) {
          deps.showError?.(error);
        }
      });
    });
  }

  async function ensureScheduleRailFullPreview(deps = {}, key = "", options = {}) {
    const state = scheduleState(deps);
    const renderRail = options.renderRail !== false;
    state.scheduleRailPreviewLoadingKey = key;
    state.scheduleRailPreviewError = "";
    if (renderRail) renderScheduleRail(deps);
    try {
      const payload = await fetchJson("/api/schedule?history=0");
      syncScheduleBatches(deps, payload, { fullPreview: true, render: renderRail });
    } catch (error) {
      state.scheduleRailPreviewError = error.message || String(error);
      throw error;
    } finally {
      if (state.scheduleRailPreviewLoadingKey === key) {
        state.scheduleRailPreviewLoadingKey = "";
      }
      if (renderRail) renderScheduleRail(deps);
    }
  }

  function scheduleRailBatchByPreviewKey(deps = {}, key = "") {
    const state = scheduleState(deps);
    return scheduleVisibleRailBatches(deps, state.scheduleBatches || [])
      .find((batch) => scheduleRailPreviewKey(batch) === key) || null;
  }

  async function openScheduleRailPreviewModal(deps = {}, key = "") {
    let batch = scheduleRailBatchByPreviewKey(deps, key);
    if (!batch) throw new Error("找不到这组排班");
    const identity = scheduleIdentityLabel(deps, batch.send_as_id);
    const title = `${identity}｜${batch.label || "计划预览"}`;
    const needsFull = scheduleRailNeedsFullPreview(batch) && !scheduleState(deps).scheduleRailFullPreviewLoaded;
    const dialog = openModal({
      title,
      body: renderScheduleRailPreview(deps, batch, { hiddenTotal: Number(batch.hidden_item_count || 0), modal: true, loading: needsFull }),
      footer: '<button type="button" data-modal-close>关闭</button>',
    });
    if (!dialog) return null;
    dialog.classList.add("schedule-preview-dialog");
    dialog.dataset.schedulePreviewKey = key;
    if (!needsFull) return dialog;
    try {
      await ensureScheduleRailFullPreview(deps, key, { renderRail: false });
      batch = scheduleRailBatchByPreviewKey(deps, key) || batch;
      if (dialog.isConnected && dialog.dataset.schedulePreviewKey === key) {
        const body = dialog.querySelector(".modal-body");
        if (body) {
          body.innerHTML = renderScheduleRailPreview(deps, batch, { hiddenTotal: Number(batch.hidden_item_count || 0), modal: true });
        }
      }
    } catch (error) {
      if (dialog.isConnected && dialog.dataset.schedulePreviewKey === key) {
        const body = dialog.querySelector(".modal-body");
        if (body) {
          body.innerHTML = renderScheduleRailPreview(deps, batch, {
            hiddenTotal: Number(batch.hidden_item_count || 0),
            modal: true,
            error: error.message || String(error),
          });
        }
      }
    }
    return dialog;
  }

  function aggregateScheduleRailBatches(batches = []) {
    const groups = new Map();
    for (const batch of batches || []) {
      if (!batch) continue;
      const key = scheduleRailGroupKey(batch);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, scheduleRailGroupFromBatch(batch));
      } else {
        mergeScheduleRailGroup(existing, batch);
      }
    }
    return Array.from(groups.values()).sort(compareScheduleRailGroups);
  }

  function scheduleRailGroupKey(batch) {
    const identityId = Number(batch?.send_as_id || 0) || 0;
    return `${identityId}:${scheduleRailGroupCategoryKey(batch)}`;
  }

  function scheduleRailGroupModuleKey(batch) {
    const moduleKeys = Array.isArray(batch?.__groupModuleKeys) ? batch.__groupModuleKeys.filter(Boolean) : [];
    if (moduleKeys.length) return moduleKeys[0];
    const presetKey = String(batch?.preset_key || "").trim();
    const contractModule = String(batch?.options?.state_contract?.module_key || "").trim();
    const autoModule = String(batch?.options?.auto_anchor_module || "").trim();
    return SCHEDULE_RENEW_ALLOWED_PRESETS[presetKey] || contractModule || autoModule || presetKey || "custom";
  }

  function scheduleRailGroupCategoryKey(batch) {
    const existing = String(batch?.__groupCategoryKey || "").trim();
    if (existing) return existing;
    const presetKey = String(batch?.preset_key || "").trim();
    const moduleKey = scheduleRailGroupModuleKey(batch);
    const keys = new Set([presetKey, moduleKey].filter(Boolean));
    if ([...keys].some((key) => key.startsWith("concubine_") || SCHEDULE_RAIL_CONCUBINE_KEYS.has(key))) {
      return "concubine";
    }
    if ([...keys].some((key) => SCHEDULE_RAIL_SECT_KEYS.has(key) || key.startsWith("tianti_") || key.startsWith("lingxiao_") || key.startsWith("stargazer_") || key.startsWith("taiyi_"))) {
      return "sect";
    }
    return "daily";
  }

  function scheduleRailGroupCategoryLabel(categoryKey) {
    return SCHEDULE_RAIL_GROUP_META[categoryKey]?.label || "日常";
  }

  function mergeUniqueValues(left = [], right = []) {
    return Array.from(new Set([...(left || []), ...(right || [])].map((value) => String(value || "").trim()).filter(Boolean)));
  }

  function scheduleRailGroupFromBatch(batch) {
    const clone = { ...batch };
    const categoryKey = scheduleRailGroupCategoryKey(batch);
    const moduleKey = scheduleRailGroupModuleKey(batch);
    const presetKey = String(batch.preset_key || "").trim();
    clone.items = [...(batch.items || [])];
    clone.counts = scheduleCurrentCounts(batch.counts || {});
    clone.hidden_item_count = Number(batch.hidden_item_count || 0);
    clone.__grouped = true;
    clone.__batchCount = 1;
    clone.__batchIds = [batch.id].filter((id) => id !== undefined && id !== null);
    clone.__groupCategoryKey = categoryKey;
    clone.__groupModuleKey = moduleKey;
    clone.__groupModuleKeys = moduleKey ? [moduleKey] : [];
    clone.__groupPresetKeys = presetKey ? [presetKey] : [];
    clone.__renewProfileIds = scheduleBatchRenewProfileIds(batch);
    clone.label = scheduleRailGroupCategoryLabel(categoryKey);
    clone.__latestUpdatedAt = Number(batch.updated_at || batch.created_at || 0) || 0;
    clone.__earliestAnchorAt = Number(batch.anchor_at || 0) || 0;
    return clone;
  }

  function mergeScheduleRailGroup(group, batch) {
    group.__batchCount = Number(group.__batchCount || 1) + 1;
    if (batch.id !== undefined && batch.id !== null) {
      group.__batchIds = [...(group.__batchIds || []), batch.id];
    }
    group.__renewProfileIds = Array.from(new Set([...(group.__renewProfileIds || []), ...scheduleBatchRenewProfileIds(batch)]));
    group.__groupModuleKeys = mergeUniqueValues(group.__groupModuleKeys, [scheduleRailGroupModuleKey(batch)]);
    group.__groupPresetKeys = mergeUniqueValues(group.__groupPresetKeys, [batch.preset_key]);
    group.__groupModuleKey = group.__groupModuleKeys[0] || group.__groupModuleKey || "";
    group.label = scheduleRailGroupCategoryLabel(group.__groupCategoryKey || scheduleRailGroupCategoryKey(group));
    const current = scheduleCurrentCounts(group.counts || {});
    const incoming = scheduleCurrentCounts(batch.counts || {});
    group.counts = {
      planned: current.planned + incoming.planned,
      scheduled: current.scheduled + incoming.scheduled,
      failed: current.failed + incoming.failed,
      expired: 0,
      deleted: current.deleted + incoming.deleted,
    };
    group.hidden_item_count = Number(group.hidden_item_count || 0) + Number(batch.hidden_item_count || 0);
    group.items = [...(group.items || []), ...(batch.items || [])].sort(compareScheduleMessages);
    group.status = scheduleRailMergedStatus(group.status, batch.status, group.counts);
    const batchAnchor = Number(batch.anchor_at || 0) || 0;
    const groupAnchor = Number(group.__earliestAnchorAt || 0) || 0;
    if (batchAnchor && (!groupAnchor || batchAnchor < groupAnchor)) {
      group.__earliestAnchorAt = batchAnchor;
      group.anchor_at = batch.anchor_at;
      group.anchor_text = batch.anchor_text || group.anchor_text;
    }
    const batchUpdated = Number(batch.updated_at || batch.created_at || 0) || 0;
    if (batchUpdated > Number(group.__latestUpdatedAt || 0)) {
      group.__latestUpdatedAt = batchUpdated;
      group.label = scheduleRailGroupLabel(group, batch);
      group.preset_key = batch.preset_key || group.preset_key;
      group.options = { ...(group.options || {}), ...(batch.options || {}) };
    }
  }

  function scheduleRailGroupLabel(group, batch) {
    const categoryKey = String(group?.__groupCategoryKey || "").trim();
    if (categoryKey) return scheduleRailGroupCategoryLabel(categoryKey);
    const currentLabel = String(group?.label || "").trim();
    const nextLabel = String(batch?.label || "").trim();
    if (!currentLabel) return nextLabel;
    if (!nextLabel || nextLabel === currentLabel) return currentLabel;
    const currentModule = scheduleRailGroupModuleKey(group);
    const nextModule = scheduleRailGroupModuleKey(batch);
    if (currentModule && currentModule === nextModule) return currentLabel;
    return nextLabel;
  }

  function scheduleRailMergedStatus(left, right, counts = {}) {
    if (left === "sending" || right === "sending") return "sending";
    if (Number(counts.failed || 0) > 0) return "failed";
    if (Number(counts.planned || 0) > 0) return "active";
    return left || right || "active";
  }

  function compareScheduleMessages(a, b) {
    return (Number(a?.schedule_at || 0) || 0) - (Number(b?.schedule_at || 0) || 0);
  }

  function compareScheduleRailGroups(a, b) {
    const aFailed = Number(a?.counts?.failed || 0) > 0 ? 1 : 0;
    const bFailed = Number(b?.counts?.failed || 0) > 0 ? 1 : 0;
    if (aFailed !== bFailed) return bFailed - aFailed;
    const aSending = a?.status === "sending" ? 1 : 0;
    const bSending = b?.status === "sending" ? 1 : 0;
    if (aSending !== bSending) return bSending - aSending;
    const aGroup = SCHEDULE_RAIL_GROUP_META[scheduleRailGroupCategoryKey(a)]?.order || 99;
    const bGroup = SCHEDULE_RAIL_GROUP_META[scheduleRailGroupCategoryKey(b)]?.order || 99;
    if (aGroup !== bGroup) return aGroup - bGroup;
    return (Number(a?.__earliestAnchorAt || a?.anchor_at || 0) || 0) - (Number(b?.__earliestAnchorAt || b?.anchor_at || 0) || 0);
  }

  function scheduleBatchRenewProfileIds(batch) {
    const id = Number(batch?.options?.renew_profile_id || 0);
    return id ? [id] : [];
  }

  function scheduleRailPreviewKey(batch) {
    return scheduleRailGroupKey(batch);
  }

  function scheduleRailNeedsFullPreview(batch) {
    return Number(batch?.hidden_item_count || 0) > 0;
  }

  function scheduleRenewProfileById(deps = {}, profileId) {
    const id = Number(profileId || 0);
    if (!id) return null;
    return (scheduleState(deps).scheduleRenewProfiles || []).find((profile) => Number(profile.id || 0) === id) || null;
  }

  function scheduleRailRenewProfile(deps = {}, batch) {
    return scheduleRailRenewProfiles(deps, batch)[0] || null;
  }

  function scheduleRenewProfileReady(profile) {
    if (Object.prototype.hasOwnProperty.call(profile || {}, "renew_ready")) {
      return Boolean(profile?.renew_ready);
    }
    return Boolean(profile?.state_contract?.semiauto_ready);
  }

  function scheduleRenewEvidenceFreshSeconds(row = {}, contract = null) {
    const interval = Number(row?.interval_sec || contract?.suggestion?.interval_sec || 0);
    if (String(row?.module_key || contract?.module_key || "") === "deep_retreat") {
      return Math.max(3600, Math.min(48 * 3600, Math.max(interval, interval * 2)));
    }
    return Math.max(6 * 3600, Math.min(72 * 3600, Math.max(interval, interval * 2)));
  }

  function scheduleContractRenewReady(row = {}, contract = null) {
    if (!contract) return false;
    const updatedAt = Number(contract.updated_at || 0);
    const sourceMessageId = String(contract.source_message_id || "");
    const age = Date.now() / 1000 - updatedAt;
    const freshSec = scheduleRenewEvidenceFreshSeconds(row, contract);
    if (!updatedAt || age > freshSec) return false;
    if (!sourceMessageId || sourceMessageId.startsWith("tianjige:")) return false;
    if (!Number(contract.next_at || 0)) return false;
    if ((contract.warnings || []).some((warning) => warning?.severity === "risk")) return false;
    if (String(row?.module_key || contract.module_key || "") === "deep_retreat") return true;
    return Boolean(contract.semiauto_ready);
  }

  function scheduleRenewEvidenceText(contract = null) {
    if (!contract) return "未观测";
    const evidence = contract.evidence || {};
    const moduleContract = contract.module_contract || {};
    const family = evidence.latest_family || (moduleContract.reply_families || [])[0] || "";
    const readiness = moduleContract.readiness || "";
    const sourceKind = String(contract.source_message_id || "").startsWith("tianjige:") ? "API" : "文本";
    const parts = [];
    if (family) parts.push(`family ${family}`);
    if (readiness) parts.push(readiness);
    parts.push(sourceKind);
    if (evidence.latest_reason && evidence.latest_reason !== "state_updated") parts.push(evidence.latest_reason);
    return parts.join("｜");
  }

  function scheduleRailRenewProfiles(deps = {}, batch) {
    const state = scheduleState(deps);
    const profiles = state.scheduleRenewProfiles || [];
    if (!profiles.length || !batch) return [];
    const sendAsId = Number(batch.send_as_id || 0);
    const moduleKeys = new Set((batch.__groupModuleKeys || [scheduleRailGroupModuleKey(batch)]).map((key) => String(key || "").trim()).filter(Boolean));
    const presetKeys = new Set((batch.__groupPresetKeys || [batch.preset_key]).map((key) => String(key || "").trim()).filter(Boolean));
    const profileIds = new Set((batch.__renewProfileIds || []).map((id) => Number(id || 0)).filter(Boolean));
    const matched = profiles.filter((profile) => {
      if (Number(profile.send_as_id || 0) !== sendAsId) return false;
      const id = Number(profile.id || 0);
      const profileModule = String(profile.module_key || "").trim();
      const profilePreset = String(profile.preset_key || "").trim();
      return (
        (id && profileIds.has(id)) ||
        (profileModule && moduleKeys.has(profileModule)) ||
        (profilePreset && presetKeys.has(profilePreset))
      );
    });
    return matched.sort((a, b) => {
      const aEnabled = a.enabled !== false ? 1 : 0;
      const bEnabled = b.enabled !== false ? 1 : 0;
      if (aEnabled !== bEnabled) return bEnabled - aEnabled;
      return String(a.label || a.preset_key || "").localeCompare(String(b.label || b.preset_key || ""), "zh-Hans-CN");
    });
  }

  function scheduleRailRenewAllowed(batch) {
    const moduleKeys = new Set((batch?.__groupModuleKeys || [scheduleRailGroupModuleKey(batch)]).map((key) => String(key || "").trim()).filter(Boolean));
    const presetKeys = new Set((batch?.__groupPresetKeys || [batch?.preset_key]).map((key) => String(key || "").trim()).filter(Boolean));
    if ([...presetKeys].some((presetKey) => scheduleRenewModuleForPreset(presetKey))) return true;
    return [...moduleKeys].some((moduleKey) => Object.values(SCHEDULE_RENEW_ALLOWED_PRESETS).includes(moduleKey));
  }

  function scheduleRailRenewInfo(deps = {}, batch) {
    const state = scheduleState(deps);
    const profiles = scheduleRailRenewProfiles(deps, batch);
    const profile = profiles[0] || null;
    const allowed = scheduleRailRenewAllowed(batch);
    if (!profile) {
      if (state.scheduleRenewLoading) {
        return { profile: null, allowed, label: "读取中", tone: "", note: "续约状态" };
      }
      if (state.scheduleRenewError) {
        return { profile: null, allowed, label: "读取失败", tone: "warn", note: state.scheduleRenewError };
      }
      return {
        profile: null,
        allowed,
        label: allowed ? "未配置" : "手动",
        tone: allowed ? "" : "muted",
        note: allowed ? "可配续约" : "不自动",
      };
    }
    if (profiles.length > 1) {
      const total = profiles.length;
      const enabledCount = profiles.filter((item) => item.enabled !== false).length;
      const errorCount = profiles.filter((item) => String(item.last_error || "").trim()).length;
      const waitingCount = profiles.filter((item) => item.enabled !== false && !String(item.last_error || "").trim() && item.state_contract && !scheduleRenewProfileReady(item)).length;
      const coverage = profiles
        .map((item) => item.covered_until_text || item.tail_text || "")
        .filter(Boolean)
        .sort()[0] || "";
      if (errorCount) {
        return { profile, profiles, allowed: true, label: `异常 ${errorCount}`, tone: "warn", note: coverage || `${enabledCount}/${total} 自动` };
      }
      if (waitingCount) {
        return { profile, profiles, allowed: true, label: `待观察 ${waitingCount}`, tone: "warn", note: coverage || `${enabledCount}/${total} 自动` };
      }
      if (!enabledCount) {
        return { profile, profiles, allowed: true, label: "全停用", tone: "", note: coverage || `${total} 个策略` };
      }
      return {
        profile,
        profiles,
        allowed: true,
        label: enabledCount === total ? `自动 ${total}` : `自动 ${enabledCount}/${total}`,
        tone: "ok",
        note: coverage || `${enabledCount}/${total} 自动`,
      };
    }
    const enabled = profile.enabled !== false;
    const ready = scheduleRenewProfileReady(profile);
    const error = String(profile.last_error || "").trim();
    const coverage = profile.covered_until_text || profile.tail_text || "";
    if (error) return { profile, profiles, allowed: true, label: "异常", tone: "warn", note: error };
    if (!enabled) return { profile, profiles, allowed: true, label: "已停用", tone: "", note: coverage || "续约关闭" };
    if (!ready && profile.state_contract) return { profile, profiles, allowed: true, label: "待观察", tone: "warn", note: profile.renew_block_reason || coverage || "状态机未就绪" };
    return { profile, profiles, allowed: true, label: "自动中", tone: "ok", note: coverage || `续 ${profile.renew_days || 1} 天` };
  }

  function scheduleRenewTogglePayload(profile, enabled) {
    const presetKey = String(profile?.preset_key || "").trim();
    const moduleKey = String(profile?.module_key || scheduleRenewModuleForPreset(presetKey) || "").trim();
    return {
      id: Number(profile?.id || 0),
      send_as_id: Number(profile?.send_as_id || 0),
      account_local_id: profile?.account_local_id || "",
      preset_key: presetKey,
      module_key: moduleKey,
      label: profile?.label || presetKey,
      enabled: Boolean(enabled),
      renew_days: profile?.renew_days || 1,
      threshold_hours: profile?.threshold_hours || 24,
      soft_limit: profile?.soft_limit || 95,
      payload: profile?.payload || {
        send_as_id: Number(profile?.send_as_id || 0),
        preset_key: presetKey,
        horizon_days: profile?.renew_days || 1,
        auto_anchor: true,
        auto_anchor_module: moduleKey,
        schedule_use_module_defaults: presetKey === moduleKey,
        schedule_semiauto: true,
        dry_run: false,
      },
    };
  }

  function renderScheduleRailRenewControl(deps = {}, info = {}) {
    if (info.profile) {
      const profiles = (info.profiles || [info.profile]).filter(Boolean);
      const enabled = profiles.some((profile) => profile.enabled !== false);
      const title = enabled ? "关闭本组自动续约" : "开启本组自动续约";
      const profileIds = profiles.map((profile) => Number(profile.id || 0)).filter(Boolean).join(",");
      return `
        <span class="schedule-rail-renew-control ${escapeAttr(info.tone || "")}">
          <button type="button" class="schedule-renew-switch ${enabled ? "is-on" : ""}" data-schedule-renew-toggle data-profile-ids="${escapeAttr(profileIds)}" aria-pressed="${enabled ? "true" : "false"}" title="${escapeAttr(title)}">
            <span aria-hidden="true"></span>
            <strong>续约</strong>
          </button>
          <small title="${escapeAttr(info.note || "")}">${escapeHtml(info.label || "")}</small>
        </span>
      `;
    }
    if (info.allowed) {
      return `
        <span class="schedule-rail-renew-control">
          <button type="button" class="schedule-renew-config" data-schedule-renew-config title="配置自动续约">续约</button>
          <small title="${escapeAttr(info.note || "")}">${escapeHtml(info.label || "未配置")}</small>
        </span>
      `;
    }
    return `
      <span class="schedule-rail-renew-control muted">
        <small title="${escapeAttr(info.note || "")}">${escapeHtml(info.label || "手动")}</small>
      </span>
    `;
  }

  function renderScheduleRailPreview(deps = {}, batch, options = {}) {
    const state = scheduleState(deps);
    const key = scheduleRailPreviewKey(batch);
    const loading = Boolean(options.loading) || state.scheduleRailPreviewLoadingKey === key;
    const error = String(options.error || state.scheduleRailPreviewError || "");
    const items = (batch.items || []).filter(scheduleMessageHasCurrentWork).sort(compareScheduleMessages);
    const hiddenTotal = Number(options.hiddenTotal || 0);
    const visibleLimit = scheduleRailIsWorkbench(deps) ? 80 : 32;
    const visible = items.slice(0, visibleLimit);
    const clipped = Math.max(0, items.length - visible.length);
    const rows = visible.map((item) => {
      const view = scheduleMessageStatusView(item);
      return `
        <li>
          <code>${escapeHtml(item.command || "")}</code>
          <small>${escapeHtml(item.schedule_text || "")}</small>
          ${view.pill}
          ${item.scheduled_msg_id ? `<small>TG #${escapeHtml(String(item.scheduled_msg_id))}</small>` : ""}
          ${view.note ? `<small class="${escapeAttr(view.noteClass)}">${escapeHtml(view.note)}</small>` : ""}
        </li>
      `;
    }).join("");
    const summary = loading
      ? "正在读取完整计划"
      : `${items.length} 条未来计划${clipped ? `｜再收起 ${clipped} 条` : ""}`;
    const hiddenHint = hiddenTotal && !state.scheduleRailFullPreviewLoaded
      ? `<small class="muted">还有 ${escapeHtml(String(hiddenTotal))} 条正在补全。</small>`
      : "";
    return `
      <div class="schedule-rail-preview" data-schedule-preview-panel="${escapeAttr(key)}">
        <div class="schedule-rail-preview-head">
          <strong>计划预览</strong>
          <small>${escapeHtml(summary)}</small>
        </div>
        ${error ? `<p class="modal-status-line warn">${escapeHtml(error)}</p>` : ""}
        ${hiddenHint}
        <ul class="schedule-item-list">${rows || '<li><small>没有待展示命令</small></li>'}</ul>
      </div>
    `;
  }

  function renderScheduleRailRow(deps = {}, batch) {
    const state = scheduleState(deps);
    const counts = scheduleCurrentCounts(batch.counts || {});
    const total = (counts.planned || 0) + (counts.scheduled || 0) + (counts.failed || 0) + (counts.expired || 0);
    const done = (counts.scheduled || 0) + (counts.expired || 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const statusKey = scheduleDisplayStatusKey(batch.status || "active", counts);
    const statusPill = scheduleStatusPill(statusKey) || `<span class="status-pill">${statusKey === "active" ? "活动" : escapeHtml(statusKey)}</span>`;
    const identity = scheduleIdentityLabel(deps, batch.send_as_id);
    const currentItems = (batch.items || []).filter(scheduleMessageHasCurrentWork);
    const hiddenItemCount = Number(batch.hidden_item_count || 0);
    const isWorkbench = scheduleRailIsWorkbench(deps);
    const snippetLimit = isWorkbench ? 2 : 2;
    const hiddenTotal = Number(hiddenItemCount || 0) + Math.max(0, currentItems.length - snippetLimit);
    const snippets = currentItems.slice(0, snippetLimit).map((item) => `
      <span>
        <code>${escapeHtml(item.command || "")}</code>
        <small>${escapeHtml(item.schedule_text || "")}</small>
      </span>
    `).join("");
    const groupedText = Number(batch.__batchCount || 0) > 1
      ? `<small>合并 ${escapeHtml(String(batch.__batchCount))} 批</small>`
      : "";
    const previewKey = scheduleRailPreviewKey(batch);
    const needsFull = scheduleRailNeedsFullPreview(batch) && !state.scheduleRailFullPreviewLoaded;
    const renewInfo = scheduleRailRenewInfo(deps, batch);
    const renewControl = renderScheduleRailRenewControl(deps, renewInfo);
    return `
      <article class="schedule-rail-row ${escapeAttr(scheduleRailStatusClass(statusKey, counts))}">
        <div class="schedule-rail-row-main" role="button" tabindex="0" data-schedule-preview-toggle data-schedule-preview-key="${escapeAttr(previewKey)}" data-schedule-needs-full="${needsFull ? "1" : "0"}" title="打开计划预览">
          <span class="schedule-rail-row-title">
            <strong>${escapeHtml(batch.label || batch.preset_key || `排班 #${batch.id}`)}</strong>
            ${statusPill}
          </span>
          <span class="schedule-rail-row-meta schedule-tool-meta">
            <small>${escapeHtml(identity)}</small>
            <small>${escapeHtml(batch.anchor_text || "未设锚点")}</small>
            <small>${escapeHtml(scheduleStatusText(statusKey, counts))}</small>
            ${groupedText}
          </span>
          ${total ? `<span class="schedule-progress compact"><span class="schedule-progress-bar" style="width:${pct}%"></span></span>` : ""}
          <span class="schedule-rail-snippets">
            ${snippets || "<small>没有待展示命令</small>"}
            ${hiddenTotal ? `<small>+${escapeHtml(String(hiddenTotal))} 条</small>` : ""}
          </span>
          <span class="schedule-rail-row-controls">
            ${renewControl}
            <small class="schedule-rail-preview-hint">${isWorkbench ? "预览" : "查看计划"}</small>
          </span>
        </div>
      </article>
    `;
  }

  function scheduleRailStatusClass(statusKey, counts) {
    statusKey = scheduleDisplayStatusKey(statusKey, counts);
    if (statusKey === "failed") return "risk";
    if (statusKey === "needs_retry" || statusKey === "partial_failed" || Number(counts?.failed || 0) > 0) return "warn";
    if (statusKey === "sending") return "live";
    if (statusKey === "completed") return "done";
    if (statusKey === "dry_run") return "muted";
    if (statusKey === "expired") return "muted";
    if (statusKey === "cancelled") return "muted";
    return "active";
  }

  function scheduleIdentityLabel(deps = {}, sendAsId) {
    const id = Number(sendAsId || 0);
    const identities = scheduleState(deps).identities || [];
    const identity = identities.find((item) => Number(item.send_as_id || 0) === id);
    const name = identity ? (identity.label || identity.username || identity.send_as_id) : id;
    return name ? `send_as ${name}` : "未绑定身份";
  }

  function scheduleIdentityById(deps = {}, sendAsId) {
    const id = Number(sendAsId || 0);
    return (scheduleState(deps).identities || []).find((item) => Number(item.send_as_id || 0) === id) || null;
  }

  function scheduleAccountByLocalId(deps = {}, localId) {
    const key = String(localId || "");
    return (scheduleState(deps).accounts || []).find((item) => String(item.local_id || "") === key) || null;
  }

  function scheduleAccountLabel(account, fallback = "") {
    return account?.label || account?.username || account?.phone || fallback || "未绑定账号";
  }

  function scheduleIdentityOptionLabel(deps = {}, identity) {
    if (!identity) return "未选身份";
    if (typeof deps.identityOptionLabel === "function") {
      return deps.identityOptionLabel(identity);
    }
    const account = scheduleAccountByLocalId(deps, identity.account_local_id);
    const name = identity.label || identity.username || identity.send_as_id || "未命名身份";
    const accountLabel = scheduleAccountLabel(account, identity.account_local_id);
    return `${name}｜账号 ${accountLabel}`;
  }

  function defaultScheduleSendAsIds(deps = {}) {
    const state = scheduleState(deps);
    const identities = state.identities || [];
    const known = new Set(identities.map((item) => Number(item.send_as_id || 0)).filter(Boolean));
    const saved = scheduleSelectedSendAsIds(deps);
    if (saved.length) return saved;
    const active = Number(state.activeIdentityId || 0);
    if (active && known.has(active)) {
      return [active];
    }
    const fallback =
      identities.find((item) => item.enabled !== false && scheduleAccountByLocalId(deps, item.account_local_id)) ||
      identities.find((item) => item.enabled !== false) ||
      identities[0];
    const id = Number(fallback?.send_as_id || 0);
    return id ? [id] : [];
  }

  function renderScheduleIdentityDock(deps = {}) {
    const select = deps.scheduleIdentityQuickSelect || document.querySelector("#scheduleIdentityQuickSelect");
    const followButton = deps.scheduleIdentityFollowChatButton || document.querySelector("#scheduleIdentityFollowChatButton");
    const meta = deps.scheduleIdentityQuickMeta || document.querySelector("#scheduleIdentityQuickMeta");
    if (!select) return;
    const state = scheduleState(deps);
    const identities = state.identities || [];
    const selected = defaultScheduleSendAsIds(deps);
    const selectedId = Number(selected[0] || 0);
    if (!identities.length) {
      select.innerHTML = '<option value="">无身份</option>';
      select.disabled = true;
      if (followButton) followButton.disabled = true;
      if (meta) meta.textContent = "先登录账号";
      return;
    }
    select.disabled = false;
    select.innerHTML = identities.map((identity) => {
      const id = Number(identity.send_as_id || 0);
      return `<option value="${escapeAttr(String(id))}" ${id === selectedId ? "selected" : ""}>${escapeHtml(scheduleIdentityOptionLabel(deps, identity))}</option>`;
    }).join("");
    select.value = String(selectedId || "");
    if (followButton) followButton.disabled = !Number(state.activeIdentityId || 0);
    const identity = scheduleIdentityById(deps, selectedId);
    const metaText = identity
      ? `定时默认: ${identity.label || identity.username || identity.send_as_id}`
      : "定时默认身份";
    select.title = metaText;
    if (followButton) followButton.title = "使用聊天当前身份作为定时默认";
    if (meta) {
      meta.textContent = metaText;
    }
    if (select.dataset.scheduleDockBound !== "1") {
      select.dataset.scheduleDockBound = "1";
      select.addEventListener("change", () => {
        const id = Number(select.value || 0);
        setScheduleSelectedSendAsIds(deps, id ? [id] : []);
      });
    }
    if (followButton && followButton.dataset.scheduleDockBound !== "1") {
      followButton.dataset.scheduleDockBound = "1";
      followButton.addEventListener("click", () => {
        setScheduleSelectedSendAsIds(deps, activeScheduleSendAsIds(deps));
      });
    }
  }

  function activeScheduleSendAsIds(deps = {}) {
    const state = scheduleState(deps);
    const active = Number(state.activeIdentityId || 0);
    const identities = state.identities || [];
    if (active && identities.some((item) => Number(item.send_as_id || 0) === active)) {
      return [active];
    }
    return defaultScheduleSendAsIds(deps);
  }

  function renderScheduleIdentityOptions(deps = {}, selectedIds = []) {
    const selected = new Set((selectedIds || []).map((id) => Number(id)).filter(Boolean));
    return (scheduleState(deps).identities || [])
      .map((identity) => {
        const id = Number(identity.send_as_id || 0);
        const label = scheduleIdentityOptionLabel(deps, identity);
        return `<option value="${escapeAttr(String(id))}" ${selected.has(id) ? "selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  function renderScheduleIdentityPicker(deps = {}, selectedIds = []) {
    const state = scheduleState(deps);
    const accounts = state.accounts || [];
    const identities = state.identities || [];
    const selected = new Set((selectedIds || []).map((id) => Number(id)).filter(Boolean));
    if (!identities.length) {
      return '<div class="schedule-identity-picker-empty">还没有身份</div>';
    }
    const accountsByLocalId = new Map(accounts.map((account) => [String(account.local_id || ""), account]));
    const identitiesByAccount = new Map();
    for (const identity of identities) {
      const key = String(identity.account_local_id || "");
      if (!identitiesByAccount.has(key)) identitiesByAccount.set(key, []);
      identitiesByAccount.get(key).push(identity);
    }
    const orderedKeys = [
      ...accounts.map((account) => String(account.local_id || "")),
      ...Array.from(identitiesByAccount.keys()).filter((key) => key && !accountsByLocalId.has(key)),
      ...Array.from(identitiesByAccount.keys()).filter((key) => !key),
    ].filter((key, index, arr) => arr.indexOf(key) === index && identitiesByAccount.has(key));
    return orderedKeys.map((key) => {
      const account = accountsByLocalId.get(key) || null;
      const group = identitiesByAccount.get(key) || [];
      const loggedIn = String(account?.login_status || "") === "done";
      const running = String(account?.listener_status || "") === "running" || Boolean(account?.listen_enabled);
      const scheduleStateText = loggedIn ? "可排 TG" : "需先登录";
      const collectionText = running ? "采集中" : "采集未开";
      const selectedInGroup = group.filter((identity) => selected.has(Number(identity.send_as_id || 0))).length;
      return `
        <article class="schedule-account-picker-row ${selectedInGroup ? "selected" : ""}">
          <div class="schedule-account-picker-head">
            <span class="account-row-dot ${running ? "live" : (loggedIn ? "ok" : "warn")}"></span>
            <div>
              <strong>${escapeHtml(scheduleAccountLabel(account, key || "未绑定账号"))}</strong>
              <small>${escapeHtml(loggedIn ? "已登录" : "未登录")}｜${escapeHtml(scheduleStateText)}｜${escapeHtml(collectionText)}｜${escapeHtml(String(selectedInGroup))}/${escapeHtml(String(group.length))}</small>
            </div>
            <div class="schedule-account-picker-actions">
              <button type="button" data-schedule-select-account="${escapeAttr(key)}">只选账号</button>
              <button type="button" data-schedule-add-account="${escapeAttr(key)}">加入账号</button>
            </div>
          </div>
          <div class="schedule-identity-chip-list">
            ${group.map((identity) => {
              const id = Number(identity.send_as_id || 0);
              const active = selected.has(id);
              const name = identity.label || identity.username || identity.send_as_id;
              return `<button type="button" class="schedule-identity-chip ${active ? "selected" : ""}" data-schedule-select-identity="${escapeAttr(String(id))}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(String(name))}</button>`;
            }).join("")}
          </div>
        </article>
      `;
    }).join("");
  }

  function fallbackSchedulePresets() {
    return [{
      key: "custom",
      label: "自定义",
      description: "一条或多条命令 + 间隔 + 轮数,批量排进官方定时",
      fields: ["command", "interval_sec", "count", "command_gap_sec"],
      module_key: "",
      ui: { category: "custom", shape: "custom", tags: ["联动", "多命令"], automation: "manual" },
    }];
  }

  function schedulePresetUi(preset = {}) {
    return preset?.ui || {};
  }

  function schedulePresetCategory(preset = {}) {
    return String(schedulePresetUi(preset).category || (preset.key === "custom" ? "custom" : "daily"));
  }

  function schedulePresetCategoryLabel(categoryKey) {
    return SCHEDULE_PRESET_CATEGORY_META[categoryKey]?.label || categoryKey || "其它";
  }

  function schedulePresetShapeLabel(preset = {}) {
    const shape = String(schedulePresetUi(preset).shape || "");
    if (shape === "combo_rounds") return "多命令轮次";
    if (shape === "mixed_periodic") return "混合周期";
    if (shape === "phase_pair") return "触发配对";
    if (shape === "counted") return "小批量";
    if (shape === "daily") return "每日";
    if (shape === "custom") return "自定义";
    return "单项";
  }

  function schedulePresetAutomationLabel(preset = {}) {
    const automation = String(schedulePresetUi(preset).automation || "").trim();
    return SCHEDULE_AUTOMATION_LABELS[automation]?.label || "";
  }

  function schedulePresetAutomationTone(preset = {}) {
    const automation = String(schedulePresetUi(preset).automation || "").trim();
    return SCHEDULE_AUTOMATION_LABELS[automation]?.tone || "";
  }

  function schedulePresetTagsHtml(preset = {}) {
    const tags = Array.isArray(schedulePresetUi(preset).tags) ? schedulePresetUi(preset).tags : [];
    return tags.slice(0, 3).map((tag) => `<span class="status-pill">${escapeHtml(tag)}</span>`).join("");
  }

  function schedulePresetMap(presets = []) {
    return new Map((presets || []).map((preset) => [String(preset.key || ""), preset]));
  }

  function schedulePresetShortcutOrder(preset = {}) {
    const pinned = SCHEDULE_PINNED_PRESETS.indexOf(String(preset.key || ""));
    if (pinned >= 0) return pinned;
    const cat = SCHEDULE_PRESET_CATEGORY_META[schedulePresetCategory(preset)]?.order || 99;
    return 100 + cat * 100;
  }

  function schedulePlanStatusForContract(contract = null) {
    if (!contract) return { label: "预设", tone: "", note: "" };
    const automation = String(contract?.suggestion?.automation_level || "").trim();
    if (contract.semiauto_ready) return { label: "可半自动", tone: "ok", note: contract.summary?.text || "" };
    if (automation === "manual_followup") return { label: "需接力", tone: "warn", note: contract.suggestion?.reason || contract.summary?.text || "" };
    if (automation === "state_only") return { label: "仅观测", tone: "", note: contract.suggestion?.reason || contract.summary?.text || "" };
    if (contract.one_click_ready) return { label: "可排", tone: "ok", note: contract.summary?.text || "" };
    if (contract.suggestion?.automation_level === "manual") return { label: "手动", tone: "", note: contract.suggestion?.reason || contract.summary?.text || "" };
    const risk = (contract.warnings || []).find((item) => item.severity === "risk");
    const warn = risk || (contract.warnings || [])[0];
    return { label: risk ? "缺证据" : "需确认", tone: "warn", note: warn?.message || contract.summary?.text || "" };
  }

  function schedulePlanCardHtml({ preset, contract = null, catalog = null, disabled = false, note = "", compact = false } = {}) {
    if (!preset) return "";
    const moduleKey = String(preset.module_key || catalog?.key || "");
    const automationLabel = schedulePresetAutomationLabel(preset);
    const automationTone = schedulePresetAutomationTone(preset);
    const status = contract ? schedulePlanStatusForContract(contract) : {
      label: automationLabel || schedulePresetCategoryLabel(schedulePresetCategory(preset)),
      tone: automationTone,
      note: "",
    };
    const tags = schedulePresetTagsHtml(preset);
    const description = note || preset.description || schedulePresetShapeLabel(preset);
    return `
      <button type="button" class="schedule-plan-card ${escapeAttr(status.tone || "")} ${compact ? "compact" : ""} ${disabled ? "disabled" : ""}"
        data-schedule-plan-preset="${escapeAttr(disabled ? "" : preset.key)}"
        data-schedule-plan-module="${escapeAttr(moduleKey)}"
        data-schedule-plan-blocked="${disabled ? "1" : "0"}">
        <span class="schedule-plan-card-top">
          <strong>${escapeHtml(preset.label || preset.key || "")}</strong>
          <small>${escapeHtml(schedulePresetShapeLabel(preset))}</small>
        </span>
        <span class="schedule-plan-card-meta">
          <span class="status-pill ${escapeAttr(status.tone)}">${escapeHtml(status.label)}</span>
          ${automationLabel && (!contract || status.label !== automationLabel) ? `<span class="status-pill ${escapeAttr(automationTone)}">${escapeHtml(automationLabel)}</span>` : ""}
          ${tags}
        </span>
        <small>${escapeHtml(description)}</small>
      </button>
    `;
  }

  function scheduleStateRecommendationCards(deps = {}, { presets = [], scheduleModules = {}, selectedSendAsId = 0 } = {}) {
    const presetByKey = schedulePresetMap(presets);
    const group = (scheduleModules.by_identity || []).find((item) => Number(item.send_as_id || 0) === Number(selectedSendAsId || 0));
    const contracts = group?.items || [];
    const cards = contracts
      .map((contract) => {
        const suggestion = contract.suggestion || {};
        const presetKey = String(suggestion.preset_key || contract.module_key || "").trim();
        const preset = presetByKey.get(presetKey);
        const catalog = findModuleCatalog(scheduleModules, contract.module_key);
        const canApply = Boolean(preset && preset.key !== "custom");
        if (!preset && !catalog) return "";
        if (!preset) {
          const automation = String(suggestion.automation_level || "").trim();
          const tag = automation === "state_only"
            ? "仅观测"
            : automation === "manual_followup"
              ? "需接力"
              : "需人工";
          const fakePreset = {
            key: "custom",
            label: catalog?.label || contract.label || contract.module_key,
            description: suggestion.reason || "需要先从状态机确认是否适合官方定时",
            fields: ["command", "interval_sec", "count", "command_gap_sec"],
            module_key: contract.module_key,
            ui: { category: "phase", shape: "custom", tags: [tag], automation: automation || "manual" },
          };
          return schedulePlanCardHtml({ preset: fakePreset, contract, catalog, disabled: true, compact: true });
        }
        return schedulePlanCardHtml({ preset, contract, catalog, disabled: !canApply, compact: true });
      })
      .filter(Boolean)
      .slice(0, 8);
    if (!selectedSendAsId) {
      return '<p class="empty inline">先选择排程身份。</p>';
    }
    return cards.join("") || '<p class="empty inline">当前身份还没有可直接套用的状态机建议。</p>';
  }

  function schedulePresetShortcutGroups(presets = []) {
    const visible = (presets || [])
      .filter((preset) => preset.key !== "custom")
      .filter((preset) => !SCHEDULE_HIDDEN_SHORTCUT_PRESETS.has(String(preset.key || "")))
      .sort((a, b) => {
        const rank = schedulePresetShortcutOrder(a) - schedulePresetShortcutOrder(b);
        if (rank) return rank;
        return String(a.label || a.key || "").localeCompare(String(b.label || b.key || ""), "zh-Hans-CN");
      });
    const groups = new Map();
    for (const preset of visible) {
      const category = schedulePresetCategory(preset);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(preset);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => (SCHEDULE_PRESET_CATEGORY_META[a]?.order || 99) - (SCHEDULE_PRESET_CATEGORY_META[b]?.order || 99))
      .map(([category, rows]) => `
        <section class="schedule-plan-group">
          <div class="schedule-plan-group-head">
            <strong>${escapeHtml(schedulePresetCategoryLabel(category))}</strong>
            <span>${escapeHtml(String(rows.length))}</span>
          </div>
          <div class="schedule-plan-card-list">
            ${rows.slice(0, category === "package" ? 8 : 6).map((preset) => schedulePlanCardHtml({ preset, compact: true })).join("")}
          </div>
        </section>
      `)
      .join("");
  }

  function renderScheduleCustomExamples() {
    return SCHEDULE_CUSTOM_EXAMPLES.map((item) => `
      <button type="button" class="schedule-plan-example" data-schedule-custom-example="${escapeAttr(item.key)}">
        <strong>${escapeHtml(item.label)}</strong>
        <small>${escapeHtml(item.command.split("\n").join(" / "))}</small>
      </button>
    `).join("");
  }

  function renderSchedulePlanWorkbench(deps = {}, { presets = [], scheduleModules = {}, selectedSendAsId = 0 } = {}) {
    const identity = selectedSendAsId
      ? (scheduleIdentityLabel(deps, selectedSendAsId) || `send_as ${selectedSendAsId}`)
      : "未选身份";
    return `
      <div class="schedule-plan-workbench-grid">
        <section class="schedule-plan-panel schedule-plan-recommend">
          <div class="schedule-plan-panel-head">
            <strong>状态机推荐</strong>
            <small>${escapeHtml(identity)}｜${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}</small>
          </div>
          <p class="schedule-plan-panel-note">先看证据，再决定可排、需接力，还是只做观测。</p>
          <div class="schedule-plan-card-list">
            ${scheduleStateRecommendationCards(deps, { presets, scheduleModules, selectedSendAsId })}
          </div>
        </section>
        <section class="schedule-plan-panel schedule-plan-presets">
          <div class="schedule-plan-panel-head">
            <strong>常用方案</strong>
            <small>单项和联动包</small>
          </div>
          <p class="schedule-plan-panel-note">点方案就能套字段，少翻表单。</p>
          <div class="schedule-plan-groups">
            ${schedulePresetShortcutGroups(presets)}
          </div>
        </section>
        <section class="schedule-plan-panel schedule-plan-custom">
          <div class="schedule-plan-panel-head">
            <strong>联动自定义</strong>
            <small>每行一条命令,一轮内错峰</small>
          </div>
          <p class="schedule-plan-panel-note">适合点卯 + 闯塔、入梦 + 天机，或者临时串联多条指令。</p>
          <div class="schedule-plan-example-list">${renderScheduleCustomExamples()}</div>
        </section>
      </div>
    `;
  }

  async function loadScheduleModalBootstrap(deps = {}) {
    const state = scheduleState(deps);
    try {
      const payload = await fetchJson(SCHEDULE_BOOTSTRAP_URL);
      return {
        ok: payload.ok !== false,
        warning: payload.ok === false ? "官方定时部分资料读取失败,已尽量展示可用数据。" : "",
        presets: payload.presets || [],
        modules: {
          ok: true,
          modules: payload.modules || [],
          by_identity: payload.by_identity || [],
          tianjige: payload.tianjige || {},
        },
        batches: state.scheduleBatches || [],
        templates: payload.templates || [],
      };
    } catch (error) {
      return {
        ok: false,
        warning: `官方定时资料暂时读取失败: ${error.message || String(error)}。已显示本地缓存,稍后可再刷新。`,
        presets: fallbackSchedulePresets(),
        modules: { ok: false, modules: [], by_identity: [], tianjige: {} },
        batches: state.scheduleBatches || [],
        templates: [],
      };
    }
  }

  function renderScheduleModalLoading() {
    return `
      <div class="schedule-modal-loading">
        <p class="empty inline">正在读取官方定时排班...</p>
      </div>
    `;
  }

  function renderScheduleModalBody(deps = {}, { presets, scheduleModules, batches, templates, defaultSendAsIds }) {
    const identityOptions = renderScheduleIdentityOptions(deps, defaultSendAsIds);
    const presetOptions = presets
      .filter((preset) => !SCHEDULE_HIDDEN_SHORTCUT_PRESETS.has(String(preset.key || "")))
      .map((p) => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)} — ${escapeHtml(p.description)}</option>`)
      .join("");
    const renewPresetOptions = renderScheduleRenewPresetOptions(presets);
    const moduleOptions = renderScheduleModuleOptions(scheduleModules.modules || []);
    const selectedSendAsId = Number((defaultSendAsIds || [])[0] || 0);
    return `
      <div class="schedule-modal-grid">
        <div class="schedule-modal-main">
          <section class="modal-section schedule-create-section">
            <h4>排程工作台</h4>
            <form id="scheduleForm" class="settings-form">
              <div class="schedule-native-send-as" aria-hidden="true">
                <select name="send_as_ids" multiple size="6" id="scheduleSendAsSelect" tabindex="-1">${identityOptions || '<option value="">没有可用身份</option>'}</select>
                <span id="scheduleSendAsCount">0</span>
              </div>
              <div class="schedule-modal-context">
                <div class="schedule-identity-picker" id="scheduleIdentityPicker">
                  <div class="schedule-identity-picker-top">
                    <div>
                      <h4>排程身份</h4>
                      <strong id="scheduleIdentitySummary">未选身份</strong>
                      <small id="scheduleIdentityScope">0 个身份</small>
                    </div>
                    <div class="schedule-identity-picker-actions">
                      <button type="button" id="scheduleUseActiveIdentityButton">跟随聊天当前</button>
                      <button type="button" id="scheduleSelectAllIdentityButton">全选可用身份</button>
                      <button type="button" id="scheduleSetChatIdentityButton">设为聊天当前</button>
                      <button type="button" id="scheduleClearIdentityButton">清空</button>
                    </div>
                  </div>
                  <div class="schedule-account-picker-list" id="scheduleAccountPickerList">
                    ${renderScheduleIdentityPicker(deps, defaultSendAsIds)}
                  </div>
                </div>
              </div>
              <div id="schedulePlanWorkbench" class="schedule-plan-workbench">
                ${renderSchedulePlanWorkbench(deps, { presets, scheduleModules, selectedSendAsId })}
              </div>
              <div class="form-actions schedule-form-actions-top">
                <button type="button" data-schedule-action="preview">预览计划</button>
                <button type="button" class="primary" data-schedule-action="create">创建</button>
              </div>
              <div class="form-grid schedule-primary-fields">
                <label>
                  <span>预设</span>
                  <select name="preset_key">${presetOptions}</select>
                </label>
                <label>
                  <span>状态机锚点来源</span>
                  <select name="auto_anchor_module" id="scheduleStateModuleSelect">
                    <option value="">跟随预设 / 不使用</option>
                    ${moduleOptions}
                  </select>
                  <small class="muted">状态机决定 next_at,定时只从这个起点排官方消息。</small>
                </label>
                <label data-show-when="horizon_days">
                  <span>排几天(1-7)</span>
                  <input name="horizon_days" inputmode="numeric" min="1" max="7" value="3" />
                </label>
                <label>
                  <span>锚点时间(${SCHEDULE_TIME_ZONE_LABEL})</span>
                  <input name="anchor_at_text" type="datetime-local" />
                </label>
              </div>
              <label class="toggle-row">
                <input type="checkbox" name="auto_anchor" />
                <span>自动锚点(取状态机 next_at 和手填锚点中较晚者)</span>
              </label>
              <label class="toggle-row">
                <input type="checkbox" name="schedule_use_module_defaults" checked />
                <span>套用状态机建议命令/间隔/参数</span>
              </label>
              <div class="schedule-command-group-editor" id="scheduleCommandGroupEditor">
                <div class="schedule-command-group-head">
                  <strong>命令组</strong>
                  <small>自定义/联动方案会在这里展开</small>
                </div>
                <div class="form-grid">
                  <label class="span-2" data-show-when="command">
                    <span>联动命令组</span>
                    <textarea name="command" rows="4" placeholder="每行一条命令 = 同一轮联动；例如&#10;.宗门点卯&#10;.闯塔&#10;.天机代卜"></textarea>
                    <small class="muted">3 行命令 + 轮数 2 = 排两轮,每轮 3 条,同轮错峰。</small>
                  </label>
                  <label data-show-when="interval_sec">
                    <span>轮间隔 / CD(秒)</span>
                    <input name="interval_sec" inputmode="numeric" value="3600" placeholder="下一轮和上一轮相隔多久" />
                  </label>
                  <label data-show-when="count">
                    <span>轮数</span>
                    <input name="count" inputmode="numeric" value="3" placeholder="重复几轮" />
                  </label>
                  <label data-show-when="command_gap_sec">
                    <span>同轮命令间隔(秒)</span>
                    <input name="command_gap_sec" inputmode="numeric" value="180" placeholder="同一轮内多条命令之间错开" />
                  </label>
                </div>
              </div>
              <details class="schedule-secondary-section schedule-advanced-section">
                <summary>
                  <span>
                    <strong>高级参数</strong>
                    <small>错峰 / dry-run / 触发词</small>
                  </span>
                </summary>
                <div class="form-grid">
                  <label>
                    <span>批量阶梯(每个身份递增分钟)</span>
                    <input name="offset_step_minutes" inputmode="numeric" value="5" placeholder="批量时每个身份 offset 递增,1 个就不生效" />
                  </label>
                  <label>
                    <span>错峰偏移(分钟)</span>
                    <input name="offset_minutes" inputmode="numeric" value="0" placeholder="0 = 不偏" title="多账号同时建议各错开 3-15 分钟,避免天尊同一刻被多账号挤" />
                  </label>
                  <label data-show-when="pet_name">
                    <span>法宝名</span>
                    <input name="pet_name" placeholder="留空表示不带名字" />
                  </label>
                  <label data-show-when="trigger_command">
                    <span>触发词(可选)</span>
                    <input name="trigger_command" placeholder="深闭默认「查看闭关」,留空走默认;其他 preset 留空 = 不发触发" />
                  </label>
                </div>
                <label class="toggle-row">
                  <input type="checkbox" name="schedule_semiauto" />
                  <span>白名单半自动(后端会拒绝未知、缺参数、阶段型和非白名单模块)</span>
                </label>
                <label class="toggle-row">
                  <input type="checkbox" name="dry_run" />
                  <span>本地预演(只记录计划,不排到 Telegram)</span>
                </label>
              </details>
              <div class="form-actions">
                <button type="button" id="scheduleApplyStateSuggestion">套用状态机建议</button>
              </div>
              <div id="scheduleStateHint" class="send-as-result" hidden></div>
            </form>
            <p class="modal-status-line info" id="scheduleStatus" hidden></p>
          </section>

          <details class="modal-section schedule-secondary-section schedule-preview-section" id="schedulePreviewShell">
            <summary>
              <span>
                <strong>预览计划</strong>
                <small id="schedulePreviewSummary">尚未生成</small>
              </span>
            </summary>
            <div id="schedulePreview" class="send-as-result" hidden></div>
          </details>

          <section class="modal-section schedule-refill-section">
            <h4>高水位补货 ${scheduleTimeZonePill()}</h4>
            <p class="muted">先核对 TG 当前高水位和状态机起点,确认后只在最晚任务之后增量追加,不删除或改写已有官方定时。</p>
            <form id="scheduleRefillForm" class="settings-form">
              <div class="form-grid">
                <label>
                  <span>补货身份</span>
                  <select name="send_as_id" id="scheduleRefillSendAsSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
                </label>
                <label>
                  <span>覆盖天数(1-3)</span>
                  <input name="coverage_days" inputmode="numeric" min="1" max="3" value="2" />
                </label>
                <label>
                  <span>起跑提前(秒)</span>
                  <input name="lead_sec" inputmode="numeric" min="60" max="86400" value="300" />
                </label>
                <label>
                  <span>批次阶梯(秒)</span>
                  <input name="offset_sec" inputmode="numeric" min="0" max="21600" value="180" />
                </label>
                <label>
                  <span>软上限</span>
                  <input name="soft_limit" inputmode="numeric" min="1" max="100" value="95" />
                </label>
              </div>
              <div class="form-actions">
                <button type="button" id="scheduleRefillPreviewButton">预览补货</button>
                <button type="button" class="primary" id="scheduleRefillRunButton" data-schedule-refill-action="run">确认补货</button>
              </div>
            </form>
            <p class="modal-status-line info" id="scheduleRefillStatus" hidden></p>
            <div id="scheduleRefillPreview" class="send-as-result" hidden></div>
          </section>

          <details class="modal-section schedule-secondary-section schedule-template-section">
            <summary>
              <span>
                <strong>模板复用</strong>
                <small>保存 / 套用常用参数</small>
              </span>
            </summary>
            <p class="muted">把常用排班参数存成模板，后续一键套用后再微调即可。模板只存参数，不存具体锚点时间。</p>
            <div class="form-grid">
              <label class="span-2">
                <span>模板名称</span>
                <input id="scheduleTemplateName" placeholder="例如 深闭三天循环" />
              </label>
              <label class="span-2">
                <span>已保存模板</span>
                <select id="scheduleTemplateSelect">
                  <option value="">新建模板</option>
                  ${renderScheduleTemplateOptions(templates)}
                </select>
              </label>
            </div>
            <div class="form-actions">
              <button type="button" id="scheduleTemplateLoadButton">套用模板</button>
              <button type="button" id="scheduleTemplateSaveButton">保存当前为模板</button>
              <button type="button" id="scheduleTemplateDeleteButton">删除模板</button>
            </div>
            <p class="modal-status-line info" id="scheduleTemplateStatus" hidden></p>
          </details>

          <section class="modal-section schedule-renew-section">
            <h4>续期策略 ${scheduleTimeZonePill()}</h4>
            <div id="scheduleRenewWorkerStatus" class="schedule-renew-worker-status" aria-live="polite">
              ${renderScheduleRenewWorkerStatus()}
            </div>
            <div id="scheduleRenewOverview" class="schedule-renew-overview" aria-live="polite">
              <p class="empty inline">正在读取续期状态...</p>
            </div>
            <form id="scheduleRenewForm" class="settings-form">
              <input type="hidden" name="id" />
              <div class="form-grid">
                <label>
                  <span>续期身份</span>
                  <select name="send_as_id" id="scheduleRenewSendAsSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
                </label>
                <label>
                  <span>续期预设</span>
                  <select name="preset_key" id="scheduleRenewPresetSelect">${renewPresetOptions || '<option value="">暂无可续期预设</option>'}</select>
                </label>
                <label>
                  <span>状态机</span>
                  <select name="module_key" id="scheduleRenewModuleSelect">
                    ${moduleOptions || '<option value="">暂无状态机</option>'}
                  </select>
                </label>
                <label>
                  <span>每次续期(1-3 天)</span>
                  <input name="renew_days" inputmode="numeric" min="1" max="3" value="1" />
                </label>
                <label>
                  <span>低于阈值再续(h)</span>
                  <input name="threshold_hours" inputmode="numeric" min="1" max="72" value="24" />
                </label>
                <label>
                  <span>软上限</span>
                  <input name="soft_limit" inputmode="numeric" min="1" max="100" value="95" />
                </label>
              </div>
              <label class="toggle-row">
                <input type="checkbox" name="enabled" checked />
                <span>启用策略</span>
              </label>
              <div class="form-actions">
                <button type="button" id="scheduleRenewNewButton">新策略</button>
                <button type="button" id="scheduleRenewSaveButton">保存策略</button>
                <button type="button" id="scheduleRenewPreviewButton">预览续期</button>
                <button type="button" class="primary" id="scheduleRenewRunButton">立即续期</button>
              </div>
            </form>
            <p class="modal-status-line info" id="scheduleRenewStatus" hidden></p>
            <div id="scheduleRenewPreview" class="send-as-result" hidden></div>
            <div id="scheduleRenewProfileList" class="schedule-renew-profile-list">
              <p class="empty inline">正在读取续期策略...</p>
            </div>
          </section>

          <details class="modal-section schedule-secondary-section schedule-sync-section">
            <summary>
              <span>
                <strong>对账 Telegram 端</strong>
                <small>漂移修复 / TG 待发送列表</small>
              </span>
            </summary>
            <p class="muted">拉 TG 的 GetScheduledHistory,跟本地批次对账,标出「TG 有 mini-web 没记录」(orphans)、「未来丢失」(lost) 和「已过期释放」(expired) 的项。</p>
            <div class="form-grid">
              <label class="span-2">
                <span>对账身份</span>
                <select id="scheduleSyncSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
              </label>
            </div>
            <div class="form-actions">
              <button type="button" id="scheduleSyncButton">拉 TG 状态对账</button>
              <button type="button" id="scheduleSyncRepairButton">修复本地漂移</button>
            </div>
            <p class="modal-status-line info" id="scheduleSyncStatus" hidden></p>
            <div id="scheduleSyncResult" class="send-as-result" hidden></div>
          </details>
        </div>

        <aside class="schedule-modal-records" aria-label="本地排班记录">
          <section class="modal-section">
            <h4>本地排班记录</h4>
            <p class="muted">这些是 mini-web 自己存的批次。dry_run=False 那次会同时排到 Telegram;有 scheduled_msg_id 的就是真排上的。</p>
            <div id="scheduleBatchList">${renderScheduleBatches(deps, batches)}</div>
          </section>
        </aside>
      </div>
    `;
  }

  async function openScheduleModal(deps = {}) {
    const dialog = openModal({
      title: "官方定时排班",
      body: renderScheduleModalLoading(),
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    dialog.classList.add("schedule-modal-dialog");
    const bootstrap = await loadScheduleModalBootstrap(deps);
    if (!dialog.isConnected) return;
    const presets = bootstrap.presets?.length ? bootstrap.presets : fallbackSchedulePresets();
    const scheduleModules = bootstrap.modules || { modules: [], by_identity: [] };
    const batches = syncScheduleBatches(deps, { batches: bootstrap.batches || [] });
    const templates = bootstrap.templates || [];
    const defaultSendAsIds = defaultScheduleSendAsIds(deps);
    const modalBody = dialog.querySelector(".modal-body");
    if (modalBody) {
      modalBody.innerHTML = renderScheduleModalBody(deps, { presets, scheduleModules, batches, templates, defaultSendAsIds });
    }
    const setScheduleStatus = bindScheduleModal(deps, dialog, presets, batches, templates, scheduleModules);
    refreshScheduleModalBatches(deps, dialog, setScheduleStatus).catch((error) => {
      const status = dialog.querySelector("#scheduleStatus");
      if (status && !status.textContent) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = `本地排班记录刷新失败: ${error.message || String(error)}`;
      }
    });
    if (bootstrap.warning) {
      const status = dialog.querySelector("#scheduleStatus");
      if (status) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = bootstrap.warning;
      }
    }
  }

  async function refreshScheduleModalBatches(deps = {}, dialog, setStatus = null) {
    if (!dialog?.isConnected) return [];
    const batchList = dialog.querySelector("#scheduleBatchList");
    if (batchList && !(scheduleState(deps).scheduleBatches || []).length) {
      batchList.innerHTML = '<p class="empty inline">正在读取本地排班记录...</p>';
    }
    const payload = await fetchJson("/api/schedule?history=0");
    if (!dialog.isConnected) return [];
    const batches = syncScheduleBatches(deps, payload);
    if (batchList) {
      batchList.innerHTML = renderScheduleBatches(deps, batches);
      bindScheduleBatchActions(deps, dialog, setStatus);
    }
    return batches;
  }

  function renderScheduleTemplateOptions(templates) {
    return (templates || [])
      .map((template) => `<option value="${escapeAttr(template.id)}">${escapeHtml(template.name || template.id)}</option>`)
      .join("");
  }

  function renderScheduleModuleOptions(modules) {
    return (modules || [])
      .map((module) => {
        const suggestion = module.suggestion || {};
        const badge = suggestion.semiauto_whitelisted ? "｜可半自动" : "";
        return `<option value="${escapeAttr(module.key)}">${escapeHtml(module.label || module.key)}${escapeHtml(badge)}</option>`;
      })
      .join("");
  }

  function scheduleRenewModuleForPreset(presetKey) {
    return SCHEDULE_RENEW_ALLOWED_PRESETS[String(presetKey || "").trim()] || "";
  }

  function renderScheduleRenewPresetOptions(presets) {
    return (presets || [])
      .filter((preset) => scheduleRenewModuleForPreset(preset.key))
      .map((preset) => `<option value="${escapeAttr(preset.key)}">${escapeHtml(preset.label)} — ${escapeHtml(preset.description || "")}</option>`)
      .join("");
  }

  function renderScheduleRenewWorkerStatus(worker = null) {
    if (!worker) {
      return '<span class="status-pill">读取中</span><small>后台续期 worker 状态读取中</small>';
    }
    const running = Boolean(worker.running);
    const result = worker.last_result || {};
    const lastRun = worker.last_run_text ? `上次扫描 ${worker.last_run_text}` : "尚未扫描";
    let summary = "等待首次扫描";
    if (result.ok === false) {
      summary = result.error || "扫描失败";
    } else if (Object.prototype.hasOwnProperty.call(result, "processed")) {
      summary = `处理 ${Number(result.processed || 0)}｜新建 ${Number(result.created || 0)}｜跳过 ${Number(result.skipped || 0)}｜阻塞 ${Number(result.blocked || 0)}`;
    }
    return `
      <span class="status-pill ${running ? "ok" : "warn"}">${running ? "worker 运行中" : "worker 未运行"}</span>
      ${scheduleTimeZonePill()}
      <small>${escapeHtml(lastRun)}｜${escapeHtml(summary)}</small>
    `;
  }

  function scheduleRenewAllowedPresetRows(allowedPresets = [], presetMap = null) {
    return (allowedPresets || [])
      .map((item) => {
        const presetKey = String(item.preset_key || item.key || "").trim();
        const moduleKey = String(item.module_key || scheduleRenewModuleForPreset(presetKey) || "").trim();
        if (!presetKey || !moduleKey) return null;
        const preset = presetMap?.get?.(presetKey) || null;
        return {
          preset_key: presetKey,
          module_key: moduleKey,
          label: preset?.label || item.label || presetKey,
          interval_sec: Number(item.interval_sec || 0),
        };
      })
      .filter(Boolean);
  }

  function scheduleRenewProfileKey(sendAsId, presetKey) {
    return `${Number(sendAsId || 0)}:${String(presetKey || "").trim()}`;
  }

  function scheduleRenewStatusChip(label, tone = "") {
    return `<span class="status-pill ${escapeAttr(tone)}">${escapeHtml(label)}</span>`;
  }

  function scheduleRenewProfileIdentityText(deps = {}, profile = {}) {
    const identity = scheduleIdentityById(deps, profile.send_as_id);
    const account = scheduleAccountByLocalId(deps, identity?.account_local_id || profile.account_local_id);
    const identityText = scheduleIdentityLabel(deps, profile.send_as_id) || `send_as ${profile.send_as_id || ""}`;
    const accountText = account ? scheduleAccountLabel(account, identity?.account_local_id || profile.account_local_id) : String(identity?.account_local_id || profile.account_local_id || "未绑定账号");
    return accountText ? `${identityText}｜${accountText}` : identityText;
  }

  function renderScheduleRenewOverview(deps = {}, options = {}) {
    const profiles = options.profiles || [];
    const presetMap = options.presetMap || null;
    const allowedRows = scheduleRenewAllowedPresetRows(options.allowedPresets || [], presetMap);
    const selectedSendAsId = Number(options.selectedSendAsId || 0);
    const scheduleModules = options.scheduleModules || {};
    const scopedProfiles = selectedSendAsId
      ? profiles.filter((profile) => Number(profile.send_as_id || 0) === selectedSendAsId)
      : profiles;
    const hiddenProfileCount = Math.max(0, profiles.length - scopedProfiles.length);
    const configured = new Set(scopedProfiles.map((profile) => scheduleRenewProfileKey(profile.send_as_id, profile.preset_key)));
    const enabled = scopedProfiles.filter((profile) => profile.enabled !== false);
    const automatic = enabled.filter((profile) => scheduleRenewProfileReady(profile) && !profile.last_error);
    const waiting = enabled.filter((profile) => !scheduleRenewProfileReady(profile) || profile.last_error);
    const disabled = scopedProfiles.filter((profile) => profile.enabled === false);
    const addable = [];
    const blocked = [];
    if (selectedSendAsId) {
      allowedRows.forEach((row) => {
        const key = scheduleRenewProfileKey(selectedSendAsId, row.preset_key);
        if (configured.has(key)) return;
        const contract = findScheduleContract(scheduleModules, selectedSendAsId, row.module_key);
        const target = {
          ...row,
          contract,
          identity: scheduleIdentityLabel(deps, selectedSendAsId) || `send_as ${selectedSendAsId}`,
        };
        if (scheduleContractRenewReady(row, contract)) addable.push(target);
        else blocked.push(target);
      });
    }
    const profileChip = (profile, tone) => `
      <button type="button" class="schedule-renew-chip schedule-renew-check ${escapeAttr(tone || "")} ${profile.enabled !== false ? "is-checked" : ""}" data-schedule-renew-overview-action="toggle-profile" data-profile-id="${escapeAttr(String(profile.id || ""))}" aria-pressed="${profile.enabled !== false ? "true" : "false"}">
        <span class="schedule-renew-chip-mark">${profile.enabled !== false ? "开" : "停"}</span>
        <span>
          <strong>${escapeHtml(profile.label || profile.preset_key || "")}</strong>
          <small>${escapeHtml(scheduleRenewProfileIdentityText(deps, profile))}｜${escapeHtml(scheduleRenewEvidenceText(profile.state_contract || null))}</small>
        </span>
        ${scheduleRenewStatusChip(profile.last_error ? "异常" : profile.enabled === false ? "停用" : scheduleRenewProfileReady(profile) ? "自动" : "待观察", tone)}
      </button>
    `;
    const presetChip = (row, tone, action = "apply") => `
      <label class="schedule-renew-chip schedule-renew-check ${escapeAttr(tone || "")} ${action === "blocked" ? "disabled" : ""}">
        <input type="checkbox" data-schedule-renew-overview-action="${escapeAttr(action === "blocked" ? "blocked" : "enable")}" data-schedule-renew-preset="${escapeAttr(row.preset_key)}" data-schedule-renew-module="${escapeAttr(row.module_key)}" data-schedule-renew-send-as="${escapeAttr(String(selectedSendAsId))}" ${action === "blocked" ? "disabled" : ""} />
        <span>
          <strong>${escapeHtml(row.label)}</strong>
          <small>${escapeHtml(row.module_key)}${row.interval_sec ? `｜${escapeHtml(String(Math.round(row.interval_sec / 60)))}min` : ""}｜${escapeHtml(scheduleRenewEvidenceText(row.contract || null))}</small>
        </span>
        ${scheduleRenewStatusChip(action === "blocked" ? "需观察" : "可勾选", tone)}
      </label>
    `;
    const group = (title, rowsHtml, count, emptyText) => `
      <div class="schedule-renew-overview-group">
        <div class="schedule-renew-overview-head">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(String(count))}</span>
        </div>
        <div class="schedule-renew-chip-list">${rowsHtml || `<small class="muted">${escapeHtml(emptyText)}</small>`}</div>
      </div>
    `;
    const selectedHint = selectedSendAsId
      ? `当前新增身份: ${scheduleIdentityLabel(deps, selectedSendAsId)}`
      : "当前新增身份: 未选择";
    return `
      <div class="schedule-renew-overview-top">
        ${scheduleTimeZonePill()}
        <small>${escapeHtml(selectedHint)}</small>
        ${hiddenProfileCount ? `<small>其它身份 ${escapeHtml(String(hiddenProfileCount))} 条已收起</small>` : ""}
      </div>
      ${group("可新增", addable.map((row) => presetChip(row, "ok", "apply")).join(""), addable.length, selectedSendAsId ? "当前身份暂无可新增预设" : "先选择续期身份")}
      ${group("自动中", automatic.map((profile) => profileChip(profile, "ok")).join(""), automatic.length, "暂无可自动运行策略")}
      ${group("待处理", waiting.map((profile) => profileChip(profile, "warn")).join("") + disabled.map((profile) => profileChip(profile, "")).join(""), waiting.length + disabled.length, "暂无阻塞策略")}
      ${group("需先观察", blocked.slice(0, 8).map((row) => presetChip(row, "warn", "blocked")).join(""), blocked.length, "没有缺观察的白名单预设")}
    `;
  }

  function renderScheduleRenewProfiles(deps = {}, profiles = []) {
    if (!profiles.length) {
      return '<p class="empty inline">还没有续期策略。</p>';
    }
    const groups = [];
    const byKey = new Map();
    (profiles || []).forEach((profile) => {
      const key = String(profile.send_as_id || 0);
      if (!byKey.has(key)) {
        const group = {
          key,
          send_as_id: Number(profile.send_as_id || 0),
          title: scheduleRenewProfileIdentityText(deps, profile),
          profiles: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      byKey.get(key).profiles.push(profile);
    });
    return groups.map((group) => `
      <section class="schedule-renew-profile-group" data-schedule-renew-profile-send-as="${escapeAttr(String(group.send_as_id || ""))}">
        <div class="schedule-renew-profile-group-head">
          <strong>${escapeHtml(group.title)}</strong>
          <span>${escapeHtml(String(group.profiles.length))} 条策略</span>
        </div>
        ${group.profiles.map((profile) => renderScheduleRenewProfileRow(deps, profile)).join("")}
      </section>
    `).join("");
  }

  function renderScheduleRenewProfileRow(deps = {}, profile) {
      const contract = profile.state_contract || {};
      const enabled = profile.enabled !== false;
      const ready = scheduleRenewProfileReady(profile);
      const statusPill = enabled
        ? `<span class="status-pill ${ready ? "ok" : "warn"}">${ready ? "可续期" : "待观察"}</span>`
        : '<span class="status-pill">停用</span>';
      const identity = scheduleRenewProfileIdentityText(deps, profile);
      const coverage = profile.covered_until_text || profile.tail_text || "当前无未来项";
      const storedCoverage = profile.stored_covered_until_text || "";
      const storedHint = storedCoverage && storedCoverage !== coverage
        ? `<small class="muted">上次记录覆盖到 ${escapeHtml(storedCoverage)}</small>`
        : "";
      const error = profile.last_error
        ? `<small class="warn">${escapeHtml(profile.last_error)}</small>`
        : "";
      const evidenceText = scheduleRenewEvidenceText(contract);
      return `
        <article class="account-row" data-schedule-renew-profile-id="${escapeAttr(String(profile.id || ""))}">
          <span class="account-row-dot ${enabled && ready ? "live" : profile.last_error ? "warn" : "idle"}" aria-hidden="true"></span>
          <div class="account-row-body">
            <div class="account-row-title">
              <strong>${escapeHtml(profile.label || profile.preset_key || "")}</strong>
              ${statusPill}
              <span class="account-row-meta">${escapeHtml(identity)}｜${escapeHtml(profile.module_key || "")}｜续 ${escapeHtml(String(profile.renew_days || 1))} 天｜余量 ${escapeHtml(String(profile.soft_remaining ?? ""))}</span>
            </div>
            <p class="muted">当前覆盖到 ${escapeHtml(coverage)}｜${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}｜阈值 ${escapeHtml(String(profile.threshold_hours || 24))}h｜${escapeHtml(evidenceText)}</p>
            ${storedHint}
            ${profile.renew_block_reason && !ready ? `<small class="warn">${escapeHtml(profile.renew_block_reason)}</small>` : ""}
            ${error}
          </div>
          <div class="account-row-actions">
            <button type="button" data-schedule-renew-action="load" data-profile-id="${escapeAttr(String(profile.id || ""))}">载入</button>
            <button type="button" data-schedule-renew-action="preview" data-profile-id="${escapeAttr(String(profile.id || ""))}">预览</button>
            <button type="button" data-schedule-renew-action="run" data-profile-id="${escapeAttr(String(profile.id || ""))}">立即续期</button>
            <button type="button" data-schedule-renew-action="delete" data-profile-id="${escapeAttr(String(profile.id || ""))}">删除</button>
          </div>
        </article>
      `;
  }

  function renderScheduleBatches(deps = {}, batches) {
    if (!batches.length) {
      return '<p class="empty inline">还没有任何官方定时批次。上面新建一个。</p>';
    }
    const currentBatches = batches.filter(scheduleBatchHasCurrentWork);
    const previewBatches = batches.filter(scheduleBatchIsDryRun);
    const historicalBatches = batches.filter((batch) => !scheduleBatchHasCurrentWork(batch) && !scheduleBatchIsDryRun(batch));
    const currentHtml = currentBatches.length
      ? renderScheduleBatchRows(deps, currentBatches)
      : '<p class="empty inline">没有进行中的官方定时批次。</p>';
    const previewHtml = previewBatches.length
      ? `
        <details class="schedule-history-details">
          <summary>已收起 ${escapeHtml(String(previewBatches.length))} 个本地预演批次</summary>
          ${renderScheduleBatchRows(deps, previewBatches, { dryRunMode: true })}
        </details>
      `
      : "";
    const historyHtml = historicalBatches.length
      ? `
        <details class="schedule-history-details">
          <summary>已收起 ${escapeHtml(String(historicalBatches.length))} 个历史批次</summary>
          ${renderScheduleBatchRows(deps, historicalBatches, { includeExpiredItems: true })}
        </details>
      `
      : "";
    return `${currentHtml}${previewHtml}${historyHtml}`;
  }

  function renderScheduleBatchRows(deps = {}, batches, options = {}) {
    const includeExpiredItems = Boolean(options.includeExpiredItems);
    const dryRunMode = Boolean(options.dryRunMode);
    return batches
      .map((b) => {
        const visibleItems = includeExpiredItems ? (b.items || []) : (b.items || []).filter(scheduleMessageHasCurrentWork);
        const items = visibleItems
          .map((m) => {
            const view = scheduleMessageStatusView(m);
            return `
              <li>
                <code>${escapeHtml(m.command)}</code>
                <small>${escapeHtml(m.schedule_text || "")}</small>
                ${view.pill}
                ${m.scheduled_msg_id ? `<small>TG #${escapeHtml(String(m.scheduled_msg_id))}</small>` : ""}
                ${view.note ? `<small class="${escapeAttr(view.noteClass)}">${escapeHtml(view.note)}</small>` : ""}
              </li>
            `;
          })
          .join("");
        const counts = includeExpiredItems ? (b.counts || {}) : scheduleCurrentCounts(b.counts || {});
        const total = (counts.planned || 0) + (counts.scheduled || 0) + (counts.failed || 0) + (counts.expired || 0);
        const done = (counts.scheduled || 0) + (counts.expired || 0);
        const pct = total ? Math.round((done / total) * 100) : 0;
        const statusKey = dryRunMode || scheduleBatchIsDryRun(b)
          ? "dry_run"
          : scheduleDisplayStatusKey(b.status || "active", counts);
        const statusText = scheduleStatusText(statusKey, counts);
        const statusPill = scheduleStatusPill(statusKey);
        const showProgress = statusKey === "sending" || statusKey === "needs_retry" || (counts.planned > 0 && counts.scheduled > 0);
        const cancelBtn = statusKey === "sending"
          ? `<button type="button" data-schedule-action="cancel" data-batch-id="${escapeAttr(String(b.id))}" aria-label="取消批次 #${escapeAttr(String(b.id))}">取消</button>`
          : "";
        const activateBtn = scheduleBatchIsDryRun(b)
          ? `<button type="button" data-schedule-action="activate-dry-run" data-batch-id="${escapeAttr(String(b.id))}" aria-label="把本地预演批次 #${escapeAttr(String(b.id))} 正式排到 TG">排到 TG</button>`
          : "";
        const retryBtn = counts.failed > 0 && statusKey !== "sending" && statusKey !== "deleted"
          ? `<button type="button" data-schedule-action="retry-failed" data-batch-id="${escapeAttr(String(b.id))}" aria-label="重排批次 #${escapeAttr(String(b.id))} 的待重排项">重排待处理</button>`
          : "";
        return `
          <article class="account-row" data-schedule-batch-id="${escapeAttr(String(b.id))}">
            <span class="account-row-dot ${statusKey === "sending" ? "live" : counts.failed ? "warn" : counts.scheduled ? "live" : "idle"}" aria-hidden="true"></span>
            <div class="account-row-body">
              <div class="account-row-title">
                <strong>${escapeHtml(b.label || b.preset_key)}</strong>
                ${statusPill}
                <span class="account-row-meta">send_as ${escapeHtml(String(b.send_as_id || ""))}｜${escapeHtml(b.anchor_text || "")}｜${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}｜${escapeHtml(String(b.horizon_days || ""))} 天｜${escapeHtml(statusText)}</span>
              </div>
              ${showProgress ? `<div class="schedule-progress"><div class="schedule-progress-bar" style="width:${pct}%"></div></div>` : ""}
              <ul class="schedule-item-list">${items || '<li><small>没有待展示命令</small></li>'}</ul>
            </div>
            <div class="account-row-actions">
              ${cancelBtn}
              ${activateBtn}
              ${retryBtn}
              <button type="button" data-schedule-action="delete" data-batch-id="${escapeAttr(String(b.id))}" aria-label="删除批次 #${escapeAttr(String(b.id))}">删除</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  // 排前预检: 配额(已排/100) + 撞分冲突 + 未来时间线。纯预览, 不改发送出口。
  const SCHEDULE_MAX_PER_IDENTITY = 100; // = backend MAX_SCHEDULED_MESSAGES_PER_IDENTITY

  function scheduleQuotaConflictHtml(deps, payload, result, batches) {
    const items = result.items || [];
    if (!items.length) return "";
    const ids = (payload.send_as_ids && payload.send_as_ids.length)
      ? payload.send_as_ids
      : (payload.send_as_id ? [payload.send_as_id] : []);
    const rows = ids.map((id) => {
      const mine = (batches || []).filter((b) => Number(b.send_as_id) === Number(id));
      const existingCount = mine.reduce((n, b) => n + Number((b.counts || {}).scheduled || 0), 0);
      const existingTimes = new Set(
        mine.flatMap((b) => (b.items || []).filter((it) => it.status === "scheduled").map((it) => it.schedule_text))
      );
      const total = existingCount + items.length;
      const over = total > SCHEDULE_MAX_PER_IDENTITY;
      const hits = items.filter((it) => it.schedule_text && existingTimes.has(it.schedule_text));
      const label = scheduleIdentityLabel(deps, id) || `身份 ${id}`;
      const hitNote = hits.length
        ? ` · ⚠ ${hits.length} 条与已排撞分: ${hits.slice(0, 3).map((h) => escapeHtml(h.schedule_text)).join("、")}${hits.length > 3 ? "…" : ""}`
        : "";
      return `<div class="modal-status-line ${over || hits.length ? "warn" : "info"}" style="margin:2px 0">`
        + `<strong>${escapeHtml(label)}</strong>: 已排 ${existingCount}/${SCHEDULE_MAX_PER_IDENTITY} · 本批 +${items.length} → `
        + `<b>${total}/${SCHEDULE_MAX_PER_IDENTITY}</b>${over ? " ⚠ 超额(会被拦/失败)" : ""}${hitNote}</div>`;
    }).join("");
    const byDay = new Map();
    for (const it of items) {
      const parts = String(it.schedule_text || "").split(" ");
      const day = parts[0] || "?";
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(parts[1] || String(it.schedule_text || ""));
    }
    const timeline = Array.from(byDay.entries())
      .map(([day, times]) => `<li><strong>${escapeHtml(day)}</strong> <span class="status-pill">${times.length}</span> <small>${times.map((t) => escapeHtml(t)).join(" · ")}</small></li>`)
      .join("");
    const multiNote = ids.length > 1
      ? `<small class="muted">多身份:配额按各身份分别校验;撞分/时间线按基准时间(首身份,其余按阶梯偏移错开)。</small>`
      : "";
    return `
      <div class="schedule-preview-extras" style="margin-top:8px">
        ${rows}
        <p class="muted" style="margin:6px 0 2px">未来时间线(${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}｜${byDay.size} 天):</p>
        <ul class="send-as-result-list">${timeline}</ul>
        ${multiNote}
      </div>
    `;
  }

  function scheduleRefillStatusView(status, hasItems = false) {
    const key = String(status || "").trim();
    if (hasItems || key === "ready") return { label: "可追加", tone: "ok" };
    if (key === "ready_with_warning") return { label: "证据告警", tone: "warn" };
    if (key === "manual_only") return { label: "需人工", tone: "warn" };
    if (key === "high_frequency") return { label: "高频阻断", tone: "warn" };
    if (key === "quota_capped") return { label: "额度截止", tone: "warn" };
    if (key === "filtered") return { label: "已过滤", tone: "" };
    if (key === "disabled") return { label: "已停用", tone: "" };
    if (key === "already_scheduled") return { label: "已存在", tone: "ok" };
    if (key === "no_items") return { label: "无新增", tone: "" };
    return { label: key || "未知", tone: key ? "warn" : "" };
  }

  function renderScheduleRefillPreview(deps = {}, result = {}) {
    const items = result.items || [];
    const tasks = result.tasks || [];
    const sect = String(result.sect || "").trim() || "宗门未知";
    const identity = scheduleIdentityLabel(deps, result.send_as_id) || `send_as ${result.send_as_id || ""}`;
    const summary = [
      ["身份", identity],
      ["宗门", sect],
      ["TG 当前", `${Number(result.current_usage || result.tg_current_count || 0)}/${Number(result.soft_limit || 0) || 100}`],
      ["拟追加", `${Number(result.planned_count || items.length || 0)} 条`],
      ["窗口", `${Number(result.coverage_days || 0) || 2} 天`],
      ["覆盖到", result.coverage_until_text || ""],
      ["剩余额度", String(result.remaining_after_preview ?? "")],
      ["模式", result.read_only ? "只读预览" : "可执行"],
    ];
    const notes = (result.notes || [])
      .map((note) => `<li><small>${escapeHtml(note)}</small></li>`)
      .join("");
    const timeline = scheduleRefillTimelineHtml(items);
    const blockedTasks = tasks.filter((task) => !(task.items || []).length);
    const taskRows = tasks.map((task) => renderScheduleRefillTaskRow(task)).join("");
    const skipped = (result.skipped_tasks || [])
      .map((task) => `<li class="warn"><small>#${escapeHtml(String(task.index ?? ""))} ${escapeHtml(task.reason || "")}</small></li>`)
      .join("");
    return `
      <div class="schedule-refill-preview">
        <div class="schedule-refill-summary schedule-density-grid">
          ${summary.map(([label, value]) => `
            <span>
              <small>${escapeHtml(label)}</small>
              <strong>${escapeHtml(String(value || "—"))}</strong>
            </span>
          `).join("")}
        </div>
        ${notes ? `<ul class="send-as-result-list schedule-refill-notes">${notes}</ul>` : ""}
        <div class="schedule-refill-subhead">
          <strong>拟追加项</strong>
          <small>高水位之后 append-only,不改 TG 现有定时。</small>
        </div>
        ${timeline}
        <div class="schedule-refill-subhead">
          <strong>任务核对</strong>
          <small>命令高水位、状态机锚点和过滤/阻断原因。</small>
        </div>
        <div class="schedule-refill-task-list">${taskRows || '<p class="empty inline">没有可核对任务。</p>'}</div>
        ${blockedTasks.length ? `<p class="muted">被过滤或阻断 ${escapeHtml(String(blockedTasks.length))} 项,未进入拟追加清单。</p>` : ""}
        ${skipped ? `<p><strong>配置跳过</strong></p><ul class="send-as-result-list">${skipped}</ul>` : ""}
      </div>
    `;
  }

  function scheduleRefillTimelineHtml(items = []) {
    if (!items.length) {
      return '<ul class="send-as-result-list"><li>(0 条)</li></ul>';
    }
    const byDay = new Map();
    for (const item of items) {
      const parts = String(item.schedule_text || "").split(" ");
      const day = parts[0] || "?";
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
    }
    return `
      <ul class="send-as-result-list">
        ${Array.from(byDay.entries()).map(([day, rows]) => `
          <li class="ok">
            <strong>${escapeHtml(day)}</strong>
            <span class="status-pill">${escapeHtml(String(rows.length))}</span>
            <small>${rows.slice(0, 8).map((row) => `${escapeHtml(String(row.schedule_text || "").split(" ")[1] || row.schedule_text || "")} ${escapeHtml(row.command || "")}`).join(" · ")}${rows.length > 8 ? " · ..." : ""}</small>
          </li>
        `).join("")}
      </ul>
    `;
  }

  function renderScheduleRefillTaskRow(task = {}) {
    const items = task.items || [];
    const status = scheduleRefillStatusView(task.status, items.length > 0);
    const highWater = [
      task.cloud_high_water_at ? `TG ${task.cloud_high_water_text || ""}` : "TG 无",
      task.local_high_water_at ? `本地 ${task.local_high_water_text || ""}` : "",
      task.state_next_at ? `状态机 ${task.state_next_text || ""}` : "",
    ].filter(Boolean).join("｜");
    const cd = task.cd_seconds ? `CD ${Math.round(Number(task.cd_seconds || 0) / 60)}min` : "单次";
    const evidence = task.state_contract ? scheduleRenewEvidenceText(task.state_contract) : "";
    const reason = task.reason || (task.warnings || [])[0] || "";
    return `
      <article class="schedule-refill-task ${escapeAttr(status.tone || "")}">
        <div class="schedule-refill-task-head">
          <strong><code>${escapeHtml(task.command || "")}</code></strong>
          <span class="status-pill ${escapeAttr(status.tone)}">${escapeHtml(status.label)}</span>
          <small>${escapeHtml(task.sect || "通用")}｜${escapeHtml(task.module_key || "无状态机")}｜${escapeHtml(cd)}</small>
        </div>
        <p class="muted">${escapeHtml(task.usage || "")}${task.usage && highWater ? "｜" : ""}${escapeHtml(highWater)}</p>
        ${evidence ? `<p class="muted">证据 ${escapeHtml(evidence)}</p>` : ""}
        ${reason ? `<small class="${status.tone === "ok" ? "muted" : "warn"}">${escapeHtml(reason)}</small>` : ""}
        ${items.length ? `<ul class="schedule-item-list">${items.slice(0, 6).map((item) => `<li><code>${escapeHtml(item.command || "")}</code><small>${escapeHtml(item.schedule_text || "")}</small><small>${escapeHtml(item.source || "")}</small></li>`).join("")}${items.length > 6 ? `<li><small>另有 ${escapeHtml(String(items.length - 6))} 条</small></li>` : ""}</ul>` : ""}
      </article>
    `;
  }

  function scheduleStatusText(statusKey, counts) {
    const c = counts || {};
    const total = (c.planned || 0) + (c.scheduled || 0) + (c.failed || 0) + (c.expired || 0);
    const done = (c.scheduled || 0) + (c.expired || 0);
    if (statusKey === "dry_run") return `仅本地预演 ${c.planned || total || 0} 条`;
    if (statusKey === "sending") return `发送中 ${done}/${total}${c.failed ? `（${c.failed} 待重排）` : ""}`;
    if (statusKey === "completed") return `已完成 ${(c.scheduled || 0) + (c.expired || 0)}/${total}`;
    if (statusKey === "expired") return `已过期 ${c.expired || 0}/${total}`;
    if (statusKey === "needs_retry" || statusKey === "partial_failed") {
      const parts = [];
      if (c.scheduled) parts.push(`${c.scheduled} 已排`);
      if (c.planned) parts.push(`${c.planned} 待排`);
      if (c.failed) parts.push(`${c.failed} 待重排`);
      if (c.expired) parts.push(`${c.expired} 已过期`);
      return parts.join("｜") || `待重排 ${c.failed || 0}/${total}`;
    }
    if (statusKey === "failed") return `待重排 ${c.failed || 0}/${total}`;
    if (statusKey === "cancelled") return `已取消 (排到 ${c.scheduled || 0}/${total})`;
    return `${c.scheduled || 0}/${total} 已排`;
  }

  function scheduleStatusPill(statusKey) {
    if (statusKey === "sending") return `<span class="status-pill warn">后台排定时</span>`;
    if (statusKey === "dry_run") return `<span class="status-pill">本地预演</span>`;
    if (statusKey === "completed") return `<span class="status-pill ok">完成</span>`;
    if (statusKey === "expired") return `<span class="status-pill">已过期</span>`;
    if (statusKey === "needs_retry" || statusKey === "partial_failed") return `<span class="status-pill warn">待重排</span>`;
    if (statusKey === "failed") return `<span class="status-pill warn">待重排</span>`;
    if (statusKey === "cancelled") return `<span class="status-pill">已取消</span>`;
    return "";
  }

  function scheduleDisplayStatusKey(statusKey, counts) {
    const c = counts || {};
    const total = (c.planned || 0) + (c.scheduled || 0) + (c.failed || 0) + (c.expired || 0);
    if (total > 0 && (c.expired || 0) === total) return "expired";
    if ((c.failed || 0) > 0 && statusKey !== "sending") return "needs_retry";
    return statusKey || "active";
  }

  function scheduleCurrentCounts(counts) {
    const c = counts || {};
    return {
      planned: Number(c.planned || 0),
      scheduled: Number(c.scheduled || 0),
      failed: Number(c.failed || 0),
      expired: 0,
      deleted: Number(c.deleted || 0),
    };
  }

  function scheduleBatchIsDryRun(batch) {
    return Boolean(batch?.options?.dry_run || batch?.status === "dry_run");
  }

  function scheduleBatchHasCurrentWork(batch) {
    if (scheduleBatchIsDryRun(batch)) return false;
    if (batch?.status === "sending") return true;
    const c = scheduleCurrentCounts(batch?.counts || {});
    return (c.planned + c.scheduled + c.failed) > 0;
  }

  function scheduleMessageHasCurrentWork(message) {
    const status = String(message?.status || "planned");
    return status !== "expired" && status !== "deleted";
  }

  function scheduleMessageStatusView(message) {
    const status = String(message?.status || "");
    const rawError = String(message?.last_error || "").trim();
    if (status === "scheduled") {
      return { pill: `<span class="status-pill ok">已排</span>`, note: "", noteClass: "" };
    }
    if (status === "failed") {
      return {
        pill: `<span class="status-pill warn">待重排</span>`,
        note: compactScheduleError(rawError),
        noteClass: "warn",
      };
    }
    if (status === "expired") {
      return {
        pill: `<span class="status-pill">已过期</span>`,
        note: compactScheduleExpiredNote(rawError),
        noteClass: "muted",
      };
    }
    if (status === "deleted") {
      return { pill: `<span class="status-pill">已删除</span>`, note: "", noteClass: "" };
    }
    return { pill: `<span class="status-pill">待排</span>`, note: "", noteClass: "" };
  }

  function compactScheduleExpiredNote(text) {
    if (!text) return "";
    if (text.includes("TG 待发送列表已无该项") && text.includes("计划时间已过")) {
      return "已从 TG 待发送列表释放";
    }
    return text;
  }

  function compactScheduleError(text) {
    if (!text) return "";
    if (text.includes("cannot schedule more messages") || text.includes("官方定时触发单身份上限") || text.includes("单身份上限")) {
      return "官方定时额度已满，需清理旧定时或点击重排";
    }
    return text;
  }

  function scheduleManualMessages(result) {
    const messages = [];
    const push = (item) => {
      if (!item || (!item.manual_required && item.status !== "quota_blocked")) return;
      const text = item.manual_message || item.error || "官方定时已触发上限,请手动处理旧定时。";
      if (text && !messages.includes(text)) messages.push(text);
    };
    push(result);
    (result?.results || []).forEach(push);
    return messages;
  }

  function scheduleStatusWithManualMessages(baseText, manualMessages) {
    const messages = (manualMessages || []).filter(Boolean);
    if (!messages.length) return baseText || "";
    const detail = messages.map((text, index) => `${index + 1}. ${text}`).join("\n\n");
    return `${baseText || "官方定时需要手动处理"}\n需手动处理 ${messages.length} 条:\n${detail}`;
  }

  function scheduleEstimateText(seconds) {
    const n = Number(seconds || 0);
    if (!Number.isFinite(n) || n <= 0) return "约 0 秒";
    if (n < 60) return `约 ${Math.ceil(n)} 秒`;
    return `约 ${Math.ceil(n / 60)} 分钟`;
  }

  function findScheduleContract(scheduleModules, sendAsId, moduleKey) {
    const sid = Number(sendAsId || 0);
    const key = String(moduleKey || "").trim();
    if (!sid || !key) return null;
    const group = (scheduleModules?.by_identity || []).find((item) => Number(item.send_as_id || 0) === sid);
    return (group?.items || []).find((item) => item.module_key === key) || null;
  }

  function findModuleCatalog(scheduleModules, moduleKey) {
    const key = String(moduleKey || "").trim();
    return (scheduleModules?.modules || []).find((item) => item.key === key) || null;
  }

  function scheduleContractHtml(contract, catalog = null) {
    if (!contract && !catalog) return "";
    const source = contract || {
      label: catalog?.label || catalog?.key || "",
      module_key: catalog?.key || "",
      summary: { text: "该身份暂无状态记录" },
      suggestion: catalog?.suggestion || {},
      warnings: [{ severity: "risk", message: "未观测到该身份的机器人回复" }],
      semiauto_ready: false,
      one_click_ready: false,
      confidence: "unknown",
      tianjige: catalog?.tianjige || null,
    };
    const suggestion = source.suggestion || {};
    const warnings = source.warnings || [];
    const tianjige = source.tianjige || null;
    const moduleContract = source.module_contract || {};
    const evidence = source.evidence || {};
    const tianjigeText = tianjige
      ? `天机阁 API ${tianjige.enabled ? (tianjige.mode || "on") : "off"}｜${tianjige.authenticated ? "已认证" : "未认证"}${tianjige.profile_available ? `｜资料已刷新 ${tianjige.profile_updated_at || ""}` : "｜资料未刷新"}${tianjige.message ? `｜${tianjige.message}` : ""}`
      : "";
    const tianjigeKeys = tianjige?.profile_keys?.length
      ? `<small>${escapeHtml(tianjige.profile_keys.slice(0, 6).join("、"))}</small>`
      : "";
    const warnHtml = warnings.length
      ? `<ul class="send-as-result-list">${warnings.map((w) => `<li class="${w.severity === "risk" ? "warn" : "ok"}"><small>${escapeHtml(w.message || w.code || "")}</small></li>`).join("")}</ul>`
      : '<p class="muted">当前没有阻断告警。</p>';
    const command = suggestion.command || suggestion.base_command || "";
    const familyText = evidence.latest_family || (moduleContract.reply_families || [])[0] || "";
    const evidenceText = [
      moduleContract.readiness ? `样本 ${moduleContract.readiness}` : "",
      moduleContract.send_policy ? `策略 ${moduleContract.send_policy}` : "",
      familyText ? `family ${familyText}` : "",
      evidence.latest_reason ? `最近 ${evidence.latest_reason}` : "",
    ].filter(Boolean).join("｜");
    return `
      <p>
        <strong>${escapeHtml(source.label || source.module_key || "")}</strong>
        <span class="status-pill ${source.semiauto_ready ? "ok" : "warn"}">${source.semiauto_ready ? "可半自动" : "需确认"}</span>
        <small>${escapeHtml(source.summary?.text || "")}</small>
      </p>
      <p class="muted">起点 ${escapeHtml(source.next_at ? "状态机 next_at" : "未确定")}｜置信 ${escapeHtml(source.confidence || "unknown")}｜建议 <code>${escapeHtml(command)}</code>${suggestion.interval_sec ? `｜间隔 ${escapeHtml(String(suggestion.interval_sec))}s` : ""}</p>
      ${evidenceText ? `<p class="muted">${escapeHtml(evidenceText)}</p>` : ""}
      ${tianjigeText ? `<p class="muted">${escapeHtml(tianjigeText)} ${tianjigeKeys}</p>` : ""}
      ${warnHtml}
    `;
  }

  function applyScheduleSuggestionToForm(form, contract, catalog = null) {
    const suggestion = (contract?.suggestion || catalog?.suggestion || {});
    const payloadDefaults = suggestion.payload_defaults || contract?.payload_defaults || {};
    if (!suggestion || !Object.keys(suggestion).length) return false;
    const setValue = (name, value, { overwrite = true } = {}) => {
      const field = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (!field || value === undefined || value === null || value === "") return;
      if (!overwrite && String(field.value || "").trim()) return;
      field.value = String(value);
    };
    setValue("preset_key", payloadDefaults.preset_key || suggestion.preset_key || "custom");
    setValue("command", payloadDefaults.command || suggestion.command || suggestion.base_command || "", { overwrite: true });
    setValue("interval_sec", payloadDefaults.interval_sec || suggestion.interval_sec || "", { overwrite: true });
    setValue("count", payloadDefaults.count || suggestion.count || "", { overwrite: true });
    setValue("horizon_days", payloadDefaults.horizon_days || suggestion.horizon_days || "", { overwrite: false });
    setValue("trigger_command", payloadDefaults.trigger_command || suggestion.trigger_command || "", { overwrite: true });
    Object.entries(payloadDefaults).forEach(([key, value]) => {
      if (!["preset_key", "command", "interval_sec", "count", "horizon_days", "trigger_command"].includes(key)) {
        setValue(key, value, { overwrite: true });
      }
    });
    if (suggestion.arg_payload_key && suggestion.arg_value) {
      setValue(suggestion.arg_payload_key, suggestion.arg_value, { overwrite: true });
    }
    const autoAnchor = form.querySelector('[name="auto_anchor"]');
    if (autoAnchor) autoAnchor.checked = true;
    const useDefaults = form.querySelector('[name="schedule_use_module_defaults"]');
    if (useDefaults) useDefaults.checked = true;
    return true;
  }

  function bindScheduleModal(deps = {}, dialog, presets, _initialBatches, initialTemplates, scheduleModules = {}) {
    const form = dialog.querySelector("#scheduleForm");
    const status = dialog.querySelector("#scheduleStatus");
    const preview = dialog.querySelector("#schedulePreview");
    const previewShell = dialog.querySelector("#schedulePreviewShell");
    const previewSummary = dialog.querySelector("#schedulePreviewSummary");
    const refillForm = dialog.querySelector("#scheduleRefillForm");
    const refillStatus = dialog.querySelector("#scheduleRefillStatus");
    const refillPreview = dialog.querySelector("#scheduleRefillPreview");
    const refillPreviewButton = dialog.querySelector("#scheduleRefillPreviewButton");
    const refillRunButton = dialog.querySelector("#scheduleRefillRunButton");
    const refillSendAsSelect = dialog.querySelector("#scheduleRefillSendAsSelect");
    const batchList = dialog.querySelector("#scheduleBatchList");
    const syncButton = dialog.querySelector("#scheduleSyncButton");
    const syncRepairButton = dialog.querySelector("#scheduleSyncRepairButton");
    const syncSelect = dialog.querySelector("#scheduleSyncSelect");
    const syncStatus = dialog.querySelector("#scheduleSyncStatus");
    const syncResult = dialog.querySelector("#scheduleSyncResult");
    const templateSelect = dialog.querySelector("#scheduleTemplateSelect");
    const templateName = dialog.querySelector("#scheduleTemplateName");
    const templateStatus = dialog.querySelector("#scheduleTemplateStatus");
    const templateLoadButton = dialog.querySelector("#scheduleTemplateLoadButton");
    const templateSaveButton = dialog.querySelector("#scheduleTemplateSaveButton");
    const templateDeleteButton = dialog.querySelector("#scheduleTemplateDeleteButton");
    const renewForm = dialog.querySelector("#scheduleRenewForm");
    const renewStatus = dialog.querySelector("#scheduleRenewStatus");
    const renewPreview = dialog.querySelector("#scheduleRenewPreview");
    const renewProfileList = dialog.querySelector("#scheduleRenewProfileList");
    const renewWorkerStatus = dialog.querySelector("#scheduleRenewWorkerStatus");
    const renewOverview = dialog.querySelector("#scheduleRenewOverview");
    const renewSendAsSelect = dialog.querySelector("#scheduleRenewSendAsSelect");
    const renewPresetSelect = dialog.querySelector("#scheduleRenewPresetSelect");
    const renewModuleSelect = dialog.querySelector("#scheduleRenewModuleSelect");
    const renewNewButton = dialog.querySelector("#scheduleRenewNewButton");
    const renewSaveButton = dialog.querySelector("#scheduleRenewSaveButton");
    const renewPreviewButton = dialog.querySelector("#scheduleRenewPreviewButton");
    const renewRunButton = dialog.querySelector("#scheduleRenewRunButton");
    const stateModuleSelect = dialog.querySelector("#scheduleStateModuleSelect");
    const stateHint = dialog.querySelector("#scheduleStateHint");
    const applyStateSuggestionButton = dialog.querySelector("#scheduleApplyStateSuggestion");
    const planWorkbench = dialog.querySelector("#schedulePlanWorkbench");
    const accountPickerList = dialog.querySelector("#scheduleAccountPickerList");
    const identitySummary = dialog.querySelector("#scheduleIdentitySummary");
    const identityScope = dialog.querySelector("#scheduleIdentityScope");
    const useActiveIdentityButton = dialog.querySelector("#scheduleUseActiveIdentityButton");
    const selectAllIdentityButton = dialog.querySelector("#scheduleSelectAllIdentityButton");
    const setChatIdentityButton = dialog.querySelector("#scheduleSetChatIdentityButton");
    const clearIdentityButton = dialog.querySelector("#scheduleClearIdentityButton");
    if (!form) return null;
    const presetMap = new Map(presets.map((p) => [p.key, p]));
    let templates = Array.isArray(initialTemplates) ? [...initialTemplates] : [];
    let lastRefillPreview = null;
    const setStatus = (kind, text) => {
      if (!status) return;
      status.hidden = !text;
      status.className = `modal-status-line ${kind}`;
      status.textContent = text || "";
    };
    dialog._scheduleSetStatus = setStatus;
    const showPreview = (html, summary = "") => {
      if (!preview) return;
      preview.hidden = !html;
      preview.innerHTML = html || "";
      if (previewShell && html) previewShell.open = true;
      if (previewSummary) previewSummary.textContent = summary || (html ? "已生成" : "尚未生成");
    };
    const setRefillStatus = (kind, text) => {
      if (!refillStatus) return;
      refillStatus.hidden = !text;
      refillStatus.className = `modal-status-line ${kind}`;
      refillStatus.textContent = text || "";
    };
    const showRefillPreview = (html) => {
      if (!refillPreview) return;
      refillPreview.hidden = !html;
      refillPreview.innerHTML = html || "";
    };
    const setRenewStatus = (kind, text) => {
      if (!renewStatus) return;
      renewStatus.hidden = !text;
      renewStatus.className = `modal-status-line ${kind}`;
      renewStatus.textContent = text || "";
    };
    const showRenewPreview = (html) => {
      if (!renewPreview) return;
      renewPreview.hidden = !html;
      renewPreview.innerHTML = html || "";
    };
    const updateRenewWorkerStatus = (worker) => {
      if (!renewWorkerStatus) return;
      renewWorkerStatus.innerHTML = renderScheduleRenewWorkerStatus(worker || null);
    };
    const updateFieldVisibility = () => {
      const key = form.querySelector('[name="preset_key"]').value;
      const required = new Set(presetMap.get(key)?.fields || []);
      form.querySelectorAll("[data-show-when]").forEach((label) => {
        const fieldName = label.dataset.showWhen;
        label.style.display = required.has(fieldName) ? "" : "none";
      });
      const commandGroupEditor = form.querySelector("#scheduleCommandGroupEditor");
      if (commandGroupEditor) {
        commandGroupEditor.hidden = !["command", "interval_sec", "count", "command_gap_sec"].some((field) => required.has(field));
      }
    };
    const presetSelect = form.querySelector('[name="preset_key"]');
    updateFieldVisibility();
    let renewProfiles = [];
    let renewWorker = null;
    let renewAllowedPresets = [];

    const selectedPrimarySendAs = () => {
      const select = dialog.querySelector("#scheduleSendAsSelect");
      return Number(select?.selectedOptions?.[0]?.value || 0);
    };
    const refreshPlanWorkbench = () => {
      if (!planWorkbench) return;
      planWorkbench.innerHTML = renderSchedulePlanWorkbench(deps, {
        presets,
        scheduleModules,
        selectedSendAsId: selectedPrimarySendAs(),
      });
      bindSchedulePlanWorkbenchActions();
      setPlanWorkbenchActive(String(presetSelect?.value || ""));
    };
    const updateRenewOverview = () => {
      if (!renewOverview) return;
      renewOverview.innerHTML = renderScheduleRenewOverview(deps, {
        profiles: renewProfiles,
        allowedPresets: renewAllowedPresets,
        presetMap,
        scheduleModules,
        selectedSendAsId: Number(renewSendAsSelect?.value || selectedPrimarySendAs() || 0),
      });
      bindRenewOverviewActions();
    };
    const refillPrimarySendAs = () => Number(refillSendAsSelect?.value || selectedPrimarySendAs() || 0);
    const collectRefillPayload = () => {
      if (!refillForm) return {};
      const data = new FormData(refillForm);
      return {
        send_as_id: Number(data.get("send_as_id") || refillPrimarySendAs() || 0),
        coverage_days: data.get("coverage_days") || 2,
        lead_sec: data.get("lead_sec") || 300,
        offset_sec: data.get("offset_sec") || 180,
        soft_limit: data.get("soft_limit") || 95,
      };
    };
    const renderRefillPreview = (result) => {
      lastRefillPreview = result || null;
      showRefillPreview(renderScheduleRefillPreview(deps, result || {}));
      const statusKind = result?.ok === false
        ? "error"
        : (result?.manual_required || (result?.tasks || []).some((task) => ["manual_only", "high_frequency", "filtered", "disabled"].includes(String(task?.status || ""))))
          ? "warn"
          : "ok";
      const statusText = result?.ok === false
        ? (result.error || "补货预览失败")
        : `拟追加 ${Number(result.planned_count || 0)} 条｜${result.coverage_until_text || "未覆盖"}`;
      setRefillStatus(statusKind, statusText);
      return result;
    };
    const refreshModalBatchesAfterScheduleChange = async () => {
      const refreshed = await fetchJson("/api/schedule?history=0");
      if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
      bindScheduleBatchActions(deps, dialog, setStatus);
      return refreshed;
    };
    const selectedStateModule = () => String(stateModuleSelect?.value || "").trim();
    const matchedModuleForPreset = () => {
      const key = String(presetSelect?.value || "").trim();
      return String(presetMap.get(key)?.module_key || "").trim();
    };
    const syncStateModuleToPreset = ({ onlyIfEmpty = false } = {}) => {
      const moduleKey = matchedModuleForPreset();
      if (!stateModuleSelect) return false;
      const autoAnchor = form.querySelector('[name="auto_anchor"]');
      const clearStaleModule = () => {
        if (onlyIfEmpty) return false;
        stateModuleSelect.value = "";
        if (autoAnchor) autoAnchor.checked = false;
        return false;
      };
      if (!moduleKey) return clearStaleModule();
      if (onlyIfEmpty && stateModuleSelect.value) return false;
      const option = Array.from(stateModuleSelect.options).find((item) => item.value === moduleKey);
      if (!option) return clearStaleModule();
      stateModuleSelect.value = moduleKey;
      if (autoAnchor) autoAnchor.checked = true;
      return true;
    };
    const renderStateHint = () => {
      if (!stateHint) return;
      const moduleKey = selectedStateModule();
      if (!moduleKey) {
        stateHint.hidden = true;
        stateHint.innerHTML = "";
        return;
      }
      const contract = findScheduleContract(scheduleModules, selectedPrimarySendAs(), moduleKey);
      const catalog = findModuleCatalog(scheduleModules, moduleKey);
      const catalogWithStatus = catalog ? { ...catalog, tianjige: scheduleModules.tianjige || null } : null;
      stateHint.hidden = false;
      stateHint.innerHTML = scheduleContractHtml(contract, catalogWithStatus);
    };
    const setPlanWorkbenchActive = (presetKey = "") => {
      if (!planWorkbench) return;
      planWorkbench.querySelectorAll("[data-schedule-plan-preset]").forEach((button) => {
        const active = Boolean(presetKey) && String(button.dataset.schedulePlanPreset || "") === String(presetKey || "");
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    };
    const applyPresetShortcut = (presetKey = "", moduleKey = "") => {
      const key = String(presetKey || "").trim();
      if (!key || !presetMap.has(key)) {
        setStatus("warn", "这个方案还不能直接排官方定时。");
        return false;
      }
      if (presetSelect) presetSelect.value = key;
      updateFieldVisibility();
      const explicitModule = String(moduleKey || "").trim();
      if (stateModuleSelect) {
        if (explicitModule && Array.from(stateModuleSelect.options).some((option) => option.value === explicitModule)) {
          stateModuleSelect.value = explicitModule;
          const autoAnchor = form.querySelector('[name="auto_anchor"]');
          if (autoAnchor) autoAnchor.checked = true;
        } else {
          syncStateModuleToPreset();
        }
      }
      const useDefaults = form.querySelector('[name="schedule_use_module_defaults"]');
      if (useDefaults) useDefaults.checked = true;
      setPlanWorkbenchActive(key);
      renderStateHint();
      const preset = presetMap.get(key);
      setStatus("ok", `已套用方案: ${preset?.label || key}`);
      return true;
    };
    const applyCustomExample = (exampleKey = "") => {
      const example = SCHEDULE_CUSTOM_EXAMPLES.find((item) => item.key === exampleKey);
      if (!example || !presetMap.has("custom")) return false;
      if (presetSelect) presetSelect.value = "custom";
      const setValue = (name, value) => {
        const field = form.querySelector(`[name="${CSS.escape(name)}"]`);
        if (field) field.value = String(value ?? "");
      };
      setValue("command", example.command);
      setValue("interval_sec", example.interval_sec);
      setValue("count", example.count);
      setValue("command_gap_sec", example.command_gap_sec);
      const autoAnchor = form.querySelector('[name="auto_anchor"]');
      if (autoAnchor) autoAnchor.checked = false;
      const useDefaults = form.querySelector('[name="schedule_use_module_defaults"]');
      if (useDefaults) useDefaults.checked = false;
      if (stateModuleSelect) stateModuleSelect.value = "";
      updateFieldVisibility();
      setPlanWorkbenchActive("custom");
      renderStateHint();
      setStatus("ok", `已套用联动模板: ${example.label}`);
      return true;
    };
    function bindSchedulePlanWorkbenchActions() {
      if (!planWorkbench) return;
      planWorkbench.querySelectorAll("[data-schedule-plan-preset]").forEach((button) => {
        if (button.dataset.bound === "1") return;
        button.dataset.bound = "1";
        button.addEventListener("click", () => {
          if (button.dataset.schedulePlanBlocked === "1") {
            setStatus("warn", "这个状态机暂时只能作为参考,需要先补观察或手动自定义。");
            return;
          }
          applyPresetShortcut(button.dataset.schedulePlanPreset || "", button.dataset.schedulePlanModule || "");
        });
      });
      planWorkbench.querySelectorAll("[data-schedule-custom-example]").forEach((button) => {
        if (button.dataset.bound === "1") return;
        button.dataset.bound = "1";
        button.addEventListener("click", () => {
          applyCustomExample(button.dataset.scheduleCustomExample || "");
        });
      });
    }
    if (presetSelect) {
      presetSelect.addEventListener("change", () => {
        updateFieldVisibility();
        syncStateModuleToPreset();
        renderStateHint();
        setPlanWorkbenchActive(presetSelect.value);
      });
    }

    const collectPayload = () => {
      const data = new FormData(form);
      const sendAsIds = data.getAll("send_as_ids").map((v) => Number(v)).filter(Boolean);
      const stateModule = String(data.get("auto_anchor_module") || "").trim();
      const payload = {
        send_as_ids: sendAsIds,
        send_as_id: sendAsIds[0] || 0,
        preset_key: data.get("preset_key"),
        pet_name: (data.get("pet_name") || "").trim(),
        horizon_days: data.get("horizon_days") || 3,
        command: (data.get("command") || "").trim(),
        interval_sec: data.get("interval_sec") || 3600,
        count: data.get("count") || 1,
        command_gap_sec: data.get("command_gap_sec") || 180,
        dry_run: data.get("dry_run") === "on",
        auto_anchor: data.get("auto_anchor") === "on",
        schedule_use_module_defaults: data.get("schedule_use_module_defaults") === "on",
        schedule_semiauto: data.get("schedule_semiauto") === "on",
        trigger_command: (data.get("trigger_command") || "").trim(),
        offset_minutes: data.get("offset_minutes") || 0,
        offset_step_minutes: data.get("offset_step_minutes") || 5,
      };
      if (payload.auto_anchor) {
        payload.auto_anchor_module = stateModule || data.get("preset_key");
      } else if (stateModule) {
        payload.state_module_key = stateModule;
      }
      const anchorText = data.get("anchor_at_text");
      if (anchorText) {
        const parsed = parseScheduleShanghaiLocalTimestamp(String(anchorText));
        if (parsed !== null) {
          payload.anchor_at = parsed;
        }
      }
      return payload;
    };

    const syncRenewModuleToPreset = () => {
      if (!renewPresetSelect || !renewModuleSelect) return;
      const moduleKey = scheduleRenewModuleForPreset(renewPresetSelect.value);
      if (!moduleKey) return;
      const option = Array.from(renewModuleSelect.options).find((item) => item.value === moduleKey);
      if (option) renewModuleSelect.value = moduleKey;
    };

    const markRenewFormAsDraft = () => {
      if (!renewForm) return;
      const idField = renewForm.querySelector('[name="id"]');
      if (idField && idField.value) idField.value = "";
      showRenewPreview("");
      updateRenewOverview();
    };

    const resetRenewForm = () => {
      if (!renewForm) return;
      renewForm.reset();
      const idField = renewForm.querySelector('[name="id"]');
      if (idField) idField.value = "";
      if (renewSendAsSelect) {
        const selected = selectedPrimarySendAs();
        if (selected && Array.from(renewSendAsSelect.options).some((option) => Number(option.value || 0) === selected)) {
          renewSendAsSelect.value = String(selected);
        }
      }
      syncRenewModuleToPreset();
      showRenewPreview("");
      setRenewStatus("info", "");
      updateRenewOverview();
    };

    const collectRenewPayload = () => {
      if (!renewForm) return {};
      const data = new FormData(renewForm);
      const presetKey = String(data.get("preset_key") || "").trim();
      const moduleKey = String(data.get("module_key") || scheduleRenewModuleForPreset(presetKey) || "").trim();
      const sendAsId = Number(data.get("send_as_id") || 0);
      return {
        id: Number(data.get("id") || 0) || 0,
        send_as_id: sendAsId,
        preset_key: presetKey,
        module_key: moduleKey,
        renew_days: data.get("renew_days") || 1,
        threshold_hours: data.get("threshold_hours") || 24,
        soft_limit: data.get("soft_limit") || 95,
        enabled: data.get("enabled") === "on",
        payload: {
          send_as_id: sendAsId,
          preset_key: presetKey,
          horizon_days: data.get("renew_days") || 1,
          auto_anchor: true,
          auto_anchor_module: moduleKey,
          schedule_use_module_defaults: presetKey === moduleKey,
          schedule_semiauto: true,
          dry_run: false,
        },
      };
    };

    const scheduleRenewPresetPayload = ({ sendAsId, presetKey, moduleKey, enabled = true } = {}) => {
      const renewDays = renewForm?.querySelector('[name="renew_days"]')?.value || 1;
      const thresholdHours = renewForm?.querySelector('[name="threshold_hours"]')?.value || 24;
      const softLimit = renewForm?.querySelector('[name="soft_limit"]')?.value || 95;
      const sid = Number(sendAsId || 0);
      const preset = String(presetKey || "").trim();
      const module = String(moduleKey || scheduleRenewModuleForPreset(preset) || "").trim();
      return {
        send_as_id: sid,
        preset_key: preset,
        module_key: module,
        renew_days: renewDays,
        threshold_hours: thresholdHours,
        soft_limit: softLimit,
        enabled: Boolean(enabled),
        payload: {
          send_as_id: sid,
          preset_key: preset,
          horizon_days: renewDays,
          auto_anchor: true,
          auto_anchor_module: module,
          schedule_use_module_defaults: preset === module,
          schedule_semiauto: true,
          dry_run: false,
        },
      };
    };

    const fillRenewForm = (profile) => {
      if (!renewForm || !profile) return;
      const setValue = (name, value) => {
        const field = renewForm.querySelector(`[name="${CSS.escape(name)}"]`);
        if (!field) return;
        if (field.type === "checkbox") field.checked = Boolean(value);
        else field.value = String(value ?? "");
      };
      setValue("id", profile.id || "");
      setValue("send_as_id", profile.send_as_id || "");
      setValue("preset_key", profile.preset_key || "");
      setValue("module_key", profile.module_key || "");
      setValue("renew_days", profile.renew_days || 1);
      setValue("threshold_hours", profile.threshold_hours || 24);
      setValue("soft_limit", profile.soft_limit || 95);
      setValue("enabled", profile.enabled !== false);
      syncRenewModuleToPreset();
      setRenewStatus("ok", `已载入续期策略 #${profile.id}`);
      updateRenewOverview();
    };

    const renderRenewPlan = (result) => {
      const items = result.items || [];
      const profile = result.profile || {};
      const contractHtml = result.state_contract ? `<div class="schedule-preview-extras">${scheduleContractHtml(result.state_contract)}</div>` : "";
      const statusText = result.status === "not_due"
        ? `覆盖到 ${result.tail_text || "未来"},暂不需要续期`
        : result.status === "quota_capped"
          ? `按软上限裁剪为 ${items.length} 条`
          : result.status === "no_items"
            ? "没有需要补排的未来项"
            : `可续期 ${items.length} 条`;
      return `
        <p><strong>${escapeHtml(profile.label || result.preset_label || "")}</strong>｜${escapeHtml(statusText)}｜${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}｜额度 ${escapeHtml(String(result.current_usage ?? ""))}/${escapeHtml(String(result.soft_limit ?? ""))}</p>
        ${contractHtml}
        <ul class="send-as-result-list">
          ${items.map((it) => `<li class="ok"><code>${escapeHtml(it.command)}</code> <small>${escapeHtml(it.schedule_text || "")}</small></li>`).join("") || "<li>(0 条)</li>"}
        </ul>
      `;
    };

    const refreshRenewProfiles = async () => {
      if (!renewProfileList) return [];
      renewProfileList.innerHTML = '<p class="empty inline">正在读取续期策略...</p>';
      const result = await fetchJson("/api/schedule/renew");
      if (!result.ok) throw new Error(result.error || "读取续期策略失败");
      renewProfiles = result.profiles || [];
      renewWorker = result.worker || null;
      renewAllowedPresets = result.allowed_presets || [];
      updateRenewWorkerStatus(renewWorker);
      updateRenewOverview();
      renewProfileList.innerHTML = renderScheduleRenewProfiles(deps, renewProfiles);
      bindRenewProfileActions();
      return renewProfiles;
    };

    const saveRenewProfile = async () => {
      const payload = collectRenewPayload();
      const result = await postJson("/api/schedule/renew/save", payload);
      if (!result.ok) throw new Error(result.error || "保存续期策略失败");
      renewProfiles = result.profiles || [];
      if (renewProfileList) renewProfileList.innerHTML = renderScheduleRenewProfiles(deps, renewProfiles);
      updateRenewOverview();
      bindRenewProfileActions();
      if (result.profile) fillRenewForm(result.profile);
      return result.profile;
    };

    const previewRenewProfile = async (profileId = 0) => {
      const payload = profileId ? { profile_id: Number(profileId) } : collectRenewPayload();
      if (!profileId) delete payload.id;
      const result = await postJson("/api/schedule/renew/preview", payload);
      if (!result.ok) throw new Error(result.error || "预览续期失败");
      showRenewPreview(renderRenewPlan(result));
      setRenewStatus(result.status === "not_due" || result.status === "no_items" ? "info" : "ok", result.message || `预览续期 ${result.planned_count || 0} 条`);
      return result;
    };

    const runRenewProfile = async (profileId = 0) => {
      let id = Number(profileId || collectRenewPayload().id || 0);
      if (!id) {
        const saved = await saveRenewProfile();
        id = Number(saved?.id || 0);
      }
      if (!id) throw new Error("请先保存续期策略");
      const result = await postJson("/api/schedule/renew/run", { profile_id: id });
      if (!result.ok) throw new Error(result.error || "立即续期失败");
      showRenewPreview(renderRenewPlan(result.renew_plan || result));
      renewProfiles = result.profiles || renewProfiles;
      if (renewProfileList) renewProfileList.innerHTML = renderScheduleRenewProfiles(deps, renewProfiles);
      updateRenewOverview();
      bindRenewProfileActions();
      if (result.status === "not_due" || result.status === "no_items") {
        setRenewStatus("info", result.message || "当前不需要续期");
        return result;
      }
      const estimate = scheduleEstimateText(result.estimate_seconds || 0);
      setRenewStatus("ok", `已提交续期批次 #${result.batch_id}｜${result.planned_count || 0} 条｜预估 ${estimate}`);
      if (result.batch_id) scheduleProgressPolling(deps, dialog, result.batch_id);
      const refreshed = await fetchJson("/api/schedule?history=0");
      if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
      bindScheduleBatchActions(deps, dialog, setStatus);
      return result;
    };

    function bindRenewProfileActions() {
      if (!renewProfileList) return;
      renewProfileList.querySelectorAll("[data-schedule-renew-action]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          const action = btn.dataset.scheduleRenewAction;
          const profileId = Number(btn.dataset.profileId || 0);
          const profile = renewProfiles.find((item) => Number(item.id || 0) === profileId);
          if (action === "load") {
            fillRenewForm(profile);
            return;
          }
          btn.disabled = true;
          const originalText = btn.textContent;
          try {
            if (action === "preview") {
              btn.textContent = "预览中";
              setRenewStatus("info", `预览续期策略 #${profileId}…`);
              await previewRenewProfile(profileId);
            } else if (action === "run") {
              btn.textContent = "续期中";
              setRenewStatus("info", `提交续期策略 #${profileId}…`);
              await runRenewProfile(profileId);
            } else if (action === "delete") {
              if (!window.confirm(`删除续期策略 #${profileId}?`)) return;
              btn.textContent = "删除中";
              const result = await postJson("/api/schedule/renew/delete", { profile_id: profileId });
              if (!result.ok) throw new Error(result.error || "删除续期策略失败");
              renewProfiles = result.profiles || [];
              renewProfileList.innerHTML = renderScheduleRenewProfiles(deps, renewProfiles);
              updateRenewOverview();
              bindRenewProfileActions();
              resetRenewForm();
              setRenewStatus("ok", `已删除续期策略 #${profileId}`);
            }
          } catch (error) {
            setRenewStatus("error", error.message || "续期操作失败");
            window.alert(error.message || "续期操作失败");
          } finally {
            if (btn.isConnected) {
              btn.disabled = false;
              btn.textContent = originalText;
            }
          }
        });
      });
    }

    function bindRenewOverviewActions() {
      if (!renewOverview) return;
      renewOverview.querySelectorAll("[data-schedule-renew-action], [data-schedule-renew-overview-action]").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        const toggleProfile = async () => {
          const profileId = Number(btn.dataset.profileId || 0);
          const action = btn.dataset.scheduleRenewOverviewAction || "";
          if (profileId && action === "toggle-profile") {
            const profile = renewProfiles.find((item) => Number(item.id || 0) === profileId);
            if (!profile) return;
            const nextEnabled = btn.tagName === "BUTTON"
              ? btn.getAttribute("aria-pressed") !== "true"
              : Boolean(btn.checked);
            btn.disabled = true;
            try {
              setRenewStatus("info", `${nextEnabled ? "开启" : "关闭"}续期策略 #${profileId}...`);
              const result = await postJson("/api/schedule/renew/save", scheduleRenewTogglePayload(profile, nextEnabled));
              if (!result.ok) throw new Error(result.error || "切换续期失败");
              renewProfiles = result.profiles || renewProfiles;
              if (renewProfileList) renewProfileList.innerHTML = renderScheduleRenewProfiles(deps, renewProfiles);
              updateRenewOverview();
              bindRenewProfileActions();
              fillRenewForm((renewProfiles || []).find((item) => Number(item.id || 0) === profileId) || profile);
              setRenewStatus("ok", `${nextEnabled ? "已开启" : "已关闭"}续期策略 #${profileId}`);
            } catch (error) {
              if (btn.tagName !== "BUTTON") btn.checked = !nextEnabled;
              setRenewStatus("error", error.message || "切换续期失败");
              window.alert(error.message || "切换续期失败");
            } finally {
              if (btn.isConnected) btn.disabled = false;
            }
            return true;
          }
          return false;
        };
        btn.addEventListener("change", async () => {
          if (await toggleProfile()) return;
          const action = btn.dataset.scheduleRenewOverviewAction || "";
          const presetKey = String(btn.dataset.scheduleRenewPreset || "").trim();
          const sendAsId = Number(btn.dataset.scheduleRenewSendAs || renewSendAsSelect?.value || 0);
          if (!presetKey) return;
          if (action === "enable") {
            const moduleKey = String(btn.dataset.scheduleRenewModule || scheduleRenewModuleForPreset(presetKey) || "").trim();
            const nextEnabled = Boolean(btn.checked);
            btn.disabled = true;
            try {
              setRenewStatus("info", `开启 ${presetKey} 续期...`);
              const result = await postJson("/api/schedule/renew/save", scheduleRenewPresetPayload({
                sendAsId,
                presetKey,
                moduleKey,
                enabled: nextEnabled,
              }));
              if (!result.ok) throw new Error(result.error || "保存续期策略失败");
              renewProfiles = result.profiles || renewProfiles;
              if (renewProfileList) renewProfileList.innerHTML = renderScheduleRenewProfiles(deps, renewProfiles);
              updateRenewOverview();
              bindRenewProfileActions();
              if (result.profile) fillRenewForm(result.profile);
              setRenewStatus("ok", `已开启 ${result.profile?.label || presetKey} 自动续期`);
            } catch (error) {
              btn.checked = false;
              setRenewStatus("error", error.message || "保存续期策略失败");
              window.alert(error.message || "保存续期策略失败");
            } finally {
              if (btn.isConnected) btn.disabled = false;
            }
            return;
          }
        });
        btn.addEventListener("click", async () => {
          if (btn.dataset.scheduleRenewOverviewAction === "toggle-profile" && btn.tagName === "BUTTON") {
            await toggleProfile();
            return;
          }
          const profileId = Number(btn.dataset.profileId || 0);
          if (profileId) {
            const profile = renewProfiles.find((item) => Number(item.id || 0) === profileId);
            fillRenewForm(profile);
            return;
          }
          const action = btn.dataset.scheduleRenewOverviewAction || "";
          const presetKey = String(btn.dataset.scheduleRenewPreset || "").trim();
          const sendAsId = Number(btn.dataset.scheduleRenewSendAs || renewSendAsSelect?.value || 0);
          if (!presetKey || action === "enable" || action === "toggle-profile") return;
          if (renewSendAsSelect && sendAsId && Array.from(renewSendAsSelect.options).some((option) => Number(option.value || 0) === sendAsId)) {
            renewSendAsSelect.value = String(sendAsId);
          }
          if (renewPresetSelect && Array.from(renewPresetSelect.options).some((option) => option.value === presetKey)) {
            renewPresetSelect.value = presetKey;
          }
          syncRenewModuleToPreset();
          markRenewFormAsDraft();
          setRenewStatus(action === "blocked" ? "warn" : "ok", action === "blocked" ? "已套用;该状态机还需先观察到可半自动状态" : "已套用可新增续期预设");
        });
      });
    }

    const setTemplateStatus = (kind, text) => {
      if (!templateStatus) return;
      templateStatus.hidden = !text;
      templateStatus.className = `modal-status-line ${kind}`;
      templateStatus.textContent = text || "";
    };

    const refreshTemplateSelect = () => {
      if (!templateSelect) return;
      const current = templateSelect.value;
      templateSelect.innerHTML = `<option value="">新建模板</option>${templates
        .map((template) => `<option value="${escapeAttr(template.id)}">${escapeHtml(template.name || template.id)}</option>`)
        .join("")}`;
      if (templates.some((template) => template.id === current)) {
        templateSelect.value = current;
      }
      if (templateDeleteButton) {
        templateDeleteButton.disabled = !templateSelect.value;
      }
    };

    const fillFormFromPayload = (payload) => {
      if (!payload) return;
      const selectedIds = (Array.isArray(payload.send_as_ids) ? payload.send_as_ids : [payload.send_as_id])
        .map((value) => Number(value))
        .filter(Boolean);
      setScheduleIdentitySelection(selectedIds);
      for (const [key, value] of Object.entries(payload)) {
        const field = form.querySelector(`[name="${CSS.escape(key)}"]`);
        if (!field || key === "send_as_ids" || key === "send_as_id") continue;
        if (field.type === "checkbox") {
          field.checked = Boolean(value);
        } else {
          field.value = Array.isArray(value) ? value.join(",") : String(value ?? "");
        }
      }
      const anchor = form.querySelector('[name="anchor_at_text"]');
      if (anchor) anchor.value = "";
      updateFieldVisibility();
      syncStateModuleToPreset({ onlyIfEmpty: true });
      refreshScheduleIdentitySelection();
      renderStateHint();
      refreshPlanWorkbench();
    };

    const saveTemplateFromForm = async () => {
      const name = String(templateName?.value || "").trim();
      if (!name) throw new Error("请输入模板名称");
      const payload = collectPayload();
      delete payload.anchor_at;
      delete payload.anchor_at_text;
      const result = await postJson("/api/schedule/templates/save", {
        id: templateSelect?.value || "",
        name,
        payload,
      });
      if (!result.ok) throw new Error(result.error || "保存模板失败");
      templates = result.templates || [];
      refreshTemplateSelect();
      const saved = templates.find((item) => item.name === name);
      if (templateSelect && saved) {
        templateSelect.value = saved.id;
        if (templateDeleteButton) templateDeleteButton.disabled = false;
      }
      setTemplateStatus("ok", `已保存模板：${name}`);
    };

    const sendAsSelect = dialog.querySelector("#scheduleSendAsSelect");
    const sendAsCount = dialog.querySelector("#scheduleSendAsCount");
    const selectedScheduleIds = () => Array.from(sendAsSelect?.selectedOptions || [])
      .map((option) => Number(option.value || 0))
      .filter(Boolean);
    const accountIdentityIds = (localId) => (scheduleState(deps).identities || [])
      .filter((identity) => String(identity.account_local_id || "") === String(localId || ""))
      .map((identity) => Number(identity.send_as_id || 0))
      .filter(Boolean);
    const allScheduleIdentityIds = () => (scheduleState(deps).identities || [])
      .map((identity) => Number(identity.send_as_id || 0))
      .filter(Boolean);
    function refreshScheduleIdentitySelection() {
      const selected = selectedScheduleIds();
      const state = scheduleState(deps);
      state.scheduleSelectedSendAsIds = selected;
      renderScheduleIdentityDock(deps);
      renderScheduleRail(deps);
      if (sendAsCount) sendAsCount.textContent = String(selected.length);
      if (identitySummary) {
        if (!selected.length) {
          identitySummary.textContent = "未选身份";
        } else {
          const first = scheduleIdentityById(deps, selected[0]);
          const suffix = selected.length > 1 ? ` +${selected.length - 1}` : "";
          identitySummary.textContent = `${scheduleIdentityOptionLabel(deps, first)}${suffix}`;
        }
      }
      if (identityScope) {
        const accountIds = new Set(
          selected
            .map((id) => scheduleIdentityById(deps, id)?.account_local_id)
            .filter((value) => value !== undefined && value !== null && String(value) !== "")
            .map((value) => String(value))
        );
        identityScope.textContent = selected.length
          ? `${selected.length} 个身份｜${accountIds.size || 1} 个账号`
          : "未选择排程身份";
      }
      if (accountPickerList) {
        accountPickerList.innerHTML = renderScheduleIdentityPicker(deps, selected);
      }
      if (syncSelect && selected[0] && Array.from(syncSelect.options).some((option) => Number(option.value || 0) === Number(selected[0]))) {
        syncSelect.value = String(selected[0]);
      }
      if (renewSendAsSelect && selected[0] && Array.from(renewSendAsSelect.options).some((option) => Number(option.value || 0) === Number(selected[0]))) {
        const nextRenewSendAs = String(selected[0]);
        if (renewSendAsSelect.value !== nextRenewSendAs) {
          renewSendAsSelect.value = nextRenewSendAs;
          markRenewFormAsDraft();
        }
      }
      if (refillSendAsSelect && selected[0] && Array.from(refillSendAsSelect.options).some((option) => Number(option.value || 0) === Number(selected[0])) && !refillSendAsSelect.value) {
        refillSendAsSelect.value = String(selected[0]);
      }
      renderStateHint();
      refreshPlanWorkbench();
      updateRenewOverview();
    }
    function setScheduleIdentitySelection(ids) {
      if (!sendAsSelect) return;
      const selected = new Set((ids || []).map((id) => Number(id)).filter(Boolean));
      Array.from(sendAsSelect.options).forEach((option) => {
        option.selected = selected.has(Number(option.value || 0));
      });
      refreshScheduleIdentitySelection();
    }
    if (sendAsSelect) {
      sendAsSelect.addEventListener("change", refreshScheduleIdentitySelection);
      refreshScheduleIdentitySelection();
    }
    if (accountPickerList) {
      accountPickerList.addEventListener("click", (event) => {
        const identityButton = event.target.closest("[data-schedule-select-identity]");
        if (identityButton) {
          const id = Number(identityButton.dataset.scheduleSelectIdentity || 0);
          if (!id) return;
          const current = new Set(selectedScheduleIds());
          if (current.has(id)) current.delete(id);
          else current.add(id);
          setScheduleIdentitySelection(Array.from(current));
          return;
        }
        const setAccountButton = event.target.closest("[data-schedule-select-account]");
        if (setAccountButton) {
          setScheduleIdentitySelection(accountIdentityIds(setAccountButton.dataset.scheduleSelectAccount || ""));
          return;
        }
        const addAccountButton = event.target.closest("[data-schedule-add-account]");
        if (addAccountButton) {
          const current = new Set(selectedScheduleIds());
          for (const id of accountIdentityIds(addAccountButton.dataset.scheduleAddAccount || "")) current.add(id);
          setScheduleIdentitySelection(Array.from(current));
        }
      });
    }
    if (useActiveIdentityButton) {
      useActiveIdentityButton.addEventListener("click", () => {
        setScheduleIdentitySelection(activeScheduleSendAsIds(deps));
      });
    }
    if (selectAllIdentityButton) {
      selectAllIdentityButton.addEventListener("click", () => {
        setScheduleIdentitySelection(allScheduleIdentityIds());
      });
    }
    if (setChatIdentityButton) {
      setChatIdentityButton.addEventListener("click", async () => {
        const first = selectedScheduleIds()[0] || 0;
        if (!first) {
          setStatus("warn", "先选择一个排程身份。");
          return;
        }
        if (typeof deps.setActiveIdentity !== "function") return;
        setChatIdentityButton.disabled = true;
        try {
          await deps.setActiveIdentity(first, { loadPatches: true });
          setStatus("ok", `聊天当前已切到 ${scheduleIdentityOptionLabel(deps, scheduleIdentityById(deps, first))}`);
        } catch (error) {
          setStatus("error", error.message || "切换聊天身份失败");
        } finally {
          setChatIdentityButton.disabled = false;
        }
      });
    }
    if (clearIdentityButton) {
      clearIdentityButton.addEventListener("click", () => {
        setScheduleIdentitySelection([]);
      });
    }
    if (stateModuleSelect) {
      stateModuleSelect.addEventListener("change", () => {
        const autoAnchor = form.querySelector('[name="auto_anchor"]');
        if (stateModuleSelect.value && autoAnchor) autoAnchor.checked = true;
        renderStateHint();
        refreshPlanWorkbench();
      });
    }
    if (applyStateSuggestionButton) {
      applyStateSuggestionButton.addEventListener("click", () => {
        const moduleKey = selectedStateModule();
        if (!moduleKey) {
          setStatus("warn", "先选择一个状态机锚点来源。");
          return;
        }
        const contract = findScheduleContract(scheduleModules, selectedPrimarySendAs(), moduleKey);
        const catalog = findModuleCatalog(scheduleModules, moduleKey);
        if (!applyScheduleSuggestionToForm(form, contract, catalog)) {
          setStatus("warn", "这个状态机没有可套用的排程建议。");
          return;
        }
        updateFieldVisibility();
        renderStateHint();
        refreshPlanWorkbench();
        setStatus("ok", "已套用状态机建议。");
      });
    }
    syncStateModuleToPreset({ onlyIfEmpty: true });
    renderStateHint();
    refreshPlanWorkbench();
    if (renewPresetSelect) {
      renewPresetSelect.addEventListener("change", () => {
        syncRenewModuleToPreset();
        markRenewFormAsDraft();
      });
      syncRenewModuleToPreset();
    }
    if (renewSendAsSelect) {
      renewSendAsSelect.addEventListener("change", markRenewFormAsDraft);
    }
    if (renewModuleSelect) {
      renewModuleSelect.addEventListener("change", markRenewFormAsDraft);
    }
    if (refillSendAsSelect) {
      const selected = selectedPrimarySendAs();
      if (selected && Array.from(refillSendAsSelect.options).some((option) => Number(option.value || 0) === selected)) {
        refillSendAsSelect.value = String(selected);
      }
      refillSendAsSelect.addEventListener("change", () => {
        lastRefillPreview = null;
        setRefillStatus("info", "");
        showRefillPreview("");
      });
    }
    if (refillPreviewButton) {
      refillPreviewButton.addEventListener("click", async () => {
        refillPreviewButton.disabled = true;
        setRefillStatus("info", "读取 TG 高水位和状态机起点中…");
        try {
          const result = await postJson("/api/schedule/refill-preview", collectRefillPayload());
          renderRefillPreview(result);
        } catch (error) {
          setRefillStatus("error", error.message || "补货预览失败");
          showRefillPreview("");
        } finally {
          refillPreviewButton.disabled = false;
        }
      });
    }
    if (refillRunButton) {
      refillRunButton.addEventListener("click", async () => {
        const planned = Number(lastRefillPreview?.planned_count || 0);
        const identity = scheduleIdentityLabel(deps, refillPrimarySendAs()) || `send_as ${refillPrimarySendAs() || ""}`;
        const confirmText = planned
          ? `确认给 ${identity} 追加 ${planned} 条官方定时? 执行前会重新读取 TG 高水位。`
          : `还没有最近预览。仍要重新读取 TG 高水位并确认补货到 ${identity} 吗?`;
        if (!window.confirm(confirmText)) return;
        refillRunButton.disabled = true;
        if (refillPreviewButton) refillPreviewButton.disabled = true;
        setRefillStatus("info", "重新读取 TG 高水位并提交补货中…");
        try {
          const result = await postJson("/api/schedule/refill-run", { ...collectRefillPayload(), confirm: true });
          if (!result.ok) throw new Error(result.error || "补货提交失败");
          renderRefillPreview(result.refill_preview || result);
          const estimate = scheduleEstimateText(result.estimate_seconds || 0);
          setRefillStatus("ok", `已提交补货批次 #${result.batch_id}｜${result.planned_count || 0} 条｜预估 ${estimate}`);
          if (result.batch_id) scheduleProgressPolling(deps, dialog, result.batch_id);
          await refreshModalBatchesAfterScheduleChange();
        } catch (error) {
          setRefillStatus("error", error.message || "补货提交失败");
        } finally {
          refillRunButton.disabled = false;
          if (refillPreviewButton) refillPreviewButton.disabled = false;
        }
      });
    }
    if (renewNewButton) {
      renewNewButton.addEventListener("click", resetRenewForm);
    }
    if (renewSaveButton) {
      renewSaveButton.addEventListener("click", async () => {
        renewSaveButton.disabled = true;
        setRenewStatus("info", "保存续期策略中…");
        try {
          const saved = await saveRenewProfile();
          setRenewStatus("ok", `已保存续期策略 #${saved?.id || ""}`);
        } catch (error) {
          setRenewStatus("error", error.message || "保存续期策略失败");
        } finally {
          renewSaveButton.disabled = false;
        }
      });
    }
    if (renewPreviewButton) {
      renewPreviewButton.addEventListener("click", async () => {
        renewPreviewButton.disabled = true;
        setRenewStatus("info", "预览续期中…");
        try {
          await previewRenewProfile();
        } catch (error) {
          setRenewStatus("error", error.message || "预览续期失败");
        } finally {
          renewPreviewButton.disabled = false;
        }
      });
    }
    if (renewRunButton) {
      renewRunButton.addEventListener("click", async () => {
        renewRunButton.disabled = true;
        setRenewStatus("info", "提交续期中…");
        try {
          await runRenewProfile();
        } catch (error) {
          setRenewStatus("error", error.message || "立即续期失败");
        } finally {
          renewRunButton.disabled = false;
        }
      });
    }
    resetRenewForm();
    refreshRenewProfiles().catch((error) => {
      if (renewProfileList) renewProfileList.innerHTML = '<p class="empty inline warn">续期策略读取失败。</p>';
      setRenewStatus("error", error.message || "续期策略读取失败");
    });

    refreshTemplateSelect();
    if (templateSelect) {
      templateSelect.addEventListener("change", () => {
        const current = templates.find((item) => item.id === templateSelect.value);
        if (templateName) templateName.value = current?.name || "";
        if (templateDeleteButton) templateDeleteButton.disabled = !templateSelect.value;
      });
    }
    if (templateLoadButton) {
      templateLoadButton.addEventListener("click", () => {
        const current = templates.find((item) => item.id === templateSelect?.value);
        if (!current) {
          setTemplateStatus("warn", "先选择一个模板。");
          return;
        }
        const payload = current.payload || {};
        fillFormFromPayload(payload);
        if (templateName) templateName.value = current.name || "";
        setTemplateStatus("ok", `已套用模板：${current.name || current.id}`);
      });
    }
    if (templateSaveButton) {
      templateSaveButton.addEventListener("click", async () => {
        templateSaveButton.disabled = true;
        setTemplateStatus("info", "保存模板中…");
        try {
          await saveTemplateFromForm();
        } catch (error) {
          setTemplateStatus("error", error.message || "保存模板失败");
        } finally {
          templateSaveButton.disabled = false;
        }
      });
    }
    if (templateDeleteButton) {
      templateDeleteButton.addEventListener("click", async () => {
        const currentId = templateSelect?.value || "";
        if (!currentId) {
          setTemplateStatus("warn", "先选一个模板再删。");
          return;
        }
        if (!window.confirm("删除这个模板？")) return;
        templateDeleteButton.disabled = true;
        setTemplateStatus("info", "删除模板中…");
        try {
          const result = await postJson("/api/schedule/templates/delete", { id: currentId });
          if (!result.ok) throw new Error(result.error || "删除模板失败");
          templates = result.templates || [];
          refreshTemplateSelect();
          setTemplateStatus("ok", "模板已删除。");
        } catch (error) {
          setTemplateStatus("error", error.message || "删除模板失败");
        } finally {
          templateDeleteButton.disabled = false;
        }
      });
    }

    form.querySelectorAll("[data-schedule-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.scheduleAction;
        const matchingActionButtons = () => Array.from(form.querySelectorAll(`[data-schedule-action="${CSS.escape(action || "")}"]`));
        if (action === "preview") {
          setStatus("info", "计算预览…");
          try {
            const payload = collectPayload();
            const result = await postJson("/api/schedule/preview", payload);
            if (!result.ok) throw new Error(result.error || "预览失败");
            let curBatches = Array.isArray(_initialBatches) ? _initialBatches : [];
            try {
              const sched = await fetchJson("/api/schedule");
              if (Array.isArray(sched.batches)) curBatches = sched.batches;
            } catch (e) { /* 用打开模态时的批次兜底 */ }
            const previewItems = result.items || [];
            showPreview(`
              <p>预设 <strong>${escapeHtml(result.preset_label)}</strong>｜锚点 ${escapeHtml(result.anchor_text)}${result.auto_anchor_used ? '<small class="status-pill ok" style="margin-left:6px">自动锚点</small>' : ""}｜首次发送 ${escapeHtml(result.first_due_text || result.anchor_text)}｜${escapeHtml(SCHEDULE_TIME_ZONE_LABEL)}｜${result.horizon_days} 天</p>
              ${result.state_contract ? `<div class="schedule-preview-extras">${scheduleContractHtml(result.state_contract)}</div>` : ""}
              <ul class="send-as-result-list">
                ${previewItems.map((it) => `<li class="ok"><code>${escapeHtml(it.command)}</code> <small>${escapeHtml(it.schedule_text || "")}</small></li>`).join("") || "<li>(0 条)</li>"}
              </ul>
              ${scheduleQuotaConflictHtml(deps, payload, result, curBatches)}
            `, `共 ${previewItems.length} 条`);
            setStatus("ok", `共 ${previewItems.length} 条`);
          } catch (error) {
            setStatus("error", error.message);
          }
          return;
        }
        if (action === "create") {
          matchingActionButtons().forEach((button) => { button.disabled = true; });
          setStatus("info", "创建中…");
          try {
            const result = await postJson("/api/schedule/create", collectPayload());
            const manualMessages = scheduleManualMessages(result);
            if (manualMessages.length && !result.batch_count) {
              const text = scheduleStatusWithManualMessages("官方定时未创建", manualMessages);
              window.alert(manualMessages.join("\n\n"));
              setStatus("warn", text);
              return;
            }
            if (!result.ok && !result.batch_count) throw new Error(result.error || "创建失败");
            let stats;
            if (result.batch_count) {
              const okN = result.succeeded || 0;
              const failN = result.failed || 0;
              const totalEstimate = scheduleEstimateText(result.total_estimate_seconds || 0);
              stats = `批量创建 ${result.batch_count} 个身份｜成功 ${okN}${failN ? `｜失败 ${failN}` : ""}｜阶梯 ${result.offset_step_minutes}min｜总预估 ${totalEstimate}`;
              for (const r of (result.results || [])) {
                if (r.ok && r.status === "sending" && r.batch_id) {
                  scheduleProgressPolling(deps, dialog, r.batch_id);
                }
              }
            } else {
              stats = `批次 #${result.batch_id}｜planned ${result.planned_count}`;
              if (result.dry_run) {
                stats += "｜dry_run";
              } else if (result.status === "sending") {
                const estimate = scheduleEstimateText(result.estimate_seconds || 0);
                stats += `｜后台排定时中,预估 ${estimate}｜可在下方批次列表里取消`;
                scheduleProgressPolling(deps, dialog, result.batch_id);
              } else {
                stats += `｜TG 排上 ${result.created_official}`;
              }
            }
            if (manualMessages.length) window.alert(manualMessages.join("\n\n"));
            setStatus(result.errors?.length || result.failed || manualMessages.length ? "warn" : "ok", scheduleStatusWithManualMessages(stats, manualMessages));
            const refreshed = await fetchJson("/api/schedule");
            if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
            bindScheduleBatchActions(deps, dialog, setStatus);
          } catch (error) {
            setStatus("error", error.message);
          } finally {
            matchingActionButtons().forEach((button) => { button.disabled = false; });
          }
          return;
        }
      });
    });
    bindScheduleBatchActions(deps, dialog, setStatus);

    if (syncButton && syncSelect) {
      const setSyncStatus = (kind, text) => {
        syncStatus.hidden = !text;
        syncStatus.className = `modal-status-line ${kind}`;
        syncStatus.textContent = text || "";
      };
      const renderSyncResult = (result) => {
        const tg = result.tg_messages || [];
        const orphans = result.orphans || [];
        const otherIdentity = result.other_identity || [];
        const lost = result.lost || [];
        const expired = result.expired || [];
        if (!syncResult) return;
        syncResult.hidden = false;
        syncResult.innerHTML = `
          <p><strong>Telegram 端当前 ${tg.length} 条 scheduled message</strong></p>
          <ul class="send-as-result-list">
            ${tg.map((m) => `<li class="ok"><code>${escapeHtml(clipGraphemes(m.message || "", 40))}</code> <small>${escapeHtml(m.schedule_text || "")}｜TG #${escapeHtml(String(m.scheduled_msg_id || ""))}</small></li>`).join("") || "<li>(空)</li>"}
          </ul>
          ${otherIdentity.length ? `<p><strong>其它身份已记录的 ${escapeHtml(String(otherIdentity.length))} 条</strong>(不是当前身份漂移):</p><ul class="send-as-result-list">${otherIdentity.map((m) => `<li class="ok"><code>${escapeHtml(clipGraphemes(m.tg?.message || m.local?.command || "", 40))}</code> <small>send_as ${escapeHtml(String(m.local?.send_as_id || ""))}｜TG #${escapeHtml(String(m.tg?.scheduled_msg_id || ""))}｜${escapeHtml(m.tg?.schedule_text || m.local?.schedule_text || "")}</small></li>`).join("")}</ul>` : ""}
          ${orphans.length ? `<p><strong>⚠ TG 有但 mini-web 没记录的 ${escapeHtml(String(orphans.length))} 条</strong>(可能是从其它工具或手机端排的):</p><ul class="send-as-result-list">${orphans.map((m) => `<li class="warn"><code>${escapeHtml(clipGraphemes(m.message || "", 40))}</code> <small>TG #${escapeHtml(String(m.scheduled_msg_id || ""))}｜${escapeHtml(m.schedule_text || "")}</small></li>`).join("")}</ul>` : ""}
          ${lost.length ? `<p><strong>⚠ 未来应存在但 TG 找不到的 ${escapeHtml(String(lost.length))} 条</strong>(可能被 TG 端取消了):</p><ul class="send-as-result-list">${lost.map((m) => `<li class="warn"><code>${escapeHtml(m.command)}</code> <small>本地 #${escapeHtml(String(m.id || ""))}｜TG 期望 #${escapeHtml(String(m.scheduled_msg_id || ""))}</small></li>`).join("")}</ul>` : ""}
          ${expired.length ? `<p><strong>已过期可释放的 ${escapeHtml(String(expired.length))} 条</strong>(计划时间已过且 TG 待发送列表不再返回):</p><ul class="send-as-result-list">${expired.map((m) => `<li class="ok"><code>${escapeHtml(m.command)}</code> <small>本地 #${escapeHtml(String(m.id || ""))}｜原 TG #${escapeHtml(String(m.scheduled_msg_id || ""))}｜${escapeHtml(m.schedule_text || "")}</small></li>`).join("")}</ul>` : ""}
        `;
      };
      syncButton.addEventListener("click", async () => {
        const sendAs = syncSelect.value;
        if (!sendAs) {
          setSyncStatus("warn", "请选身份");
          return;
        }
        const originalText = syncButton.textContent;
        syncButton.disabled = true;
        syncButton.textContent = "对账中";
        setSyncStatus("info", "正在调 GetScheduledHistory 对账…");
        try {
          const result = await fetchJson(`/api/schedule/sync?send_as_id=${encodeURIComponent(sendAs)}`);
          if (!result.ok) throw new Error(result.error || "对账失败");
          const tg = result.tg_messages || [];
          const matched = result.matched || [];
          const orphans = result.orphans || [];
          const otherIdentity = result.other_identity || [];
          const lost = result.lost || [];
          const expired = result.expired || [];
          setSyncStatus(orphans.length || lost.length || expired.length ? "warn" : "ok", `TG ${tg.length} 条｜对得上 ${matched.length}｜其它身份 ${otherIdentity.length}｜TG 有本地没的 ${orphans.length}｜未来丢失 ${lost.length}｜过期可释放 ${expired.length}`);
          renderSyncResult(result);
        } catch (error) {
          setSyncStatus("error", error.message);
        } finally {
          syncButton.disabled = false;
          syncButton.textContent = originalText;
        }
      });
      if (syncRepairButton) {
        syncRepairButton.addEventListener("click", async () => {
          const sendAs = syncSelect.value;
          if (!sendAs) {
            setSyncStatus("warn", "请选身份");
            return;
          }
          if (!window.confirm("确认修复本地漂移?本地丢失项会标记为失败,方便之后重排;TG 外部定时不会被删除。")) return;
          const originalText = syncRepairButton.textContent;
          syncRepairButton.disabled = true;
          syncRepairButton.textContent = "修复中";
          setSyncStatus("info", "正在修复本地漂移…");
          try {
            const result = await postJson("/api/schedule/sync/repair", { send_as_id: Number(sendAs) });
            if (!result.ok) throw new Error(result.error || "修复失败");
            const sync = result.sync || result;
            const orphans = sync.orphans || [];
            const otherIdentity = sync.other_identity || [];
            const lost = sync.lost || [];
            const expired = sync.expired || [];
            setSyncStatus(
              orphans.length || lost.length || expired.length ? "warn" : "ok",
              `${result.message || "本地漂移修复完成"}｜当前 lost ${lost.length}｜expired ${expired.length}｜orphans ${orphans.length}｜其它身份 ${otherIdentity.length}`
            );
            renderSyncResult(sync);
            const refreshed = await fetchJson("/api/schedule");
            if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
            bindScheduleBatchActions(deps, dialog, setStatus);
          } catch (error) {
            setSyncStatus("error", error.message || "修复失败");
          } finally {
            syncRepairButton.disabled = false;
            syncRepairButton.textContent = originalText;
          }
        });
      }
    }
    return setStatus;
  }

  function bindScheduleBatchActions(deps = {}, dialog, setStatus = null) {
    const setBatchStatus = typeof setStatus === "function"
      ? setStatus
      : (typeof dialog?._scheduleSetStatus === "function" ? dialog._scheduleSetStatus : () => {});
    dialog.querySelectorAll('[data-schedule-action="delete"]').forEach((btn) => {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`删除批次 #${batchId}?`)) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "删除中";
        setBatchStatus("info", `正在删除批次 #${batchId}…`);
        try {
          const result = await postJson("/api/schedule/delete", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "删除失败");
          setBatchStatus("ok", `已删除批次 #${batchId}`);
          const refreshed = await fetchJson("/api/schedule");
          const batchList = dialog.querySelector("#scheduleBatchList");
          if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
          bindScheduleBatchActions(deps, dialog, setStatus);
        } catch (error) {
          setBatchStatus("error", error.message || "删除失败");
          window.alert(error.message || "删除失败");
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
    dialog.querySelectorAll('[data-schedule-action="cancel"]').forEach((btn) => {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`取消批次 #${batchId}?已经排到 TG 的会保留(可点删除一并清掉)。`)) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "取消中";
        setBatchStatus("info", `正在取消批次 #${batchId}…`);
        try {
          const result = await postJson("/api/schedule/cancel", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "取消失败");
          setBatchStatus("ok", `批次 #${batchId} 已取消`);
          const refreshed = await fetchJson("/api/schedule");
          const batchList = dialog.querySelector("#scheduleBatchList");
          if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
          bindScheduleBatchActions(deps, dialog, setStatus);
        } catch (error) {
          setBatchStatus("error", error.message || "取消失败");
          window.alert(error.message || "取消失败");
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
    dialog.querySelectorAll('[data-schedule-action="activate-dry-run"]').forEach((btn) => {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`把本地预演批次 #${batchId} 正式排到 Telegram 官方定时?`)) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "提交中";
        setBatchStatus("info", `正在把批次 #${batchId} 排到 TG…`);
        try {
          const result = await postJson("/api/schedule/activate-dry-run", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "提交失败");
          const estimate = scheduleEstimateText(result.estimate_seconds || 0);
          setBatchStatus("ok", `批次 #${batchId} 已提交后台排定时｜${result.activated || 0} 条｜预估 ${estimate}`);
          const refreshed = await fetchJson("/api/schedule");
          const batchList = dialog.querySelector("#scheduleBatchList");
          if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
          bindScheduleBatchActions(deps, dialog, setStatus);
          if (result.batch_id) scheduleProgressPolling(deps, dialog, result.batch_id);
        } catch (error) {
          setBatchStatus("error", error.message || "提交失败");
          window.alert(error.message || "提交失败");
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
    dialog.querySelectorAll('[data-schedule-action="retry-failed"]').forEach((btn) => {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`重排批次 #${batchId} 的待重排项?已过期的会改到近期错峰时间,仍是官方定时、需已登录。`)) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "重排中";
        setBatchStatus("info", `正在重排批次 #${batchId} 的待重排项…`);
        try {
          const result = await postJson("/api/schedule/retry-failed", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "重排失败");
          setBatchStatus("ok", `批次 #${batchId} 已重新排入后台发送`);
          const refreshed = await fetchJson("/api/schedule");
          const batchList = dialog.querySelector("#scheduleBatchList");
          if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
          bindScheduleBatchActions(deps, dialog, setStatus);
          if (result.batch_id) scheduleProgressPolling(deps, dialog, result.batch_id);
        } catch (error) {
          setBatchStatus("error", error.message || "重排失败");
          window.alert(error.message || "重排失败");
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
  }

  function scheduleProgressPolling(deps = {}, dialog, batchId) {
    if (!dialog || !batchId) return;
    const batchList = dialog.querySelector("#scheduleBatchList");
    if (!batchList) return;
    const start = Date.now();
    const tick = async () => {
      if (!document.body.contains(dialog)) return;
      if (Date.now() - start > 60 * 60 * 1000) return;
      try {
        const refreshed = await fetchJson("/api/schedule");
        const refreshedBatches = syncScheduleBatches(deps, refreshed);
        batchList.innerHTML = renderScheduleBatches(deps, refreshedBatches);
        bindScheduleBatchActions(deps, dialog);
        const target = refreshedBatches.find((b) => Number(b.id) === Number(batchId));
        if (target && target.status === "sending") {
          window.setTimeout(tick, 8000);
        }
      } catch (err) {
        console.warn("[mini-web] schedule progress poll:", err);
        window.setTimeout(tick, 15000);
      }
    };
    window.setTimeout(tick, 4000);
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.schedule = {
    loadScheduleRail,
    loadScheduleRenewSummary,
    syncScheduleBatches,
    syncScheduleRenewProfiles,
    renderScheduleRail,
    aggregateScheduleRailBatches,
    scheduleVisibleRailBatches,
    renderScheduleIdentityDock,
    renderScheduleRailRow,
    scheduleRailStatusClass,
    scheduleIdentityLabel,
    openScheduleModal,
    renderScheduleTemplateOptions,
    renderScheduleModuleOptions,
    renderScheduleBatches,
    renderScheduleBatchRows,
    parseScheduleShanghaiLocalTimestamp,
    scheduleStatusText,
    scheduleStatusPill,
    scheduleDisplayStatusKey,
    scheduleCurrentCounts,
    scheduleBatchIsDryRun,
    scheduleBatchHasCurrentWork,
    scheduleMessageHasCurrentWork,
    scheduleMessageStatusView,
    scheduleManualMessages,
    scheduleStatusWithManualMessages,
    scheduleEstimateText,
    findScheduleContract,
    scheduleContractHtml,
    applyScheduleSuggestionToForm,
    bindScheduleModal,
    bindScheduleBatchActions,
    scheduleProgressPolling,
  };
})();
