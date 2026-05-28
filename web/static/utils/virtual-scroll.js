// MINIWEB-UTIL: Virtual scrolling for large message lists
(function () {
  "use strict";

  /**
   * 虚拟滚动 - 只渲染可见区域的消息
   * @param {Array} items - 所有消息
   * @param {HTMLElement} container - 容器元素
   * @param {Function} renderItem - 渲染单个消息的函数
   * @param {number} itemHeight - 每个消息的高度(px)
   * @param {number} buffer - 缓冲区大小(额外渲染的消息数)
   */
  function createVirtualScroller(items, container, renderItem, itemHeight = 100, buffer = 5) {
    const viewport = container.parentElement;
    const totalHeight = items.length * itemHeight;

    // 创建占位容器
    container.style.height = `${totalHeight}px`;
    container.style.position = 'relative';

    function updateVisibleItems() {
      const scrollTop = viewport.scrollTop;
      const viewportHeight = viewport.clientHeight;

      // 计算可见范围
      const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
      const endIndex = Math.min(
        items.length,
        Math.ceil((scrollTop + viewportHeight) / itemHeight) + buffer
      );

      // 只渲染可见的消息
      const fragment = document.createDocumentFragment();
      for (let i = startIndex; i < endIndex; i++) {
        const item = items[i];
        const element = renderItem(item);
        element.style.position = 'absolute';
        element.style.top = `${i * itemHeight}px`;
        element.style.width = '100%';
        fragment.appendChild(element);
      }

      container.innerHTML = '';
      container.appendChild(fragment);
    }

    // 使用 RAF 节流的滚动监听
    let rafId = null;
    viewport.addEventListener('scroll', () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          updateVisibleItems();
          rafId = null;
        });
      }
    });

    // 初始渲染
    updateVisibleItems();

    return {
      update: updateVisibleItems,
      destroy: () => {
        if (rafId) cancelAnimationFrame(rafId);
      }
    };
  }

  window.MiniwebVirtualScroll = { createVirtualScroller };
})();
