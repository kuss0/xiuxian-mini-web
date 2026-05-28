// MINIWEB-MODULE: Error handler
// 统一错误处理机制
(function() {
  "use strict";

  const logger = window.MiniwebLogger || console;

  /**
   * 错误类型
   */
  const ErrorTypes = {
    NETWORK: 'NETWORK',
    API: 'API',
    VALIDATION: 'VALIDATION',
    UNKNOWN: 'UNKNOWN',
  };

  /**
   * 错误处理器
   */
  const errorHandler = {
    /**
     * 处理错误
     * @param {Error} error - 错误对象
     * @param {Object} options - 选项
     * @param {string} options.type - 错误类型
     * @param {string} options.context - 错误上下文
     * @param {boolean} options.showToast - 是否显示 Toast
     * @param {string} options.userMessage - 用户友好的错误消息
     */
    handle(error, options = {}) {
      const {
        type = ErrorTypes.UNKNOWN,
        context = '',
        showToast = true,
        userMessage = null,
      } = options;

      // 记录错误日志
      logger.error(`[${type}] ${context}:`, error);

      // 确定用户消息
      let message = userMessage || this.getUserMessage(error, type);

      // 显示 Toast
      if (showToast && window.MiniwebToast) {
        window.MiniwebToast.error(message);
      }

      // 返回错误信息
      return {
        type,
        context,
        message,
        originalError: error,
      };
    },

    /**
     * 获取用户友好的错误消息
     */
    getUserMessage(error, type) {
      // 网络错误
      if (type === ErrorTypes.NETWORK || error.message?.includes('fetch')) {
        return '网络连接失败，请检查网络后重试';
      }

      // API 错误
      if (type === ErrorTypes.API) {
        if (error.status === 429) {
          return '请求过于频繁，请稍后再试';
        }
        if (error.status === 401 || error.status === 403) {
          return '权限不足，请重新登录';
        }
        if (error.status >= 500) {
          return '服务器错误，请稍后再试';
        }
        return '操作失败，请重试';
      }

      // 验证错误
      if (type === ErrorTypes.VALIDATION) {
        return error.message || '输入数据有误，请检查后重试';
      }

      // 未知错误
      return '操作失败，请重试';
    },

    /**
     * 安全执行异步函数
     * @param {Function} fn - 异步函数
     * @param {*} fallback - 失败时的返回值
     * @param {Object} options - 错误处理选项
     */
    async safeAsync(fn, fallback = null, options = {}) {
      try {
        return await fn();
      } catch (error) {
        this.handle(error, options);
        return fallback;
      }
    },

    /**
     * 安全执行同步函数
     * @param {Function} fn - 同步函数
     * @param {*} fallback - 失败时的返回值
     * @param {Object} options - 错误处理选项
     */
    safeSync(fn, fallback = null, options = {}) {
      try {
        return fn();
      } catch (error) {
        this.handle(error, options);
        return fallback;
      }
    },

    /**
     * 包装 API 调用
     * @param {Function} apiCall - API 调用函数
     * @param {Object} options - 选项
     */
    async wrapApiCall(apiCall, options = {}) {
      const {
        context = 'API call',
        fallback = null,
        showToast = true,
      } = options;

      try {
        return await apiCall();
      } catch (error) {
        this.handle(error, {
          type: ErrorTypes.API,
          context,
          showToast,
        });
        return fallback;
      }
    },
  };

  // 全局错误处理
  window.addEventListener('error', (event) => {
    logger.error('Uncaught error:', event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    logger.error('Unhandled promise rejection:', event.reason);
  });

  // 导出到全局
  window.MiniwebErrorHandler = errorHandler;
  window.MiniwebErrorTypes = ErrorTypes;

  // 注册到模块系统
  if (window.MiniwebModules) {
    window.MiniwebModules.register('errorHandler', errorHandler);
  }

  logger.info('Error handler initialized');
})();
