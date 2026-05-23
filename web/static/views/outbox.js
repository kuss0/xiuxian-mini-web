// MINIWEB-VIEW: outbox draft modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

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

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.outbox = { openDraftsModal };
})();
