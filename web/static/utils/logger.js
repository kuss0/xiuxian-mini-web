// MINIWEB-MODULE: Logger
// 统一日志系统，支持日志级别控制
(function() {
  "use strict";

  // 日志级别
  const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4,
  };

  // 从环境变量或 localStorage 读取日志级别
  function getLogLevel() {
    const stored = localStorage.getItem('miniweb_log_level');
    if (stored && LOG_LEVELS[stored] !== undefined) {
      return LOG_LEVELS[stored];
    }
    // 生产环境默认只显示 WARN 和 ERROR
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? LOG_LEVELS.DEBUG
      : LOG_LEVELS.WARN;
  }

  let currentLogLevel = getLogLevel();

  /**
   * 格式化日志消息
   */
  function formatMessage(level, args) {
    const timestamp = window.MiniwebFormat?.formatDisplayClockTime?.(new Date()) || new Date().toISOString().slice(11, 16);
    const prefix = `[${timestamp}] [${level}]`;
    return [prefix, ...args];
  }

  /**
   * 日志工具
   */
  const logger = {
    /**
     * 调试日志（仅开发环境）
     */
    debug(...args) {
      if (currentLogLevel <= LOG_LEVELS.DEBUG) {
        console.log(...formatMessage('DEBUG', args));
      }
    },

    /**
     * 信息日志
     */
    info(...args) {
      if (currentLogLevel <= LOG_LEVELS.INFO) {
        console.log(...formatMessage('INFO', args));
      }
    },

    /**
     * 警告日志
     */
    warn(...args) {
      if (currentLogLevel <= LOG_LEVELS.WARN) {
        console.warn(...formatMessage('WARN', args));
      }
    },

    /**
     * 错误日志
     */
    error(...args) {
      if (currentLogLevel <= LOG_LEVELS.ERROR) {
        console.error(...formatMessage('ERROR', args));
      }
    },

    /**
     * 设置日志级别
     * @param {string} level - DEBUG, INFO, WARN, ERROR, NONE
     */
    setLevel(level) {
      const upperLevel = String(level).toUpperCase();
      if (LOG_LEVELS[upperLevel] !== undefined) {
        currentLogLevel = LOG_LEVELS[upperLevel];
        localStorage.setItem('miniweb_log_level', upperLevel);
        console.log(`[mini-web] Log level set to ${upperLevel}`);
      } else {
        console.error(`[mini-web] Invalid log level: ${level}`);
      }
    },

    /**
     * 获取当前日志级别
     */
    getLevel() {
      return Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLogLevel);
    },

    /**
     * 性能计时开始
     */
    time(label) {
      if (currentLogLevel <= LOG_LEVELS.DEBUG) {
        console.time(`[mini-web] ${label}`);
      }
    },

    /**
     * 性能计时结束
     */
    timeEnd(label) {
      if (currentLogLevel <= LOG_LEVELS.DEBUG) {
        console.timeEnd(`[mini-web] ${label}`);
      }
    },

    /**
     * 分组开始
     */
    group(label) {
      if (currentLogLevel <= LOG_LEVELS.DEBUG) {
        console.group(`[mini-web] ${label}`);
      }
    },

    /**
     * 分组结束
     */
    groupEnd() {
      if (currentLogLevel <= LOG_LEVELS.DEBUG) {
        console.groupEnd();
      }
    },
  };

  // 导出到全局
  window.MiniwebLogger = logger;

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('logger', logger);
  }

  // 初始化日志
  logger.info('Logger initialized, level:', logger.getLevel());
})();
