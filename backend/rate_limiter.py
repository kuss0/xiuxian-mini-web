"""Rate limiter for HTTP API endpoints.

Simple sliding window rate limiter to prevent API abuse.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from time import time
from typing import Dict, List


class RateLimiter:
    """滑动窗口速率限制器

    使用滑动窗口算法限制请求频率，防止 API 滥用。

    Example:
        limiter = RateLimiter(max_requests=60, window_seconds=60)

        if limiter.is_allowed(client_ip):
            # 处理请求
            pass
        else:
            # 返回 429 Too Many Requests
            pass
    """

    def __init__(self, max_requests: int = 60, window_seconds: int = 60):
        """初始化速率限制器

        Args:
            max_requests: 时间窗口内允许的最大请求数
            window_seconds: 时间窗口大小（秒）
        """
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: Dict[str, List[float]] = defaultdict(list)
        self._lock = threading.Lock()

    def is_allowed(self, client_id: str) -> bool:
        """检查是否允许请求

        Args:
            client_id: 客户端标识（通常是 IP 地址）

        Returns:
            True 如果允许请求，False 如果超过限制
        """
        now = time()

        with self._lock:
            # 清理过期请求
            recent = [
                timestamp for timestamp in self.requests[client_id]
                if now - timestamp < self.window_seconds
            ]

            # 检查是否超过限制
            if len(recent) >= self.max_requests:
                self.requests[client_id] = recent
                return False

            # 记录新请求
            recent.append(now)
            self.requests[client_id] = recent
            return True

    def get_remaining(self, client_id: str) -> int:
        """获取剩余请求数

        Args:
            client_id: 客户端标识

        Returns:
            剩余可用请求数
        """
        now = time()
        with self._lock:
            recent = [
                t for t in self.requests.get(client_id, [])
                if now - t < self.window_seconds
            ]
        return max(0, self.max_requests - len(recent))

    def get_reset_time(self, client_id: str) -> float:
        """获取速率限制重置时间

        Args:
            client_id: 客户端标识

        Returns:
            距离重置的秒数
        """
        with self._lock:
            timestamps = list(self.requests.get(client_id, []))
        if not timestamps:
            return 0.0

        now = time()
        oldest = min(timestamps)
        reset_at = oldest + self.window_seconds
        return max(0.0, reset_at - now)
