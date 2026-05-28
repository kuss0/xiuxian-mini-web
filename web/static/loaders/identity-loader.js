// MINIWEB-MODULE: Identity loader
// 身份和身份状态加载管理
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { fetchJson } = window.MiniwebApi;
  const logger = window.MiniwebLogger || console;
  const errorHandler = window.MiniwebErrorHandler;

  /**
   * 确保有活跃身份
   */
  function ensureActiveIdentity() {
    if (!state.identities || state.identities.length === 0) {
      state.activeIdentityId = null;
      return;
    }
    const currentId = Number(state.activeIdentityId || 0) || null;
    const exists = state.identities.some(id => Number(id.id) === currentId);
    if (!exists) {
      state.activeIdentityId = state.identities[0]?.id || null;
    }
  }

  /**
   * 加载身份列表
   * @returns {Promise<Object>} 身份数据
   */
  async function loadIdentities() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/identities");
        state.identities = payload.identities || [];
        state.identityLimit = payload.max_identities || 0;

        const previousActiveId = Number(state.activeIdentityId || 0) || null;
        ensureActiveIdentity();
        const activeChanged = previousActiveId !== (Number(state.activeIdentityId || 0) || null);

        // 触发 UI 更新
        if (window.renderSidebarIdentityList) window.renderSidebarIdentityList();
        if (window.renderSkillViews) window.renderSkillViews();
        if (window.renderDirectSendComposer) window.renderDirectSendComposer();
        if (window.renderGameCockpit) window.renderGameCockpit();

        // 如果活跃身份改变，重新加载补丁
        if (activeChanged && previousActiveId !== null) {
          loadIdentityPatches({ reset: true }).catch((err) =>
            logger.warn('Reload patches after identity refresh failed:', err)
          );
        }

        // 加载身份状态
        await loadIdentityModuleStates();

        logger.debug('Identities loaded:', payload.identities?.length || 0);
        return payload;
      },
      { context: 'loadIdentities', fallback: { identities: [], max_identities: 0 } }
    );
  }

  /**
   * 加载身份模块状态
   * @returns {Promise<void>}
   */
  async function loadIdentityModuleStates() {
    return errorHandler.wrapApiCall(
      async () => {
        const payload = await fetchJson("/api/identity-state");
        const map = new Map();
        for (const entry of payload.by_identity || []) {
          map.set(Number(entry.identity_id), entry);
        }
        state.identityModuleStates = map;

        // 触发 UI 更新
        if (window.renderSkillViews) window.renderSkillViews();
        if (window.renderGameCockpit) window.renderGameCockpit();

        logger.debug('Identity module states loaded:', map.size);
      },
      { context: 'loadIdentityModuleStates', showToast: false }
    );
  }

  /**
   * 获取活跃身份的补丁
   * @returns {Array} 补丁列表
   */
  function activeIdentityPatches() {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return [];
    return (state.identityPatches || []).filter(
      (patch) => Number(patch.identity_id) === activeId
    );
  }

  /**
   * 清除活跃身份的补丁
   */
  function clearIdentityPatchesForActive() {
    const activeId = Number(state.activeIdentityId || 0) || null;
    if (!activeId) return;
    state.identityPatches = (state.identityPatches || []).filter(
      (patch) => Number(patch.identity_id) !== activeId
    );
  }

  /**
   * 加载身份补丁
   * @param {Object} options - 选项
   * @param {boolean} options.reset - 是否重置
   * @param {boolean} options.silent - 静默模式
   * @returns {Promise<void>}
   */
  async function loadIdentityPatches(options = {}) {
    const { reset = false, silent = false } = options;

    return errorHandler.wrapApiCall(
      async () => {
        const activeId = Number(state.activeIdentityId || 0) || null;
        if (!activeId) {
          state.identityPatches = [];
          if (window.renderIdentityProfileViews) window.renderIdentityProfileViews();
          return;
        }

        const params = new URLSearchParams({
          identity_id: String(activeId),
          limit: "50",
        });

        if (!reset && state.identityPatchesMaxSeq > 0) {
          params.set("since_seq", String(state.identityPatchesMaxSeq));
        }

        const payload = await fetchJson(`/api/identity-patches?${params.toString()}`);
        const incoming = payload.patches || [];

        if (reset || !state.identityPatches) {
          state.identityPatches = incoming;
        } else {
          const byId = new Map(state.identityPatches.map((p) => [p.id, p]));
          for (const patch of incoming) {
            byId.set(patch.id, patch);
          }
          state.identityPatches = Array.from(byId.values());
        }

        const maxSeq = Math.max(
          state.identityPatchesMaxSeq || 0,
          ...incoming.map((p) => Number(p.seq || 0))
        );
        if (maxSeq > 0) {
          state.identityPatchesMaxSeq = maxSeq;
        }

        // 触发 UI 更新
        if (window.renderIdentityProfileViews) window.renderIdentityProfileViews();

        logger.debug('Identity patches loaded:', incoming.length);
      },
      { context: 'loadIdentityPatches', showToast: !silent }
    );
  }

  // 导出
  window.MiniwebIdentityLoader = {
    loadIdentities,
    loadIdentityModuleStates,
    loadIdentityPatches,
    activeIdentityPatches,
    clearIdentityPatchesForActive,
    ensureActiveIdentity,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('identityLoader', window.MiniwebIdentityLoader);
  }

  logger.info('Identity loader initialized');
})();
