// MINIWEB-MODULE: Sidebar renderer
// 侧边栏渲染
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const { escapeHtml } = window.MiniwebFormat;
  const logger = window.MiniwebLogger || console;

  /**
   * 渲染侧边栏身份列表
   */
  function renderSidebarIdentityList() {
    const list = document.querySelector("#identityList");
    if (!list) return;

    const identities = state.identities || [];
    const activeId = Number(state.activeIdentityId || 0) || null;

    if (identities.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无身份</div>';
      return;
    }

    list.innerHTML = identities.map(identity => {
      const isActive = Number(identity.id) === activeId;
      return `
        <div class="identity-item ${isActive ? 'active' : ''}"
             onclick="selectIdentity('${identity.id}')">
          <div class="identity-avatar">${getIdentityAvatar(identity)}</div>
          <div class="identity-info">
            <div class="identity-name">${escapeHtml(identity.name || '')}</div>
            <div class="identity-level">Lv.${identity.level || 0}</div>
          </div>
        </div>
      `;
    }).join('');

    logger.debug('Sidebar identity list rendered:', identities.length);
  }

  /**
   * 获取身份头像
   */
  function getIdentityAvatar(identity) {
    // 使用名字首字符作为头像
    const name = identity.name || '?';
    return escapeHtml(name.charAt(0));
  }

  /**
   * 渲染当前账号行
   */
  function renderCurrentAccountLine() {
    const line = document.querySelector("#currentAccountLine");
    if (!line) return;

    const accounts = state.accounts || [];
    if (accounts.length === 0) {
      line.innerHTML = '<div class="empty-state">未登录</div>';
      return;
    }

    const account = accounts[0]; // 假设只有一个账号
    line.innerHTML = `
      <div class="account-info">
        <span class="account-name">${escapeHtml(account.phone || account.username || '未知')}</span>
        <button onclick="openAccountSettings()">设置</button>
      </div>
    `;

    logger.debug('Current account line rendered');
  }

  /**
   * 渲染技能视图
   */
  function renderSkillViews() {
    const container = document.querySelector("#skillBarChips");
    if (!container) return;

    const skills = state.skills || [];
    if (skills.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无技能</div>';
      return;
    }

    container.innerHTML = skills.map(skill => `
      <div class="skill-chip" onclick="useSkill('${skill.id}')">
        <span class="skill-icon">${escapeHtml(skill.icon || '🎯')}</span>
        <span class="skill-name">${escapeHtml(skill.name || '')}</span>
        ${skill.cooldown ? `<span class="skill-cooldown">${skill.cooldown}s</span>` : ''}
      </div>
    `).join('');

    logger.debug('Skill views rendered:', skills.length);
  }

  /**
   * 渲染身份配置文件视图
   */
  function renderIdentityProfileViews() {
    const container = document.querySelector("#identityProfileViews");
    if (!container) return;

    const patches = getActiveIdentityPatches();
    if (patches.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无配置</div>';
      return;
    }

    container.innerHTML = patches.map(patch => `
      <div class="profile-patch">
        <div class="patch-key">${escapeHtml(patch.key || '')}</div>
        <div class="patch-value">${escapeHtml(String(patch.value || ''))}</div>
      </div>
    `).join('');

    logger.debug('Identity profile views rendered:', patches.length);
  }

  /**
   * 获取活跃身份的补丁
   */
  function getActiveIdentityPatches() {
    if (window.MiniwebIdentityLoader) {
      return window.MiniwebIdentityLoader.activeIdentityPatches();
    }
    return [];
  }

  // 导出
  window.MiniwebSidebarRenderer = {
    renderSidebarIdentityList,
    renderCurrentAccountLine,
    renderSkillViews,
    renderIdentityProfileViews,
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('sidebarRenderer', window.MiniwebSidebarRenderer);
  }

  logger.info('Sidebar renderer initialized');
})();
