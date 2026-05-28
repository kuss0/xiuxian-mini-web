// MINIWEB-MODULE: DOM references
// 集中管理所有 DOM 元素引用
(function() {
  "use strict";

  window.MiniwebDomRefs = {
    // 频道过滤
    channelFilters: document.querySelector("#channelFilters"),
    quickFilters: document.querySelector("#quickFilters"),
    selectAllChannels: document.querySelector("#selectAllChannels"),

    // 消息列表
    messageList: document.querySelector("#messageList"),
    messageCount: document.querySelector("#messageCount"),
    messageSearchInput: document.querySelector("#messageSearchInput"),
    activeChannelText: document.querySelector("#activeChannelText"),
    streamActiveChannelText: document.querySelector("#streamActiveChannelText"),
    jumpToLatestButton: document.querySelector("#jumpToLatest"),

    // 布局
    layoutGrid: document.querySelector(".layout-grid"),

    // 详情面板
    detailBackdrop: document.querySelector("#detailBackdrop"),
    detailPanel: document.querySelector("#detailPanel"),
    detailState: document.querySelector("#detailState"),
    closeDetailButton: document.querySelector("#closeDetailButton"),

    // 身份快照
    identitySnapshot: document.querySelector("#identitySnapshot"),

    // 工具按钮
    refreshButton: document.querySelector("#refreshButton"),
    healthButton: document.querySelector("#healthButton"),

    // 发送栏
    directSendComposer: document.querySelector("#directSendComposer"),
    directSendIdentityLine: document.querySelector("#directSendIdentityLine"),
    directSendIdentitySelect: document.querySelector("#directSendIdentitySelect"),
    directSendInput: document.querySelector("#directSendInput"),
    directSendSubmit: document.querySelector("#directSendSubmit"),
    directSendStatus: document.querySelector("#directSendStatus"),
    directSendReplyContext: document.querySelector("#directSendReplyContext"),
    directSendSelectionContext: document.querySelector("#directSendSelectionContext"),
    directSendActionHints: document.querySelector("#directSendActionHints"),
    emojiPickerButton: document.querySelector("#emojiPickerButton"),
    directSendEmojiPalette: document.querySelector("#directSendEmojiPalette"),
    directSendSkillPanel: document.querySelector("#directSendSkillPanel"),

    // 功能按钮
    openSkillMenuButton: document.querySelector("#openSkillMenuButton"),
    openCultivationButton: document.querySelector("#openCultivationButton"),
    outboxButton: document.querySelector("#outboxButton"),
    scheduleButton: document.querySelector("#scheduleButton"),
    scheduleRail: document.querySelector("#scheduleRail"),
    scheduleRailRefreshButton: document.querySelector("#scheduleRailRefreshButton"),
    logsButton: document.querySelector("#logsButton"),
    dungeonStatusButton: document.querySelector("#dungeonStatusButton"),
    resourceStatsButton: document.querySelector("#resourceStatsButton"),
    inventoryButton: document.querySelector("#inventoryButton"),
    settingsButton: document.querySelector("#settingsButton"),

    // 账号管理
    loginAccountButton: document.querySelector("#loginAccountButton"),
    addIdentityButton: document.querySelector("#addIdentityButton"),
    logoutAccountButton: document.querySelector("#logoutAccountButton"),
    currentAccountLine: document.querySelector("#currentAccountLine"),

    // 技能栏
    skillBarTabs: document.querySelector("#skillBarTabs"),
    skillBarChips: document.querySelector("#skillBarChips"),
    skillBarIdentity: document.querySelector("#skillBarIdentity"),

    // 游戏驾驶舱
    gameCockpit: document.querySelector("#gameCockpit"),
    cockpitIdentity: document.querySelector("#cockpitIdentity"),
    cockpitModules: document.querySelector("#cockpitModules"),
    cockpitInbox: document.querySelector("#cockpitInbox"),

    // 游戏 HUD
    gameHud: document.querySelector("#gameHud"),
    hudIdentity: document.querySelector("#hudIdentity"),
    hudModules: document.querySelector("#hudModules"),
    hudInbox: document.querySelector("#hudInbox"),

    // 游戏面板
    gamePrimaryStrip: document.querySelector("#gamePrimaryStrip"),
    liveSituationBoard: document.querySelector("#liveSituationBoard"),
    worldEventStrip: document.querySelector("#worldEventStrip"),
    gameSceneBoard: document.querySelector("#gameSceneBoard"),
    questTracker: document.querySelector("#questTracker"),
    gameActionDock: document.querySelector("#gameActionDock"),
    quickActionHotbar: document.querySelector("#quickActionHotbar"),

    // 侧边栏
    sidebarIdentityList: document.querySelector("#identityList"),

    // 设置按钮
    gameBotsButton: document.querySelector("#gameBotsButton"),
    notifySettingsButton: document.querySelector("#notifySettingsButton"),
    filterSettingsButton: document.querySelector("#filterSettingsButton"),

    // 全局横幅
    globalBanner: document.querySelector("#globalBanner"),

    // 模态框
    modalRoot: document.querySelector("#modalRoot"),

    // 视图模式按钮（当前未使用）
    viewModeAllButton: null,
    viewModeSoloButton: null,
  };

  console.log('[mini-web] DOM references loaded');
})();
