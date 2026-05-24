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
    const totals = batches.reduce((acc, batch) => {
      const counts = batch.counts || {};
      acc.planned += Number(counts.planned || 0);
      acc.scheduled += Number(counts.scheduled || 0);
      acc.failed += Number(counts.failed || 0);
      acc.sending += batch.status === "sending" ? 1 : 0;
      return acc;
    }, { planned: 0, scheduled: 0, failed: 0, sending: 0 });
    const visible = batches.slice(0, 4);
    scheduleRail.innerHTML = `
      <div class="schedule-rail-summary">
        <strong>${escapeHtml(String(batches.length))} 批排班</strong>
        <span>${totals.sending ? `${escapeHtml(String(totals.sending))} 批发送中｜` : ""}${escapeHtml(String(totals.scheduled))} 已排 / ${escapeHtml(String(totals.planned))} 待排${totals.failed ? `｜${escapeHtml(String(totals.failed))} 失败` : ""}</span>
      </div>
      <div class="schedule-rail-list">
        ${visible.map((batch) => renderScheduleRailRow(deps, batch)).join("")}
      </div>
      ${batches.length > visible.length ? `<button type="button" class="schedule-rail-more" data-schedule-open>查看全部 ${escapeHtml(String(batches.length))} 批</button>` : ""}
    `;
    scheduleRail.querySelectorAll("[data-schedule-open]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await Promise.all([
            deps.loadAccounts?.() || Promise.resolve(),
            deps.loadIdentities?.() || Promise.resolve(),
          ]);
          await openScheduleModal(deps);
        } catch (error) {
          deps.showError?.(error);
        }
      });
    });
  }

  function renderScheduleRailRow(deps = {}, batch) {
    const counts = batch.counts || {};
    const total = (counts.planned || 0) + (counts.scheduled || 0) + (counts.failed || 0);
    const done = (counts.scheduled || 0) + (counts.failed || 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const statusKey = batch.status || "active";
    const statusPill = scheduleStatusPill(statusKey) || `<span class="status-pill">${statusKey === "active" ? "活动" : escapeHtml(statusKey)}</span>`;
    const identity = scheduleIdentityLabel(deps, batch.send_as_id);
    const snippets = (batch.items || []).slice(0, 2).map((item) => `
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
            ${(batch.items || []).length > 2 ? `<small>+${escapeHtml(String((batch.items || []).length - 2))} 条</small>` : ""}
          </span>
        </button>
      </article>
    `;
  }

  function scheduleRailStatusClass(statusKey, counts) {
    if (statusKey === "failed") return "risk";
    if (statusKey === "partial_failed" || Number(counts?.failed || 0) > 0) return "warn";
    if (statusKey === "sending") return "live";
    if (statusKey === "completed") return "done";
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

  async function openScheduleModal(deps = {}) {
    const state = scheduleState(deps);
    const [presetsPayload, batchesPayload, templatesPayload] = await Promise.all([
      fetchJson("/api/schedule/presets"),
      fetchJson("/api/schedule"),
      fetchJson("/api/schedule/templates"),
    ]);
    const presets = presetsPayload.presets || [];
    const batches = syncScheduleBatches(deps, batchesPayload);
    const templates = templatesPayload.templates || [];
    const identityOptions = (state.identities || [])
      .map((id) => {
        const label = `${id.label || id.username || id.send_as_id}｜send_as ${id.send_as_id}`;
        return `<option value="${escapeAttr(String(id.send_as_id))}">${escapeHtml(label)}</option>`;
      })
      .join("");
    const presetOptions = presets
      .map((p) => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)} — ${escapeHtml(p.description)}</option>`)
      .join("");
    const dialog = openModal({
      title: "官方定时排班",
      body: `
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
          <h4>新建排班</h4>
          <p class="muted">核心用法是填命令、间隔和次数,一次排进 Telegram 官方定时;预设只是快速填常用玩法。这里不会根据回复自动补发或追链。多选身份会一次为每个身份各起一批,按「错峰偏移 + 阶梯」自动错开。</p>
          <form id="scheduleForm" class="settings-form">
            <div class="form-grid">
              <label class="span-2">
                <span>身份(支持多选,Ctrl/⌘ 点击选多个)</span>
                <select name="send_as_ids" multiple size="6" id="scheduleSendAsSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
                <small class="muted">已选 <span id="scheduleSendAsCount">0</span> 个</small>
              </label>
              <label>
                <span>预设</span>
                <select name="preset_key">${presetOptions}</select>
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
              <label data-show-when="command">
                <span>自定义命令</span>
                <input name="command" placeholder="例如 .签到" />
              </label>
              <label data-show-when="interval_sec">
                <span>间隔 / CD(秒)</span>
                <input name="interval_sec" inputmode="numeric" value="3600" />
              </label>
              <label data-show-when="count">
                <span>次数</span>
                <input name="count" inputmode="numeric" value="3" />
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
              <span>自动锚点(按状态机算下一次可用,覆盖上面手填的锚点)</span>
            </label>
            <label class="toggle-row">
              <input type="checkbox" name="dry_run" checked />
              <span>仅预演(只在本地记录,不真正排到 Telegram)— 没登录或想试就开着</span>
            </label>
            <div class="form-actions">
              <button type="button" data-schedule-action="preview">预览计划</button>
              <button type="button" class="primary" data-schedule-action="create">创建</button>
            </div>
          </form>
          <p class="modal-status-line info" id="scheduleStatus" hidden></p>
          <div id="schedulePreview" class="send-as-result" hidden></div>
        </section>

        <section class="modal-section">
          <h4>对账 Telegram 端</h4>
          <p class="muted">拉 TG 的 GetScheduledHistory,跟本地批次对账,标出「TG 有 mini-web 没记录」(orphans) 和「本地标了已排但 TG 没找到」(lost) 的项。</p>
          <div class="form-grid">
            <label class="span-2">
              <span>对账身份</span>
              <select id="scheduleSyncSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
            </label>
          </div>
          <div class="form-actions">
            <button type="button" id="scheduleSyncButton">拉 TG 状态对账</button>
          </div>
          <p class="modal-status-line info" id="scheduleSyncStatus" hidden></p>
          <div id="scheduleSyncResult" class="send-as-result" hidden></div>
        </section>

        <section class="modal-section">
          <h4>本地排班记录</h4>
          <p class="muted">这些是 mini-web 自己存的批次。dry_run=False 那次会同时排到 Telegram;有 scheduled_msg_id 的就是真排上的。</p>
          <div id="scheduleBatchList">${renderScheduleBatches(deps, batches)}</div>
        </section>
      `,
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    bindScheduleModal(deps, dialog, presets, batches, templates);
  }

  function renderScheduleTemplateOptions(templates) {
    return (templates || [])
      .map((template) => `<option value="${escapeAttr(template.id)}">${escapeHtml(template.name || template.id)}</option>`)
      .join("");
  }

  function renderScheduleBatches(deps = {}, batches) {
    if (!batches.length) {
      return '<p class="empty inline">还没有任何官方定时批次。上面新建一个。</p>';
    }
    return batches
      .map((b) => {
        const items = (b.items || [])
          .map((m) => {
            const stat = m.status === "scheduled"
              ? `<span class="status-pill ok">已排</span>`
              : m.status === "failed"
                ? `<span class="status-pill risk">失败</span>`
                : `<span class="status-pill">planned</span>`;
            return `
              <li>
                <code>${escapeHtml(m.command)}</code>
                <small>${escapeHtml(m.schedule_text || "")}</small>
                ${stat}
                ${m.scheduled_msg_id ? `<small>TG #${m.scheduled_msg_id}</small>` : ""}
                ${m.last_error ? `<small class="error">${escapeHtml(m.last_error)}</small>` : ""}
              </li>
            `;
          })
          .join("");
        const counts = b.counts || {};
        const total = (counts.planned || 0) + (counts.scheduled || 0) + (counts.failed || 0);
        const done = (counts.scheduled || 0) + (counts.failed || 0);
        const pct = total ? Math.round((done / total) * 100) : 0;
        const statusKey = b.status || "active";
        const statusText = scheduleStatusText(statusKey, counts);
        const statusPill = scheduleStatusPill(statusKey);
        const showProgress = statusKey === "sending" || (counts.planned > 0 && counts.scheduled > 0);
        const cancelBtn = statusKey === "sending"
          ? `<button type="button" data-schedule-action="cancel" data-batch-id="${escapeAttr(String(b.id))}">取消</button>`
          : "";
        return `
          <article class="account-row" data-schedule-batch-id="${escapeAttr(String(b.id))}">
            <span class="account-row-dot ${statusKey === "sending" ? "live" : counts.failed ? "warn" : counts.scheduled ? "live" : "idle"}" aria-hidden="true"></span>
            <div class="account-row-body">
              <div class="account-row-title">
                <strong>${escapeHtml(b.label || b.preset_key)}</strong>
                ${statusPill}
                <span class="account-row-meta">send_as ${b.send_as_id}｜${b.anchor_text || ""}｜${b.horizon_days} 天｜${escapeHtml(statusText)}</span>
              </div>
              ${showProgress ? `<div class="schedule-progress"><div class="schedule-progress-bar" style="width:${pct}%"></div></div>` : ""}
              <ul class="schedule-item-list">${items}</ul>
            </div>
            <div class="account-row-actions">
              ${cancelBtn}
              <button type="button" data-schedule-action="delete" data-batch-id="${escapeAttr(String(b.id))}">删除</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function scheduleStatusText(statusKey, counts) {
    const c = counts || {};
    const total = (c.planned || 0) + (c.scheduled || 0) + (c.failed || 0);
    const done = (c.scheduled || 0) + (c.failed || 0);
    if (statusKey === "sending") return `发送中 ${done}/${total}${c.failed ? ` (${c.failed} 失败)` : ""}`;
    if (statusKey === "completed") return `已完成 ${c.scheduled || 0}/${total}`;
    if (statusKey === "partial_failed") return `部分失败 ${c.scheduled || 0}/${total}（${c.failed || 0} 失败）`;
    if (statusKey === "failed") return `全部失败`;
    if (statusKey === "cancelled") return `已取消 (排到 ${c.scheduled || 0}/${total})`;
    return `${c.scheduled || 0}/${total} 已排`;
  }

  function scheduleStatusPill(statusKey) {
    if (statusKey === "sending") return `<span class="status-pill warn">拟人发送中</span>`;
    if (statusKey === "completed") return `<span class="status-pill ok">完成</span>`;
    if (statusKey === "partial_failed") return `<span class="status-pill warn">部分失败</span>`;
    if (statusKey === "failed") return `<span class="status-pill risk">失败</span>`;
    if (statusKey === "cancelled") return `<span class="status-pill">已取消</span>`;
    return "";
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

  function bindScheduleModal(deps = {}, dialog, presets, _initialBatches, initialTemplates) {
    const form = dialog.querySelector("#scheduleForm");
    const status = dialog.querySelector("#scheduleStatus");
    const preview = dialog.querySelector("#schedulePreview");
    const batchList = dialog.querySelector("#scheduleBatchList");
    const syncButton = dialog.querySelector("#scheduleSyncButton");
    const syncSelect = dialog.querySelector("#scheduleSyncSelect");
    const syncStatus = dialog.querySelector("#scheduleSyncStatus");
    const syncResult = dialog.querySelector("#scheduleSyncResult");
    const templateSelect = dialog.querySelector("#scheduleTemplateSelect");
    const templateName = dialog.querySelector("#scheduleTemplateName");
    const templateStatus = dialog.querySelector("#scheduleTemplateStatus");
    const templateLoadButton = dialog.querySelector("#scheduleTemplateLoadButton");
    const templateSaveButton = dialog.querySelector("#scheduleTemplateSaveButton");
    const templateDeleteButton = dialog.querySelector("#scheduleTemplateDeleteButton");
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
    updateFieldVisibility();
    form.querySelector('[name="preset_key"]').addEventListener("change", updateFieldVisibility);

    const collectPayload = () => {
      const data = new FormData(form);
      const sendAsIds = data.getAll("send_as_ids").map((v) => Number(v)).filter(Boolean);
      const payload = {
        send_as_ids: sendAsIds,
        send_as_id: sendAsIds[0] || 0,
        preset_key: data.get("preset_key"),
        pet_name: (data.get("pet_name") || "").trim(),
        horizon_days: data.get("horizon_days") || 3,
        command: (data.get("command") || "").trim(),
        interval_sec: data.get("interval_sec") || 3600,
        count: data.get("count") || 1,
        dry_run: data.get("dry_run") === "on",
        auto_anchor: data.get("auto_anchor") === "on",
        trigger_command: (data.get("trigger_command") || "").trim(),
        offset_minutes: data.get("offset_minutes") || 0,
        offset_step_minutes: data.get("offset_step_minutes") || 5,
      };
      if (payload.auto_anchor) {
        payload.auto_anchor_module = data.get("preset_key");
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
      const sendAsSelect = dialog.querySelector("#scheduleSendAsSelect");
      if (sendAsSelect) {
        const selectedIds = new Set(
          (Array.isArray(payload.send_as_ids) ? payload.send_as_ids : [payload.send_as_id])
            .map((value) => Number(value))
            .filter(Boolean)
        );
        Array.from(sendAsSelect.options).forEach((option) => {
          option.selected = selectedIds.has(Number(option.value));
        });
        const count = dialog.querySelector("#scheduleSendAsCount");
        if (count) count.textContent = String(Array.from(sendAsSelect.selectedOptions).length);
      }
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
    if (sendAsSelect && sendAsCount) {
      const refreshCount = () => {
        sendAsCount.textContent = String(Array.from(sendAsSelect.selectedOptions).length);
      };
      sendAsSelect.addEventListener("change", refreshCount);
      refreshCount();
    }

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

    dialog.querySelectorAll("[data-schedule-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.scheduleAction;
        if (action === "preview") {
          setStatus("info", "计算预览…");
          try {
            const result = await postJson("/api/schedule/preview", collectPayload());
            if (!result.ok) throw new Error(result.error || "预览失败");
            showPreview(`
              <p>预设 <strong>${escapeHtml(result.preset_label)}</strong>｜锚点 ${escapeHtml(result.anchor_text)}${result.auto_anchor_used ? '<small class="status-pill ok" style="margin-left:6px">自动锚点</small>' : ""}｜首次发送 ${escapeHtml(result.first_due_text || result.anchor_text)}｜${result.horizon_days} 天</p>
              <ul class="send-as-result-list">
                ${(result.items || []).map((it) => `<li class="ok"><code>${escapeHtml(it.command)}</code> <small>${escapeHtml(it.schedule_text || "")}</small></li>`).join("") || "<li>(0 条)</li>"}
              </ul>
            `);
            setStatus("ok", `共 ${(result.items || []).length} 条`);
          } catch (error) {
            setStatus("error", error.message);
          }
          return;
        }
        if (action === "create") {
          if (!window.confirm("确认创建?dry_run 关掉的话会按拟人节奏后台发,可能要 30+ 分钟。")) return;
          btn.disabled = true;
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
              const totalMin = Math.round((result.total_estimate_seconds || 0) / 60);
              stats = `批量创建 ${result.batch_count} 个身份｜成功 ${okN}${failN ? `｜失败 ${failN}` : ""}｜阶梯 ${result.offset_step_minutes}min｜总预估 ${totalMin}min`;
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
                const mins = Math.round((result.estimate_seconds || 0) / 60);
                stats += `｜后台拟人发送中,预估 ${mins} 分钟｜可在下方批次列表里取消`;
                scheduleProgressPolling(deps, dialog, result.batch_id);
              } else {
                stats += `｜TG 排上 ${result.created_official}`;
              }
            }
            if (manualMessages.length) window.alert(manualMessages.join("\n\n"));
            setStatus(result.errors?.length || result.failed || manualMessages.length ? "warn" : "ok", scheduleStatusWithManualMessages(stats, manualMessages));
            const refreshed = await fetchJson("/api/schedule");
            if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
            bindScheduleBatchActions(deps, dialog);
          } catch (error) {
            setStatus("error", error.message);
          } finally {
            btn.disabled = false;
          }
          return;
        }
        if (action === "cancel") {
          const batchId = btn.dataset.batchId;
          if (!batchId) return;
          if (!window.confirm(`取消批次 #${batchId}?已经排到 TG 的会保留(可再点删除一并清掉)。`)) return;
          btn.disabled = true;
          try {
            const result = await postJson("/api/schedule/cancel", { batch_id: Number(batchId) });
            if (!result.ok) throw new Error(result.error || "取消失败");
            setStatus("ok", `批次 #${batchId} 已取消(后台 loop 在下条时退出)`);
            const refreshed = await fetchJson("/api/schedule");
            if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
            bindScheduleBatchActions(deps, dialog);
          } catch (error) {
            setStatus("error", error.message);
          } finally {
            btn.disabled = false;
          }
          return;
        }
        if (action === "delete") {
          const batchId = btn.dataset.batchId;
          if (!batchId) return;
          if (!window.confirm(`删除批次 #${batchId}?如果是真排过 TG,也会一起从 TG 取消。`)) return;
          btn.disabled = true;
          setStatus("info", "删除中…");
          try {
            const result = await postJson("/api/schedule/delete", { batch_id: Number(batchId) });
            if (!result.ok) throw new Error(result.error || "删除失败");
            setStatus("ok", `已删除批次 #${batchId}｜本地 ${result.local?.messages || 0} 条｜TG 取消 ${result.tg_deleted || 0} 条${result.tg_error ? `｜TG 错误:${result.tg_error}` : ""}`);
            const refreshed = await fetchJson("/api/schedule");
            if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
            bindScheduleBatchActions(deps, dialog);
          } catch (error) {
            setStatus("error", error.message);
          } finally {
            btn.disabled = false;
          }
          return;
        }
      });
    });
    bindScheduleBatchActions(deps, dialog);

    if (syncButton && syncSelect) {
      const setSyncStatus = (kind, text) => {
        syncStatus.hidden = !text;
        syncStatus.className = `modal-status-line ${kind}`;
        syncStatus.textContent = text || "";
      };
      syncButton.addEventListener("click", async () => {
        const sendAs = syncSelect.value;
        if (!sendAs) {
          setSyncStatus("warn", "请选身份");
          return;
        }
        syncButton.disabled = true;
        setSyncStatus("info", "正在调 GetScheduledHistory 对账…");
        try {
          const result = await fetchJson(`/api/schedule/sync?send_as_id=${encodeURIComponent(sendAs)}`);
          if (!result.ok) throw new Error(result.error || "对账失败");
          const tg = result.tg_messages || [];
          const matched = result.matched || [];
          const orphans = result.orphans || [];
          const lost = result.lost || [];
          setSyncStatus(orphans.length || lost.length ? "warn" : "ok", `TG ${tg.length} 条｜对得上 ${matched.length}｜TG 有本地没的 ${orphans.length}｜本地标排 TG 没找到 ${lost.length}`);
          syncResult.hidden = false;
          syncResult.innerHTML = `
            <p><strong>Telegram 端当前 ${tg.length} 条 scheduled message</strong></p>
            <ul class="send-as-result-list">
              ${tg.map((m) => `<li class="ok"><code>${escapeHtml(clipGraphemes(m.message || "", 40))}</code> <small>${escapeHtml(m.schedule_text || "")}｜TG #${m.scheduled_msg_id}</small></li>`).join("") || "<li>(空)</li>"}
            </ul>
            ${orphans.length ? `<p><strong>⚠ TG 有但 mini-web 没记录的 ${orphans.length} 条</strong>(可能是从其它工具或手机端排的):</p><ul class="send-as-result-list">${orphans.map((m) => `<li class="warn"><code>${escapeHtml(clipGraphemes(m.message || "", 40))}</code> <small>TG #${m.scheduled_msg_id}｜${escapeHtml(m.schedule_text || "")}</small></li>`).join("")}</ul>` : ""}
            ${lost.length ? `<p><strong>⚠ 本地标已排但 TG 找不到的 ${lost.length} 条</strong>(可能被 TG 端取消了):</p><ul class="send-as-result-list">${lost.map((m) => `<li class="warn"><code>${escapeHtml(m.command)}</code> <small>本地 #${m.id}｜TG 期望 #${m.scheduled_msg_id}</small></li>`).join("")}</ul>` : ""}
          `;
        } catch (error) {
          setSyncStatus("error", error.message);
        } finally {
          syncButton.disabled = false;
        }
      });
    }
  }

  function bindScheduleBatchActions(deps = {}, dialog) {
    dialog.querySelectorAll('[data-schedule-action="delete"]').forEach((btn) => {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`删除批次 #${batchId}?`)) return;
        try {
          const result = await postJson("/api/schedule/delete", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "删除失败");
          const refreshed = await fetchJson("/api/schedule");
          const batchList = dialog.querySelector("#scheduleBatchList");
          if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
          bindScheduleBatchActions(deps, dialog);
        } catch (error) {
          window.alert(error.message || "删除失败");
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
        try {
          const result = await postJson("/api/schedule/cancel", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "取消失败");
          const refreshed = await fetchJson("/api/schedule");
          const batchList = dialog.querySelector("#scheduleBatchList");
          if (batchList) batchList.innerHTML = renderScheduleBatches(deps, syncScheduleBatches(deps, refreshed));
          bindScheduleBatchActions(deps, dialog);
        } catch (error) {
          window.alert(error.message || "取消失败");
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
    renderScheduleRailRow,
    scheduleRailStatusClass,
    scheduleIdentityLabel,
    openScheduleModal,
    renderScheduleTemplateOptions,
    renderScheduleBatches,
    scheduleStatusText,
    scheduleStatusPill,
    scheduleManualMessages,
    scheduleStatusWithManualMessages,
    bindScheduleModal,
    bindScheduleBatchActions,
    scheduleProgressPolling,
  };
})();
