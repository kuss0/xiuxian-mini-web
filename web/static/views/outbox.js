// MINIWEB-VIEW: outbox drafts and send-plan automation panel
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  function outboxState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  async function openDraftsModal({
    copyCommandToClipboard,
    deleteOutboxDraft,
    fetchMessageById,
    findMessageById,
    getDrafts,
    loadOutboxDrafts,
    selectMessage,
  }) {
    const dialog = openModal({
      title: "草稿箱",
      body: '<p class="empty">正在读取草稿箱...</p>',
    });
    if (!dialog) return;
    const root = dialog.querySelector(".modal-body") || dialog;

    const render = async () => {
      await loadOutboxDrafts();
      renderDrafts(root, getDrafts(), {
        copyCommandToClipboard,
        deleteOutboxDraft,
        fetchMessageById,
        findMessageById,
        render,
        selectMessage,
      });
    };

    await render();
  }

  function renderDrafts(root, drafts, deps) {
    if (!drafts.length) {
      root.innerHTML = `
        <div class="detail-block">
          <h4>草稿箱</h4>
          <p>当前没有等待人工确认的动作草稿。可以在某条消息的「动作草稿」区里点「确认入队」,把命令放进这里。</p>
        </div>
      `;
      return;
    }
    const items = drafts.map(renderDraftItem).join("");
    root.innerHTML = `
      <div class="detail-block">
        <div class="draft-head-row">
          <h4>草稿箱</h4>
          <span>${drafts.length} 条等待人工确认</span>
        </div>
        <p>这些是已经入队、等待你人工确认或删除的命令草稿。本工具不会自动发出去。</p>
        <div class="draft-list">${items}</div>
      </div>
    `;
    bindDraftButtons(root, drafts, deps);
  }

  function renderDraftItem(draft) {
    const status = draft.resolved ? "已解析" : "上下文未补齐";
    const statusClass = draft.resolved ? "ok" : "warn";
    const meta = [
      draft.target_chat ? `群 ${draft.target_chat}` : draft.chat_id ? `群 ${draft.chat_id}` : "",
      draft.identity_id ? `身份 ${draft.identity_id}` : "",
      draft.account_local_id ? `账号 ${draft.account_local_id}` : "",
      draft.reply_to_msg_id ? `回复 ${draft.reply_to_msg_id}` : "",
      draft.created_at ? `入队 ${draft.created_at}` : "",
    ]
      .filter(Boolean)
      .join("｜");
    return `
      <article class="draft-item" data-draft-id="${escapeAttr(draft.id)}">
        <div class="draft-head">
          <code class="draft-command">${escapeHtml(draft.command || "（空命令）")}</code>
          <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
        </div>
        ${meta ? `<p class="draft-meta">${escapeHtml(meta)}</p>` : ""}
        ${draft.source_message_id ? `<p class="draft-meta">来源 ${escapeHtml(draft.source_message_id)}</p>` : ""}
        <div class="draft-buttons">
          <button type="button" data-draft-action="copy">复制命令</button>
          <button type="button" data-draft-action="open" data-source-id="${escapeAttr(draft.source_message_id || "")}">查看原消息</button>
          <button type="button" class="danger" data-draft-action="delete">删除草稿</button>
        </div>
      </article>
    `;
  }

  function bindDraftButtons(root, drafts, deps) {
    root.querySelectorAll(".draft-item").forEach((article) => {
      const draftId = article.dataset.draftId;
      article.querySelectorAll("[data-draft-action]").forEach((button) => {
        button.addEventListener("click", async () => {
          const action = button.dataset.draftAction;
          const draft = drafts.find((item) => item.id === draftId);
          if (!draft) return;

          if (action === "copy") {
            await deps.copyCommandToClipboard(draft.command || "", button);
            return;
          }

          if (action === "open") {
            await openSourceMessage(button.dataset.sourceId, deps);
            return;
          }

          if (action === "delete") {
            await deleteDraft(draftId, button, deps);
          }
        });
      });
    });
  }

  async function openSourceMessage(sourceId, deps) {
    if (!sourceId) return;
    let message = deps.findMessageById(sourceId);
    if (!message) {
      message = await deps.fetchMessageById(sourceId);
    }
    if (message) {
      closeModal();
      deps.selectMessage(message);
    }
  }

  async function deleteDraft(draftId, button, deps) {
    if (!window.confirm("删除这条草稿?")) {
      return;
    }
    button.disabled = true;
    const result = await deps.deleteOutboxDraft(draftId);
    if (result.ok) {
      await deps.render();
    } else {
      button.disabled = false;
      window.alert(result.error || "删除失败");
    }
  }

  function renderOutboxPlan(deps = {}, plan, action, container) {
    if (!container) {
      return;
    }
    if (!plan?.ok) {
      renderOutboxPlanError(deps, new Error(plan?.error || "发送计划生成失败"), container);
      return;
    }

    const missingText = (plan.missing || []).map(missingLabel).join("、");
    const statusText = plan.resolved ? "已解析" : `待补齐：${missingText || "上下文"}`;
    const statusClass = plan.resolved ? "ok" : "warn";
    container.innerHTML = `
      <div class="outbox-plan">
        <div class="outbox-plan-head">
          <h5>发送计划</h5>
          <span class="status-pill ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        <div class="plan-grid">
          <div><span>命令</span><code>${escapeHtml(plan.command)}</code></div>
          <div><span>目标</span><strong>${escapeHtml(planTargetLabel(plan))}</strong></div>
          <div><span>回复</span><strong>${escapeHtml(plan.reply_to_msg_id ?? "不回复特定消息")}</strong></div>
          <div><span>身份</span><strong>${escapeHtml(planIdentityLabel(plan))}</strong></div>
          <div><span>账号</span><strong>${escapeHtml(planAccountLabel(plan))}</strong></div>
          <div><span>发送</span><strong>${plan.can_send ? "可人工确认发送" : "仅复制/计划"}</strong></div>
        </div>
        <div class="plan-controls">
          <label>
            <span>改用身份</span>
            <select data-plan-field="identity_id">
              ${renderPlanIdentityOptions(deps, plan.identity_id)}
            </select>
          </label>
          <label>
            <span>改用账号</span>
            <select data-plan-field="account_local_id">
              ${renderPlanAccountOptions(deps, plan.account_local_id)}
            </select>
          </label>
        </div>
        <div class="form-actions outbox-actions">
          <button type="button" data-plan-action="copy">复制命令</button>
          <button type="button" data-plan-action="replan">重新解析</button>
          <button type="button" data-plan-action="auto-plan">自动策略</button>
          <button type="button" data-plan-action="auto-dispatch">演练/调度</button>
          <button type="button" data-plan-action="auto-queue">加入自动队列</button>
        </div>
        <div class="outbox-automation" data-plan-automation hidden></div>
        <p>${escapeHtml(plan.note || "动作只生成手动计划，不会自动发送。")}</p>
      </div>
    `;
    bindOutboxPlanControls(deps, container, action);
  }

  function renderOutboxPlanError(deps = {}, error, container) {
    if (!container) {
      return;
    }
    container.innerHTML = `
      <div class="outbox-plan">
        <div class="outbox-plan-head">
          <h5>发送计划</h5>
          <span class="status-pill risk">失败</span>
        </div>
        <p class="error">${escapeHtml(error.message)}</p>
      </div>
    `;
  }

  function renderOutboxAutomationResult(deps = {}, result, container) {
    const target = container?.querySelector("[data-plan-automation]");
    if (!target) {
      return;
    }
    const automation = result?.automation || {};
    const dispatched = Boolean(result?.sent);
    const canAuto = Boolean(automation.can_auto_dispatch);
    const status = dispatched
      ? "已自动调度"
      : result?.dry_run
        ? "演练通过"
        : canAuto
          ? "可自动"
          : "需人工";
    const statusClass = dispatched || result?.dry_run || canAuto ? "ok" : "warn";
    const message = result?.error || result?.message || automation.message || "无自动策略信息";
    target.hidden = false;
    target.innerHTML = `
      <div class="outbox-plan-head">
        <h5>自动策略</h5>
        <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
      </div>
      <div class="plan-grid compact">
        <div><span>技能</span><strong>${escapeHtml(automation.skill_key || "未识别")}</strong></div>
        <div><span>模式</span><strong>${automation.dry_run ? "dry-run" : "真实调度"}</strong></div>
        <div><span>原因</span><strong>${escapeHtml(automation.reason || "unknown")}</strong></div>
        <div><span>适配器</span><strong>${escapeHtml(automation.adapter || "user_session")}</strong></div>
        ${result?.worker ? `<div><span>队列</span><strong>${escapeHtml(result.worker.pending_count ?? 0)} 待处理</strong></div>` : ""}
      </div>
      <p>${escapeHtml(message)}</p>
      ${automation.idempotency_key ? `<p class="draft-meta">幂等 ${escapeHtml(automation.idempotency_key)}</p>` : ""}
    `;
  }

  function renderOutboxAutomationError(deps = {}, error, container) {
    const target = container?.querySelector("[data-plan-automation]");
    if (!target) {
      renderOutboxPlanError(deps, error, container);
      return;
    }
    target.hidden = false;
    target.innerHTML = `
      <div class="outbox-plan-head">
        <h5>自动策略</h5>
        <span class="status-pill risk">失败</span>
      </div>
      <p class="error">${escapeHtml(error.message || String(error))}</p>
    `;
  }

  function bindOutboxPlanControls(deps = {}, container, action) {
    const copyButton = container.querySelector('[data-plan-action="copy"]');
    const replanButton = container.querySelector('[data-plan-action="replan"]');
    const autoPlanButton = container.querySelector('[data-plan-action="auto-plan"]');
    const autoDispatchButton = container.querySelector('[data-plan-action="auto-dispatch"]');
    const autoQueueButton = container.querySelector('[data-plan-action="auto-queue"]');
    if (copyButton) {
      copyButton.addEventListener("click", async () => {
        if (deps.copyCommandToClipboard) {
          await deps.copyCommandToClipboard(action.command, copyButton);
          return;
        }
        try {
          await navigator.clipboard.writeText(action.command);
          copyButton.textContent = "已复制";
          setTimeout(() => {
            copyButton.textContent = "复制命令";
          }, 1200);
        } catch (error) {
          copyButton.textContent = "复制失败";
        }
      });
    }
    if (replanButton) {
      replanButton.addEventListener("click", async () => {
        replanButton.disabled = true;
        try {
          const nextAction = actionWithPlanOverrides(action, container);
          const plan = await deps.planOutboxAction?.(nextAction);
          renderOutboxPlan(deps, plan, nextAction, container);
        } catch (error) {
          renderOutboxPlanError(deps, error, container);
        } finally {
          replanButton.disabled = false;
        }
      });
    }
    if (autoPlanButton) {
      autoPlanButton.addEventListener("click", async () => {
        autoPlanButton.disabled = true;
        try {
          const nextAction = actionWithPlanOverrides(action, container);
          const plan = await deps.planOutboxAutomation?.(nextAction);
          renderOutboxAutomationResult(deps, plan, container);
        } catch (error) {
          renderOutboxAutomationError(deps, error, container);
        } finally {
          autoPlanButton.disabled = false;
        }
      });
    }
    if (autoDispatchButton) {
      autoDispatchButton.addEventListener("click", async () => {
        autoDispatchButton.disabled = true;
        try {
          const nextAction = actionWithPlanOverrides(action, container);
          const result = await deps.dispatchOutboxAutomation?.(nextAction);
          renderOutboxAutomationResult(deps, result, container);
          autoDispatchButton.textContent = result?.sent ? "已调度" : result?.dry_run ? "已演练" : "未调度";
          setTimeout(() => {
            autoDispatchButton.textContent = "演练/调度";
          }, 1400);
        } catch (error) {
          renderOutboxAutomationError(deps, error, container);
        } finally {
          autoDispatchButton.disabled = false;
        }
      });
    }
    if (autoQueueButton) {
      autoQueueButton.addEventListener("click", async () => {
        autoQueueButton.disabled = true;
        try {
          const nextAction = actionWithPlanOverrides(action, container);
          const result = await deps.queueOutboxAutomation?.(nextAction);
          renderOutboxAutomationResult(deps, result, container);
          autoQueueButton.textContent = result?.ok ? "已入队" : "未入队";
          setTimeout(() => {
            autoQueueButton.textContent = "加入自动队列";
          }, 1400);
        } catch (error) {
          renderOutboxAutomationError(deps, error, container);
        } finally {
          autoQueueButton.disabled = false;
        }
      });
    }
  }

  function actionWithPlanOverrides(action, container) {
    const nextAction = { ...action };
    const identityValue = container.querySelector('[data-plan-field="identity_id"]')?.value || "";
    const accountValue = container.querySelector('[data-plan-field="account_local_id"]')?.value || "";
    if (identityValue) {
      nextAction.identity_id = Number(identityValue);
    } else {
      delete nextAction.identity_id;
    }
    if (accountValue) {
      nextAction.account_local_id = accountValue;
    } else {
      delete nextAction.account_local_id;
    }
    return nextAction;
  }

  function renderPlanIdentityOptions(deps = {}, selectedId) {
    const selected = selectedId !== undefined && selectedId !== null ? String(selectedId) : "";
    const options = (outboxState(deps).identities || [])
      .map((identity) => {
        const value = String(identity.send_as_id);
        const label = `${identity.label || identity.username || value}｜${value}`;
        return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    return `<option value="" ${selected ? "" : "selected"}>不指定身份</option>${options}`;
  }

  function renderPlanAccountOptions(deps = {}, selectedLocalId) {
    const selected = String(selectedLocalId || "");
    const options = (outboxState(deps).accounts || [])
      .map((account) => {
        const value = account.local_id;
        const label = `${account.label || value}｜${value}`;
        return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    return `<option value="" ${selected ? "" : "selected"}>按身份绑定/不指定</option>${options}`;
  }

  function missingLabel(key) {
    const labels = {
      identity: "身份",
      account: "发送账号",
      target_chat: "目标群",
    };
    return labels[key] || key;
  }

  function planTargetLabel(plan) {
    if (plan.chat_id !== undefined && plan.chat_id !== null) {
      return `群 ${plan.chat_id}`;
    }
    if (plan.target_chat) {
      return plan.target_chat;
    }
    return "未解析";
  }

  function planIdentityLabel(plan) {
    if (plan.identity) {
      return `${plan.identity.label || plan.identity.username || plan.identity.send_as_id}｜${plan.identity.send_as_id}`;
    }
    if (plan.identity_id !== undefined && plan.identity_id !== null) {
      return `未登记身份 ${plan.identity_id}`;
    }
    return "未指定";
  }

  function planAccountLabel(plan) {
    if (plan.account) {
      return `${plan.account.label || plan.account.local_id}｜${plan.account.local_id}`;
    }
    if (plan.account_local_id) {
      return `未保存账号 ${plan.account_local_id}`;
    }
    return "未指定";
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.outbox = {
    openDraftsModal,
    renderOutboxPlan,
    renderOutboxPlanError,
    renderOutboxAutomationResult,
    renderOutboxAutomationError,
    actionWithPlanOverrides,
    renderPlanIdentityOptions,
    renderPlanAccountOptions,
    missingLabel,
    planTargetLabel,
    planIdentityLabel,
    planAccountLabel,
  };
})();
