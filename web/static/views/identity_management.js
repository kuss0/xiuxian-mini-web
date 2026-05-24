// MINIWEB-VIEW: sidebar identity list, add-identity modal, and send_as renderers
(function () {
  "use strict";

  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  function identityManagementState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderAddIdentityModalBody(deps = {}) {
    const state = identityManagementState(deps);
    const accountOptions = (state.accounts || [])
      .map((account) => {
        const label = `${account.label || account.local_id}｜${account.local_id}`;
        const status = account.login_status === "done" ? " ✓" : " (未登录)";
        return `<option value="${escapeAttr(account.local_id)}">${escapeHtml(label)}${status}</option>`;
      })
      .join("");
    const accountPickerOptions = `<option value="">选择账号</option>${accountOptions}`;
    return `
      <section class="modal-section">
        <h4>1. 选账号 + 拉可用身份</h4>
        <div class="form-grid">
          <label>
            <span>账号</span>
            <select data-send-as-field="account">${accountPickerOptions}</select>
          </label>
          <label>
            <span>目标群(可选)</span>
            <input data-send-as-field="target_chat" placeholder="留空走该账号的 target_chat" />
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="primary" data-send-as-action="load">获取可用身份</button>
          <button type="button" data-send-as-action="open-logout" hidden>退出此账号</button>
        </div>
        <p class="modal-status-line info" data-send-as-status>选账号后点「获取可用身份」,会拉出该账号在目标群里所有 send_as peer。</p>
      </section>

      <section class="modal-section">
        <h4>2. 勾选要添加的身份</h4>
        <div class="send-as-bulk-bar" hidden>
          <span data-send-as-summary></span>
          <div class="send-as-bulk-actions">
            <button type="button" data-send-as-action="select-all">全选</button>
            <button type="button" data-send-as-action="select-none">全不选</button>
            <button type="button" class="primary" data-send-as-action="batch-save">保存选中</button>
          </div>
        </div>
        <div data-send-as-list class="send-as-list"></div>
        <div data-send-as-result class="send-as-result" hidden></div>
      </section>

      <details class="modal-section">
        <summary>手动添加单条(GetSendAs 没列出来时用)</summary>
        <div>
          <div class="form-grid">
            <label>
              <span>身份 ID</span>
              <input id="manualSendAsId" placeholder="正数=TG 用户;负数=-100…频道 ID" />
            </label>
            <label>
              <span>显示名(可选)</span>
              <input id="manualLabel" placeholder="留空会用 Telegram 解析的名字" />
            </label>
          </div>
          <div class="form-actions">
            <button type="button" id="manualAddIdentityBtn">添加这一条</button>
          </div>
          <p class="modal-status-line info" id="manualAddStatus" hidden></p>
        </div>
      </details>
    `;
  }

  function identityRowStatusText(identity, account) {
    if (!identity.enabled) return "已停用";
    if (!account) return "未绑定账号";
    const loginStatus = account.login_status || "idle";
    if (loginStatus === "done") {
      if (identity.kind === "self") return "已登录｜以自己身份";
      if (identity.kind === "channel") return "已登录｜以频道身份";
      return "已登录";
    }
    if (loginStatus === "waiting_code") return "等验证码";
    if (loginStatus === "need_2fa") return "需要 2FA";
    if (loginStatus === "error") return "账号离线｜登录出错";
    return "账号未登录";
  }

  function identityRowIsOffline(identity, account) {
    if (!account) return true;
    const status = account.login_status || "idle";
    return status === "error" || status === "idle";
  }

  function buildProfileChips(patchMap) {
    const charName = patchMap.get("角色名") || "";
    const daohao = patchMap.get("道号") || "";
    const root = patchMap.get("灵根") || "";
    const realm = patchMap.get("境界") || "";
    const sect = (patchMap.get("宗门") || "").replace(/^【|】$/g, "");
    const title = (patchMap.get("称号") || "").replace(/^【|】$/g, "");
    const chips = [];
    if (charName || daohao) {
      const txt = [charName, daohao ? `· ${daohao}` : ""].filter(Boolean).join(" ").trim();
      chips.push(`<span class="row-chip">👤 ${escapeHtml(txt)}</span>`);
    }
    if (realm) chips.push(`<span class="row-chip realm">📿 ${escapeHtml(realm)}</span>`);
    if (root) chips.push(`<span class="row-chip root">🌿 ${escapeHtml(root)}</span>`);
    if (sect) chips.push(`<span class="row-chip sect">🏔️ ${escapeHtml(sect)}</span>`);
    if (title) chips.push(`<span class="row-chip title">🏷️ ${escapeHtml(title)}</span>`);
    if (!chips.length) return "";
    return `<div class="identity-row-profile">${chips.join("")}</div>`;
  }

  function renderSidebarIdentityList(deps = {}, container) {
    const state = identityManagementState(deps);
    if (!container) return;
    if (!state.identities?.length) {
      container.innerHTML = '<p class="empty">还没有身份。登录账号后会自动建好。</p>';
      deps.renderCultivationModules?.();
      return;
    }
    const patchMap = new Map((deps.activeIdentityPatches?.() || []).map((patch) => [patch.key, patch.value]));
    const accountsByLocalId = new Map((state.accounts || []).map((account) => [account.local_id, account]));
    container.innerHTML = state.identities.map((identity) => {
      const account = accountsByLocalId.get(identity.account_local_id);
      const status = identityRowStatusText(identity, account);
      const offline = identityRowIsOffline(identity, account);
      const active = Number(identity.send_as_id || 0) === Number(state.activeIdentityId || 0);
      const klass = ["identity-row", offline ? "offline" : "", active ? "active" : ""].filter(Boolean).join(" ");
      const name = identity.label || identity.username || identity.send_as_id;
      const profileChips = active ? buildProfileChips(patchMap) : "";
      return `
        <button type="button" class="${klass}" data-identity-row="${escapeAttr(String(identity.send_as_id))}">
          <div class="identity-row-head">
            <strong>${escapeHtml(String(name))}</strong>
            <span class="identity-row-status">${escapeHtml(status)}</span>
          </div>
          <div class="identity-row-sub">
            ${identity.username ? `@${escapeHtml(identity.username)}` : ""} <span class="muted">#${escapeHtml(String(identity.send_as_id))}</span>
          </div>
          ${profileChips}
        </button>
      `;
    }).join("");
    bindSidebarIdentityList(deps, container);
    deps.renderCultivationModules?.();
  }

  function bindSidebarIdentityList(deps = {}, container) {
    container?.querySelectorAll("[data-identity-row]").forEach((row) => {
      row.addEventListener("click", () => {
        const id = Number(row.dataset.identityRow);
        Promise.resolve(deps.setActiveIdentity?.(id, { toggle: true, loadPatches: true })).catch((err) => {
          console.warn("[mini-web] reload patches failed:", err);
          deps.showSkillToast?.(`切换身份失败: ${err.message || err}`, "err");
        });
      });
    });
  }

  function identityPeerKind(peer) {
    if (peer.kind === "self") {
      return "self";
    }
    if (peer.kind === "channel" || peer.kind === "supergroup") {
      return "channel";
    }
    return "self_unbound";
  }

  function defaultIdentityKindLabel(kind) {
    if (kind === "self") {
      return "自己 (self)";
    }
    if (kind === "channel") {
      return "频道 (channel)";
    }
    if (kind === "self_unbound") {
      return "未关联账号";
    }
    return "未识别";
  }

  function renderSendAsRow(deps = {}, peer) {
    const state = identityManagementState(deps);
    const id = String(peer.send_as_id);
    const already = deps.isSendAsAlreadyRegistered?.(peer) || false;
    const checked = state.sendAs?.selected?.has?.(id) || false;
    const kind = identityPeerKind(peer);
    const tag = deps.identityKindLabel?.(kind) || defaultIdentityKindLabel(kind);
    const username = peer.username ? `@${peer.username}` : "";
    const premium = peer.premium_required ? '<span class="status-pill warn">需 Premium</span>' : "";
    const alreadyBadge = already ? '<span class="status-pill ok">已添加</span>' : "";
    return `
      <label class="send-as-row${already ? " disabled" : ""}">
        <input type="checkbox" data-send-as-checkbox="${escapeAttr(id)}"
          ${checked ? "checked" : ""} ${already ? "disabled" : ""} />
        <span class="send-as-row-body">
          <span class="send-as-row-title">
            <strong>${escapeHtml(peer.title || id)}</strong>
            ${username ? `<small>${escapeHtml(username)}</small>` : ""}
          </span>
          <span class="send-as-row-meta">
            <span class="identity-kind ${escapeAttr(kind)}">${escapeHtml(tag)}</span>
            ｜send_as ${escapeHtml(id)}
            ${premium ? `｜${premium}` : ""}
            ${alreadyBadge ? `｜${alreadyBadge}` : ""}
          </span>
        </span>
        <button type="button" class="send-as-row-fill" data-send-as-fill="${escapeAttr(id)}" title="填到手动添加">填入</button>
      </label>
    `;
  }

  function renderBatchSaveResult(deps = {}, container, response, peers) {
    if (!container) return;
    if (!response || !Array.isArray(response.results) || response.results.length === 0) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    const peerById = new Map(peers.map((peer) => [String(peer.send_as_id), peer]));
    const items = response.results.map((entry) => {
      const peer = peerById.get(String(entry.send_as_id ?? ""));
      const title = peer ? (peer.title || peer.send_as_id) : (entry.send_as_id ?? "未知 ID");
      if (entry.ok) {
        return `<li class="ok">✓ ${escapeHtml(String(title))}</li>`;
      }
      return `<li class="warn">✗ ${escapeHtml(String(title))} — ${escapeHtml(entry.error || "保存失败")}</li>`;
    });
    container.hidden = false;
    container.innerHTML = `
      <p>批量保存结果:成功 ${response.saved || 0} / 共 ${response.total || response.results.length}</p>
      <ul class="send-as-result-list">${items.join("")}</ul>
    `;
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.identityManagement = {
    renderSidebarIdentityList,
    renderAddIdentityModalBody,
    renderSendAsRow,
    renderBatchSaveResult,
  };
})();
