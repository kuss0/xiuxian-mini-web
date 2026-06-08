// MINIWEB-VIEW: official schedule rail and modal
(function () {
  "use strict";

  const { fetchJson, postJson } = window.MiniwebApi;
  const { openModal } = window.MiniwebModal;
  const { clipGraphemes, escapeAttr, escapeHtml } = window.MiniwebFormat;

  function scheduleState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function scheduleRailElement(deps = {}) {
    return deps.scheduleRail || document.querySelector("#scheduleRail");
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
      const payload = await fetchJson("/api/schedule");
      return syncScheduleBatches(deps, payload);
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

  function syncScheduleBatches(deps = {}, payload) {
    const state = scheduleState(deps);
    const batches = Array.isArray(payload?.batches) ? payload.batches : [];
    state.scheduleBatches = batches;
    state.scheduleError = "";
    state.scheduleLoading = false;
    renderScheduleIdentityDock(deps);
    renderScheduleRail(deps);
    return batches;
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
    const railBatches = batches.filter(scheduleBatchHasCurrentWork);
    if (!railBatches.length) {
      const previewCount = batches.filter(scheduleBatchIsDryRun).length;
      const hiddenText = previewCount
        ? `本地预演 ${previewCount} 批已收起。`
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
    const visible = railBatches.slice(0, 4);
    scheduleRail.innerHTML = `
      <div class="schedule-rail-summary">
        <strong>${escapeHtml(String(railBatches.length))} 批排班</strong>
        <span>${totals.sending ? `${escapeHtml(String(totals.sending))} 批发送中｜` : ""}${escapeHtml(String(totals.scheduled))} 已排 / ${escapeHtml(String(totals.planned))} 待排${totals.failed ? `｜${escapeHtml(String(totals.failed))} 待重排` : ""}</span>
      </div>
      <div class="schedule-rail-list">
        ${visible.map((batch) => renderScheduleRailRow(deps, batch)).join("")}
      </div>
      ${batches.length > visible.length ? `<button type="button" class="schedule-rail-more" data-schedule-open>管理排班</button>` : ""}
    `;
    bindScheduleOpenButtons(deps, scheduleRail);
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
  }

  function renderScheduleRailRow(deps = {}, batch) {
    const counts = scheduleCurrentCounts(batch.counts || {});
    const total = (counts.planned || 0) + (counts.scheduled || 0) + (counts.failed || 0) + (counts.expired || 0);
    const done = (counts.scheduled || 0) + (counts.expired || 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const statusKey = scheduleDisplayStatusKey(batch.status || "active", counts);
    const statusPill = scheduleStatusPill(statusKey) || `<span class="status-pill">${statusKey === "active" ? "活动" : escapeHtml(statusKey)}</span>`;
    const identity = scheduleIdentityLabel(deps, batch.send_as_id);
    const currentItems = (batch.items || []).filter(scheduleMessageHasCurrentWork);
    const snippets = currentItems.slice(0, 2).map((item) => `
      <span>
        <code>${escapeHtml(item.command || "")}</code>
        <small>${escapeHtml(item.schedule_text || "")}</small>
      </span>
    `).join("");
    return `
      <article class="schedule-rail-row ${escapeAttr(scheduleRailStatusClass(statusKey, counts))}">
        <button type="button" class="schedule-rail-row-main" data-schedule-open title="打开官方定时排班">
          <span class="schedule-rail-row-title">
            <strong>${escapeHtml(batch.label || batch.preset_key || `排班 #${batch.id}`)}</strong>
            ${statusPill}
          </span>
          <span class="schedule-rail-row-meta">${escapeHtml(identity)}｜${escapeHtml(batch.anchor_text || "未设锚点")}｜${escapeHtml(scheduleStatusText(statusKey, counts))}</span>
          ${total ? `<span class="schedule-progress compact"><span class="schedule-progress-bar" style="width:${pct}%"></span></span>` : ""}
          <span class="schedule-rail-snippets">
            ${snippets || "<small>没有待展示命令</small>"}
            ${currentItems.length > 2 ? `<small>+${escapeHtml(String(currentItems.length - 2))} 条</small>` : ""}
          </span>
        </button>
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
      const selectedInGroup = group.filter((identity) => selected.has(Number(identity.send_as_id || 0))).length;
      return `
        <article class="schedule-account-picker-row ${selectedInGroup ? "selected" : ""}">
          <div class="schedule-account-picker-head">
            <span class="account-row-dot ${running ? "live" : (loggedIn ? "ok" : "warn")}"></span>
            <div>
              <strong>${escapeHtml(scheduleAccountLabel(account, key || "未绑定账号"))}</strong>
              <small>${escapeHtml(loggedIn ? "已登录" : "未登录")}｜${escapeHtml(running ? "采集中" : "未采集")}｜${escapeHtml(String(selectedInGroup))}/${escapeHtml(String(group.length))}</small>
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
    }];
  }

  async function loadScheduleModalBootstrap(deps = {}) {
    const state = scheduleState(deps);
    try {
      const payload = await fetchJson("/api/schedule/bootstrap");
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
        batches: payload.batches || [],
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

  async function openScheduleModal(deps = {}) {
    const state = scheduleState(deps);
    const bootstrap = await loadScheduleModalBootstrap(deps);
    const presets = bootstrap.presets?.length ? bootstrap.presets : fallbackSchedulePresets();
    const scheduleModules = bootstrap.modules || { modules: [], by_identity: [] };
    const batches = syncScheduleBatches(deps, { batches: bootstrap.batches || [] });
    const templates = bootstrap.templates || [];
    const defaultSendAsIds = defaultScheduleSendAsIds(deps);
    const identityOptions = renderScheduleIdentityOptions(deps, defaultSendAsIds);
    const presetOptions = presets
      .map((p) => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)} — ${escapeHtml(p.description)}</option>`)
      .join("");
    const moduleOptions = renderScheduleModuleOptions(scheduleModules.modules || []);
    const dialog = openModal({
      title: "官方定时排班",
      body: `
        <div class="schedule-modal-grid">
          <section class="schedule-modal-context modal-section">
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
          </section>
          <div class="schedule-modal-main">
            <section class="modal-section">
              <h4>新建排班</h4>
              <form id="scheduleForm" class="settings-form">
                <div class="schedule-native-send-as" aria-hidden="true">
                  <select name="send_as_ids" multiple size="6" id="scheduleSendAsSelect" tabindex="-1">${identityOptions || '<option value="">没有可用身份</option>'}</select>
                  <span id="scheduleSendAsCount">0</span>
                </div>
                <div class="form-actions schedule-form-actions-top">
                  <button type="button" data-schedule-action="preview">预览计划</button>
                  <button type="button" class="primary" data-schedule-action="create">创建</button>
                </div>
                <div class="form-grid">
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
                  <label>
                    <span>批量阶梯(每个身份递增分钟)</span>
                    <input name="offset_step_minutes" inputmode="numeric" value="5" placeholder="批量时每个身份 offset 递增,1 个就不生效" />
                  </label>
                  <label data-show-when="pet_name">
                    <span>法宝名</span>
                    <input name="pet_name" placeholder="留空表示不带名字" />
                  </label>
                  <label data-show-when="trigger_command">
                    <span>触发词(可选)</span>
                    <input name="trigger_command" placeholder="深闭默认「查看闭关」,留空走默认;其他 preset 留空 = 不发触发" />
                  </label>
                  <label data-show-when="horizon_days">
                    <span>排几天(1-7)</span>
                    <input name="horizon_days" inputmode="numeric" min="1" max="7" value="3" />
                  </label>
                  <label class="span-2" data-show-when="command">
                    <span>自定义命令</span>
                    <textarea name="command" rows="4" placeholder="每行一条命令；例如&#10;.宗门点卯&#10;.闯塔&#10;.天机代卜"></textarea>
                  </label>
                  <label data-show-when="interval_sec">
                    <span>间隔 / CD(秒)</span>
                    <input name="interval_sec" inputmode="numeric" value="3600" />
                  </label>
                  <label data-show-when="count">
                    <span>次数 / 轮数</span>
                    <input name="count" inputmode="numeric" value="3" />
                  </label>
                  <label data-show-when="command_gap_sec">
                    <span>同轮命令间隔(秒)</span>
                    <input name="command_gap_sec" inputmode="numeric" value="180" placeholder="多条自定义命令之间错开" />
                  </label>
                  <label>
                    <span>错峰偏移(分钟)</span>
                    <input name="offset_minutes" inputmode="numeric" value="0" placeholder="0 = 不偏" title="多账号同时建议各错开 3-15 分钟,避免天尊同一刻被多账号挤" />
                  </label>
                  <label class="span-2">
                    <span>锚点时间(留空 = 现在)</span>
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
                <label class="toggle-row">
                  <input type="checkbox" name="schedule_semiauto" />
                  <span>白名单半自动(后端会拒绝未知、缺参数、阶段型和非白名单模块)</span>
                </label>
                <label class="toggle-row">
                  <input type="checkbox" name="dry_run" />
                  <span>本地预演(只记录计划,不排到 Telegram)</span>
                </label>
                <div class="form-actions">
                  <button type="button" id="scheduleApplyStateSuggestion">套用状态机建议</button>
                </div>
                <div id="scheduleStateHint" class="send-as-result" hidden></div>
                <div class="form-actions">
                  <button type="button" data-schedule-action="preview">预览计划</button>
                  <button type="button" class="primary" data-schedule-action="create">创建</button>
                </div>
              </form>
              <p class="modal-status-line info" id="scheduleStatus" hidden></p>
              <div id="schedulePreview" class="send-as-result" hidden></div>
            </section>

            <section class="modal-section">
              <h4>模板复用</h4>
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
            </section>

            <section class="modal-section">
              <h4>对账 Telegram 端</h4>
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
            </section>
          </div>

          <aside class="schedule-modal-records" aria-label="本地排班记录">
            <section class="modal-section">
              <h4>本地排班记录</h4>
              <p class="muted">这些是 mini-web 自己存的批次。dry_run=False 那次会同时排到 Telegram;有 scheduled_msg_id 的就是真排上的。</p>
              <div id="scheduleBatchList">${renderScheduleBatches(deps, batches)}</div>
            </section>
          </aside>
        </div>
      `,
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    dialog.classList.add("schedule-modal-dialog");
    bindScheduleModal(deps, dialog, presets, batches, templates, scheduleModules);
    if (bootstrap.warning) {
      const status = dialog.querySelector("#scheduleStatus");
      if (status) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = bootstrap.warning;
      }
    }
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
                <span class="account-row-meta">send_as ${escapeHtml(String(b.send_as_id || ""))}｜${escapeHtml(b.anchor_text || "")}｜${escapeHtml(String(b.horizon_days || ""))} 天｜${escapeHtml(statusText)}</span>
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
        <p class="muted" style="margin:6px 0 2px">未来时间线(${byDay.size} 天):</p>
        <ul class="send-as-result-list">${timeline}</ul>
        ${multiNote}
      </div>
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
    return `
      <p>
        <strong>${escapeHtml(source.label || source.module_key || "")}</strong>
        <span class="status-pill ${source.semiauto_ready ? "ok" : "warn"}">${source.semiauto_ready ? "可半自动" : "需确认"}</span>
        <small>${escapeHtml(source.summary?.text || "")}</small>
      </p>
      <p class="muted">起点 ${escapeHtml(source.next_at ? "状态机 next_at" : "未确定")}｜置信 ${escapeHtml(source.confidence || "unknown")}｜建议 <code>${escapeHtml(command)}</code>${suggestion.interval_sec ? `｜间隔 ${escapeHtml(String(suggestion.interval_sec))}s` : ""}</p>
      ${tianjigeText ? `<p class="muted">${escapeHtml(tianjigeText)} ${tianjigeKeys}</p>` : ""}
      ${warnHtml}
    `;
  }

  function applyScheduleSuggestionToForm(form, contract, catalog = null) {
    const suggestion = (contract?.suggestion || catalog?.suggestion || {});
    if (!suggestion || !Object.keys(suggestion).length) return false;
    const setValue = (name, value, { overwrite = true } = {}) => {
      const field = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (!field || value === undefined || value === null || value === "") return;
      if (!overwrite && String(field.value || "").trim()) return;
      field.value = String(value);
    };
    setValue("preset_key", suggestion.preset_key || "custom");
    setValue("command", suggestion.command || suggestion.base_command || "", { overwrite: true });
    setValue("interval_sec", suggestion.interval_sec || "", { overwrite: true });
    setValue("count", suggestion.count || "", { overwrite: true });
    setValue("horizon_days", suggestion.horizon_days || "", { overwrite: false });
    setValue("trigger_command", suggestion.trigger_command || "", { overwrite: true });
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
    const stateModuleSelect = dialog.querySelector("#scheduleStateModuleSelect");
    const stateHint = dialog.querySelector("#scheduleStateHint");
    const applyStateSuggestionButton = dialog.querySelector("#scheduleApplyStateSuggestion");
    const accountPickerList = dialog.querySelector("#scheduleAccountPickerList");
    const identitySummary = dialog.querySelector("#scheduleIdentitySummary");
    const identityScope = dialog.querySelector("#scheduleIdentityScope");
    const useActiveIdentityButton = dialog.querySelector("#scheduleUseActiveIdentityButton");
    const selectAllIdentityButton = dialog.querySelector("#scheduleSelectAllIdentityButton");
    const setChatIdentityButton = dialog.querySelector("#scheduleSetChatIdentityButton");
    const clearIdentityButton = dialog.querySelector("#scheduleClearIdentityButton");
    if (!form) return;
    const presetMap = new Map(presets.map((p) => [p.key, p]));
    let templates = Array.isArray(initialTemplates) ? [...initialTemplates] : [];
    const setStatus = (kind, text) => {
      if (!status) return;
      status.hidden = !text;
      status.className = `modal-status-line ${kind}`;
      status.textContent = text || "";
    };
    const showPreview = (html) => {
      if (!preview) return;
      preview.hidden = !html;
      preview.innerHTML = html || "";
    };
    const updateFieldVisibility = () => {
      const key = form.querySelector('[name="preset_key"]').value;
      const required = new Set(presetMap.get(key)?.fields || []);
      form.querySelectorAll("[data-show-when]").forEach((label) => {
        const fieldName = label.dataset.showWhen;
        label.style.display = required.has(fieldName) ? "" : "none";
      });
    };
    const presetSelect = form.querySelector('[name="preset_key"]');
    updateFieldVisibility();

    const selectedPrimarySendAs = () => {
      const select = dialog.querySelector("#scheduleSendAsSelect");
      return Number(select?.selectedOptions?.[0]?.value || 0);
    };
    const selectedStateModule = () => String(stateModuleSelect?.value || "").trim();
    const matchedModuleForPreset = () => {
      const key = String(presetSelect?.value || "").trim();
      return String(presetMap.get(key)?.module_key || "").trim();
    };
    const syncStateModuleToPreset = ({ onlyIfEmpty = false } = {}) => {
      const moduleKey = matchedModuleForPreset();
      if (!moduleKey || !stateModuleSelect) return false;
      if (onlyIfEmpty && stateModuleSelect.value) return false;
      const option = Array.from(stateModuleSelect.options).find((item) => item.value === moduleKey);
      if (!option) return false;
      stateModuleSelect.value = moduleKey;
      const autoAnchor = form.querySelector('[name="auto_anchor"]');
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
    if (presetSelect) {
      presetSelect.addEventListener("change", () => {
        updateFieldVisibility();
        syncStateModuleToPreset();
        renderStateHint();
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
        const parsed = new Date(String(anchorText));
        if (!Number.isNaN(parsed.getTime())) {
          payload.anchor_at = Math.floor(parsed.getTime() / 1000);
        }
      }
      return payload;
    };

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
      renderStateHint();
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
        setStatus("ok", "已套用状态机建议。");
      });
    }
    syncStateModuleToPreset({ onlyIfEmpty: true });
    renderStateHint();

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
            showPreview(`
              <p>预设 <strong>${escapeHtml(result.preset_label)}</strong>｜锚点 ${escapeHtml(result.anchor_text)}${result.auto_anchor_used ? '<small class="status-pill ok" style="margin-left:6px">自动锚点</small>' : ""}｜首次发送 ${escapeHtml(result.first_due_text || result.anchor_text)}｜${result.horizon_days} 天</p>
              ${result.state_contract ? `<div class="schedule-preview-extras">${scheduleContractHtml(result.state_contract)}</div>` : ""}
              <ul class="send-as-result-list">
                ${(result.items || []).map((it) => `<li class="ok"><code>${escapeHtml(it.command)}</code> <small>${escapeHtml(it.schedule_text || "")}</small></li>`).join("") || "<li>(0 条)</li>"}
              </ul>
              ${scheduleQuotaConflictHtml(deps, payload, result, curBatches)}
            `);
            setStatus("ok", `共 ${(result.items || []).length} 条`);
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
  }

  function bindScheduleBatchActions(deps = {}, dialog, setStatus = null) {
    const setBatchStatus = typeof setStatus === "function" ? setStatus : () => {};
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
    syncScheduleBatches,
    renderScheduleRail,
    renderScheduleIdentityDock,
    renderScheduleRailRow,
    scheduleRailStatusClass,
    scheduleIdentityLabel,
    openScheduleModal,
    renderScheduleTemplateOptions,
    renderScheduleModuleOptions,
    renderScheduleBatches,
    renderScheduleBatchRows,
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
