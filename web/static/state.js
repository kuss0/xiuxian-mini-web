// MINIWEB-MODULE: shared frontend state
(function () {
  "use strict";

  const state = {
    channels: [],
    selectedChannels: new Set(),
    messages: [],
    selectedMessageId: null,
    expandedMessages: new Set(),
    messageSearch: "",
    settings: null,
    accounts: [],
    identities: [],
    identityPatches: [],
    identityPatchesOwnerId: null,
    identityPatchesLoading: false,
    identityPatchesRequestSeq: 0,
    accountLimit: 0,
    identityLimit: 0,
    listenerSummary: null,
    messageAudit: null,
    telegramDialogs: [],
    telegramTopics: [],
    settingsNotice: "",
    outboxPlan: null,
    outboxDrafts: [],
    draftNoticeByMessageId: new Map(),
    detailMode: "message",
    refreshState: "idle",
    activeIdentityId: null,
    discoveredBots: [],
    worldSnapshot: null,
    worldSnapshotLoading: false,
    scheduleBatches: [],
    scheduleLoading: false,
    scheduleError: "",
    lastMessageSeq: 0,
    channelSummaryMessages: [],
    channelSummarySeq: 0,
    viewMode: "focus",
    sendAs: {
      peers: [],
      accountLocalId: "",
      selected: new Set(),
    },
    // 玩法状态机: Map<send_as_id(number), Array<{module_key,label,summary,state}>>
    identityModuleStates: new Map(),
    // 技能盘
    skills: [],
    skillGroups: [],
    skillBarTab: "日常",
    skillBarBusyKeys: new Set(),
    directSendIdentityId: null,
    directSendLastActiveId: null,
    directSendReply: null,
  };

  window.MiniwebState = { state };
})();
