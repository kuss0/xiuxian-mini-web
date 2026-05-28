// MINIWEB-PATCH: Performance optimizations for app.js
// 这个补丁文件应该在 app.js 之后加载

(function () {
  "use strict";

  const { debounce, throttle, rafThrottle } = window.MiniwebPerformance || {};

  if (!debounce || !throttle) {
    console.warn('[mini-web] Performance utils not loaded, skipping optimizations');
    return;
  }

  // 1. 优化消息搜索 - 使用防抖
  const originalMessageSearchInput = document.querySelector("#messageSearchInput");
  if (originalMessageSearchInput) {
    const debouncedSearch = debounce((event) => {
      if (window.state) {
        window.state.messageSearch = event.target.value;
        if (window.renderMessageList) {
          window.renderMessageList();
        }
      }
    }, 300);

    originalMessageSearchInput.removeEventListener('input', originalMessageSearchInput._originalHandler);
    originalMessageSearchInput.addEventListener('input', debouncedSearch);
  }

  // 2. 优化滚动事件 - 使用 RAF 节流
  const messageList = document.querySelector("#messageList");
  if (messageList && messageList.parentElement) {
    const viewport = messageList.parentElement;
    const originalScrollHandler = viewport._scrollHandler;

    if (originalScrollHandler) {
      viewport.removeEventListener('scroll', originalScrollHandler);
      viewport.addEventListener('scroll', rafThrottle(originalScrollHandler));
    }
  }

  // 3. 优化轮询 - 只在页面可见时轮询
  let isPageVisible = !document.hidden;

  document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;

    if (isPageVisible && window.loadMessages) {
      // 页面重新可见时立即刷新一次
      console.log('[mini-web] Page visible, refreshing messages');
      window.loadMessages({ silent: true });
    }
  });

  // 4. 拦截原始轮询，只在页面可见时执行
  if (window.pollTick) {
    const originalPollTick = window.pollTick;
    window.pollTick = function() {
      if (isPageVisible) {
        originalPollTick();
      }
    };
  }

  // 5. 优化 DOM 更新 - 批量更新
  if (window.renderMessageList) {
    const originalRenderMessageList = window.renderMessageList;
    window.renderMessageList = rafThrottle(originalRenderMessageList);
  }

  console.log('[mini-web] Performance optimizations applied');
})();
