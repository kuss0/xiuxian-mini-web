// MINIWEB-MODULE: Message utilities
// 消息排序、合并等工具函数
(function() {
  "use strict";

  /**
   * 获取消息的时间戳值
   * @param {Object} message - 消息对象
   * @returns {number} 时间戳（毫秒）
   */
  function messageTimeValue(message) {
    const parsed = Date.parse(String(message?.time || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * 获取消息的数字字段值
   * @param {Object} message - 消息对象
   * @param {string} key - 字段名
   * @returns {number} 数字值
   */
  function numericMessageField(message, key) {
    const value = Number(message?.[key] || 0);
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * 按时间倒序比较消息（最新的在前）
   * @param {Object} a - 消息 A
   * @param {Object} b - 消息 B
   * @returns {number} 比较结果
   */
  function compareMessagesByRecency(a, b) {
    const timeDiff = messageTimeValue(b) - messageTimeValue(a);
    if (timeDiff) return timeDiff;
    const msgDiff = numericMessageField(b, "msg_id") - numericMessageField(a, "msg_id");
    if (msgDiff) return msgDiff;
    return numericMessageField(b, "seq") - numericMessageField(a, "seq");
  }

  /**
   * 创建先按排名后按时间的比较函数
   * @param {Function} rankFn - 排名函数
   * @returns {Function} 比较函数
   */
  function compareRankThenRecency(rankFn) {
    return (a, b) => rankFn(a) - rankFn(b) || compareMessagesByRecency(a, b);
  }

  /**
   * 按时间倒序排序消息
   * @param {Array} messages - 消息数组
   * @returns {Array} 排序后的消息数组
   */
  function sortMessagesByRecency(messages) {
    return [...(messages || [])].sort(compareMessagesByRecency);
  }

  /**
   * 按 ID 合并消息（去重并排序）
   * @param {Array} existing - 现有消息
   * @param {Array} incoming - 新消息
   * @returns {Array} 合并后的消息数组
   */
  function mergeMessagesById(existing, incoming) {
    const byId = new Map((existing || []).map((message) => [message.id, message]));
    for (const message of incoming || []) {
      if (message?.id) byId.set(message.id, message);
    }
    return sortMessagesByRecency(Array.from(byId.values()));
  }

  /**
   * 按最新消息时间比较副本摘要
   * @param {Object} a - 副本摘要 A
   * @param {Object} b - 副本摘要 B
   * @returns {number} 比较结果
   */
  function compareDungeonSummariesByRecency(a, b) {
    const aLatest = a?.latestMessage || {};
    const bLatest = b?.latestMessage || {};
    const timeDiff = messageTimeValue(bLatest) - messageTimeValue(aLatest);
    if (timeDiff) return timeDiff;
    const msgDiff = numericMessageField(bLatest, "msg_id") - numericMessageField(aLatest, "msg_id");
    if (msgDiff) return msgDiff;
    return Number(b?.latestSeq || bLatest.seq || 0) - Number(a?.latestSeq || aLatest.seq || 0);
  }

  window.MiniwebMessageUtils = {
    messageTimeValue,
    numericMessageField,
    compareMessagesByRecency,
    compareRankThenRecency,
    sortMessagesByRecency,
    mergeMessagesById,
    compareDungeonSummariesByRecency,
  };

  console.log('[mini-web] Message utilities loaded');
})();
