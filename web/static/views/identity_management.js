// MINIWEB-VIEW: sidebar identity list, identity snapshot, identity module chips, add-identity modal, and send_as renderers
(function () {
  "use strict";

  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  const MODULE_ICONS = {
    deep_retreat: "📿",
    yuanying: "👻",
    second_soul: "🪞",
    pet_touch: "🖐️",
    pet_warm: "🔥",
    pet_trial: "🥊",
  };
  const SIDEBAR_MODULE_KEYS = new Set(Object.keys(MODULE_ICONS));

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
      const moduleLine = renderIdentityModulesLine(deps, identity.send_as_id);
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
          ${moduleLine}
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

  function renderIdentityModulesLine(deps = {}, sendAsId) {
    const state = identityManagementState(deps);
    const items = (state.identityModuleStates?.get?.(Number(sendAsId)) || [])
      .filter((item) => SIDEBAR_MODULE_KEYS.has(item.module_key));
    if (!items.length) return "";
    const nowSec = Date.now() / 1000;
    const parts = items.map((item) => {
      const icon = MODULE_ICONS[item.module_key] || "•";
      const summary = item.summary || {};
      const st = item.state || {};
      const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
      const startTs = deps.moduleStartTs?.(st) || 0;
      const label = item.label || item.module_key;
      const liveReady = summary.ready === true || (nextAt > 0 && nextAt <= nowSec) || nextAt === 0;
      if (liveReady) {
        return `<span class="module-chip module-ready">${escapeHtml(`${icon} ${label} 已就绪`)}</span>`;
      }
      const remaining = nextAt - nowSec;
      const total = Math.max(1, nextAt - startTs);
      const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      const text = remaining > 0 ? `剩 ${deps.fmtCountdown?.(remaining) || ""}` : "已就绪";
      return `
        <span class="module-chip module-waiting" data-module-chip="1"
              data-next-at="${escapeAttr(String(nextAt))}"
              data-start-at="${escapeAttr(String(startTs))}"
              data-icon="${escapeAttr(icon)}"
              data-label="${escapeAttr(label)}">
          <span class="module-chip-text">${escapeHtml(`${icon} ${label}`)} <span class="module-chip-time">${escapeHtml(text)}</span></span>
          <span class="module-chip-bar"><span class="module-chip-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
        </span>
      `;
    });
    return `<span class="identity-row-modules">${parts.join("")}</span>`;
  }

  function tickSidebarIdentityModuleChips(deps = {}, container) {
    if (!container) return;
    const chips = container.querySelectorAll('[data-module-chip="1"]');
    if (!chips.length) return;
    const nowSec = Date.now() / 1000;
    chips.forEach((chip) => {
      const nextAt = Number(chip.dataset.nextAt || 0);
      const startTs = Number(chip.dataset.startAt || 0);
      const icon = chip.dataset.icon || "";
      const label = chip.dataset.label || "";
      const remaining = nextAt - nowSec;
      if (remaining <= 0) {
        chip.classList.remove("module-waiting");
        chip.classList.add("module-ready");
        chip.removeAttribute("data-module-chip");
        chip.textContent = `${icon} ${label} 已就绪`;
        return;
      }
      const total = Math.max(1, nextAt - startTs);
      const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      const timeEl = chip.querySelector(".module-chip-time");
      const fillEl = chip.querySelector(".module-chip-bar-fill");
      if (timeEl) timeEl.textContent = `剩 ${deps.fmtCountdown?.(remaining) || ""}`;
      if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;
    });
  }

  function renderIdentitySnapshot(deps = {}, container) {
    const state = identityManagementState(deps);
    if (!container) return;
    const patches = deps.activeIdentityPatches?.() || [];
    const map = new Map(patches.map((item) => [item.key, item]));
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) {
      container.innerHTML = `
        <button class="role-button active" type="button">
          <span>未选择身份</span>
          <strong>请选择左侧身份</strong>
        </button>
        <div class="snapshot-grid">
          <p class="empty inline">选中身份后,这里显示对应角色状态。</p>
        </div>
      `;
      return;
    }
    if (state.identityPatchesLoading && map.size === 0) {
      container.innerHTML = `
        <button class="role-button active" type="button">
          <span>正在加载</span>
          <strong>角色状态</strong>
        </button>
        <div class="snapshot-grid">
          <p class="empty inline">正在读取当前身份的角色状态...</p>
        </div>
      `;
      return;
    }
    const primaryTitle =
      map.get("境界")?.value ||
      map.get("灵根")?.value ||
      "未识别角色";
    const rows = ["境界", "宗门", "灵根", "综合战力"]
      .filter((key) => map.has(key))
      .map((key) => {
        const item = map.get(key);
        return `
          <div>
            <span>${escapeHtml(key)}</span>
            <strong>${escapeHtml(item.value)}</strong>
          </div>
        `;
      })
      .join("");
    const updatedAt = [...map.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]?.updated_at || "";
    container.innerHTML = `
      <button class="role-button active" type="button">
        <span>${escapeHtml(updatedAt ? `更新 ${updatedAt}` : "等待消息箱投影")}</span>
        <strong>${escapeHtml(primaryTitle)}</strong>
      </button>
      <div class="snapshot-grid">
        ${rows || '<p class="empty inline">暂无角色状态。发送或监听“我的灵根 / 战力”后会更新。</p>'}
      </div>
    `;
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
    renderIdentityModulesLine,
    tickSidebarIdentityModuleChips,
    renderIdentitySnapshot,
    renderAddIdentityModalBody,
    renderSendAsRow,
    renderBatchSaveResult,
  };
})();
