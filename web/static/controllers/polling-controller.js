// MINIWEB-MODULE: Polling controller
// 轮询控制器 - 管理所有定时轮询任务
(function() {
  "use strict";

  const { state } = window.MiniwebState;
  const {
    POLL_INTERVAL_MS,
    ACCOUNT_POLL_INTERVAL_MS,
    BOT_DISCOVERY_POLL_INTERVAL_MS,
    HEALTH_POLL_INTERVAL_MS,
    IDENTITY_STATE_POLL_INTERVAL_MS,
    WORLD_SNAPSHOT_POLL_INTERVAL_MS,
  } = window.MiniwebConstants;

  // 轮询状态
  let pollTimer = null;
  let nextAccountsPollAt = 0;
  let nextBotDiscoveryPollAt = 0;
  let nextHealthPollAt = 0;
  let nextIdentityStatePollAt = 0;
  let nextWorldSnapshotPollAt = 0;
  let nextSchedulePollAt = 0;

  /**
   * 轮询 tick - 检查并执行到期的轮询任务
   */
  async function pollTick() {
    const now = Date.now();

    try {
      // 账号轮询
      if (now >= nextAccountsPollAt) {
        nextAccountsPollAt = now + ACCOUNT_POLL_INTERVAL_MS;
        if (window.loadAccounts) {
          await window.loadAccounts().catch(err => {
            console.warn("[mini-web] accounts poll failed:", err);
          });
        }
      }

      // Bot 发现轮询
      if (now >= nextBotDiscoveryPollAt) {
        nextBotDiscoveryPollAt = now + BOT_DISCOVERY_POLL_INTERVAL_MS;
        if (window.loadDiscoveredBots) {
          await window.loadDiscoveredBots().catch(err => {
            console.warn("[mini-web] bot discovery poll failed:", err);
          });
        }
      }

      // 健康检查轮询
      if (now >= nextHealthPollAt) {
        nextHealthPollAt = now + HEALTH_POLL_INTERVAL_MS;
        if (window.loadMessageAudit) {
          await window.loadMessageAudit({ silent: true }).catch(err => {
            console.warn("[mini-web] health poll failed:", err);
          });
        }
      }

      // 世界快照轮询
      if (now >= nextWorldSnapshotPollAt) {
        nextWorldSnapshotPollAt = now + WORLD_SNAPSHOT_POLL_INTERVAL_MS;
        if (window.loadWorldSnapshot) {
          await window.loadWorldSnapshot({ silent: true }).catch(err => {
            console.warn("[mini-web] world snapshot poll failed:", err);
          });
        }
      }

      // 定时任务轮询
      if (now >= nextSchedulePollAt) {
        nextSchedulePollAt = now + ACCOUNT_POLL_INTERVAL_MS;
        if (window.loadScheduledMessages) {
          await window.loadScheduledMessages({ silent: true }).catch(err => {
            console.warn("[mini-web] schedule poll failed:", err);
          });
        }
      }

      // 身份状态轮询
      if (now >= nextIdentityStatePollAt) {
        nextIdentityStatePollAt = now + IDENTITY_STATE_POLL_INTERVAL_MS;
        if (window.loadIdentityModuleStates) {
          await window.loadIdentityModuleStates().catch(err => {
            console.warn("[mini-web] identity state poll failed:", err);
          });
        }
      }

      // 消息增量刷新
      if (window.refreshChatViewport) {
        await window.refreshChatViewport({ incremental: true }).catch(err => {
          console.warn("[mini-web] chat viewport refresh failed:", err);
        });
      }

    } catch (err) {
      console.error("[mini-web] poll tick error:", err);
    }
  }

  /**
   * 启动轮询
   */
  function startPolling() {
    if (pollTimer) {
      console.warn("[mini-web] Polling already started");
      return;
    }

    console.log(`[mini-web] Starting polling (interval: ${POLL_INTERVAL_MS}ms)`);

    // 立即执行一次
    pollTick();

    // 启动定时器
    pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
  }

  /**
   * 停止轮询
   */
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      console.log("[mini-web] Polling stopped");
    }
  }

  /**
   * 重置轮询计时器
   */
  function resetPolling() {
    stopPolling();
    startPolling();
  }

  /**
   * 获取轮询状态
   */
  function getPollingStatus() {
    return {
      active: pollTimer !== null,
      interval: POLL_INTERVAL_MS,
      nextPolls: {
        accounts: nextAccountsPollAt,
        botDiscovery: nextBotDiscoveryPollAt,
        health: nextHealthPollAt,
        identityState: nextIdentityStatePollAt,
        worldSnapshot: nextWorldSnapshotPollAt,
        schedule: nextSchedulePollAt,
      }
    };
  }

  // 导出
  window.MiniwebPollingController = {
    startPolling,
    stopPolling,
    resetPolling,
    getPollingStatus,
    pollTick, // 暴露用于手动触发
  };

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('polling', window.MiniwebPollingController);
  }

  console.log('[mini-web] Polling controller loaded');
})();
