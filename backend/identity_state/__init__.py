"""玩法状态机框架。

Why
---
官方定时之类的功能要"知道每个身份的当前状态"才能动:
比如深度闭关到点没?抚摸 CD 还剩多久?温养器灵能不能再来一次?
我们不写自动化,但我们要把 *观察* 做对 — 状态机的输入永远是
listener 拉到的真实 game bot 回复,从不主动发指令。

约定
----
- 每个玩法是一个 **module**,实现 `GameModule` 协议(见下)。
- 每个 (send_as_id, module_key) 持有一份 **state**(dict)。
  只存当前快照;历史可以通过重跑 raw_messages 重建,不在这里留 trail。
- pipeline 在每条消息进来时调 `ModuleRegistry.observe_all(event, ctx, ...)`,
  module 自己决定要不要更新 state。返 None 表示不变,返 dict 表示新 state(全量替换)。
- 触发口径:**只看 game bot 的回复**(ctx.sender_kind == "bot"),
  我自己发的指令不当 trigger — 因为指令可能没生效,bot 没回复就当作没发生。

模块要回答三件事
----------------
1. observe(event, ctx, state)        — 看到这条消息后状态变成什么
2. compute_anchor(state, *, now)     — 下一次「可用」的绝对时间(epoch s),
                                       schedule.build_plan 用它当 auto_anchor
3. status_summary(state, *, now)     — 给 UI 用的一行人话(剩余 CD / 已就绪)

resolve_target 决定 state 写到哪个 send_as_id 上 — 一般是
ctx.parent.sender_id(bot 回复了我的某条指令,父消息是我发的),
没有 parent 或 parent 不是我的身份就跳过。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol, runtime_checkable

from backend.domain.models import RawMessageEvent


# ---------- 上下文 ----------

@dataclass(frozen=True)
class ObserveContext:
    """跑 observe 时塞给 module 的「场景包」,pipeline 一次构造,所有 module 共享。"""

    parent: RawMessageEvent | None
    """reply_to_msg_id 解出来的父条原始 event。可空。"""

    sender_kind: str
    """事件发送者的角色:self / bot / player / channel。"""

    my_identities: frozenset[int]
    """当前账号下所有 send_as_id(正负都包含)。"""

    game_bot_ids: frozenset[int]
    """settings.game_bot_ids 标定的真 bot/频道 sender_id。"""

    settings: dict
    """settings 只读快照,module 不要写。"""

    now: float
    """事件被 observe 时的绝对时间(epoch s)。模块用它算 CD,不要再 time.time()。"""

    def parent_sender(self) -> int | None:
        if self.parent is None:
            return None
        sid = self.parent.sender_id
        try:
            return int(sid) if sid is not None else None
        except (TypeError, ValueError):
            return None

    def parent_is_my_identity(self) -> bool:
        sid = self.parent_sender()
        return sid is not None and sid in self.my_identities


# ---------- Module 协议 ----------

@runtime_checkable
class GameModule(Protocol):
    """玩法模块的契约。新增模块只需要实现这几个方法。"""

    key: str            # 唯一 key,持久化到 identity_module_state.module_key
    label: str          # UI 显示名
    default_state: dict # 没记录时的初始 state

    def observe(
        self,
        event: RawMessageEvent,
        ctx: ObserveContext,
        state: dict,
    ) -> dict | None:
        """看到一条 event,决定是否更新 state。

        - 返 None  :state 不变,不写库。
        - 返 dict  :全量替换 state,框架负责落库。
        模块自己决定要不要看 ctx.sender_kind / ctx.parent 等。
        """

    def resolve_target(
        self,
        event: RawMessageEvent,
        ctx: ObserveContext,
    ) -> int | None:
        """这条 event 应当写到哪个 send_as_id 上?返 None = 跳过此 event。

        通常实现:看到 bot 回复,parent 是我的某身份,就把 state 写到那个身份。
        """

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        """state -> 下一次可用时间(epoch s)。

        - 返 None:无法推断(没观测过/state 缺关键字段),scheduler 用默认 now。
        - 返浮点:scheduler 把这个时间当作下一轮起点。
        """

    def status_summary(self, state: dict, *, now: float) -> dict:
        """给 UI 的小卡片。约定字段:

        - text   : 一行字,如 "剩 02:34" / "已就绪"
        - ready  : bool,True = CD 走完
        - next_at: float | None,下一次可用绝对时间,前端可单独排版
        """


# ---------- 工具函数 ----------

def fmt_remain(seconds: float) -> str:
    """0:30 / 1:23:45 风格的剩余时间。负数返 0:00。"""
    s = max(0, int(round(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{sec:02d}"
    return f"{m}:{sec:02d}"


def classify_sender(
    sender_id: int | None,
    *,
    my_identities: Iterable[int],
    game_bot_ids: Iterable[int],
) -> str:
    """sender_id -> "self" / "bot" / "channel" / "player"。"""
    if sender_id is None:
        return "player"
    sid = int(sender_id)
    if sid in {int(x) for x in my_identities}:
        return "self"
    if sid in {int(x) for x in game_bot_ids}:
        return "bot"
    if sid < 0:
        return "channel"
    return "player"


# ---------- Registry ----------

@dataclass
class ObserveResult:
    module_key: str
    send_as_id: int
    state: dict


class ModuleRegistry:
    """模块注册表。pipeline 持有它,observe_all 是主入口。"""

    def __init__(self) -> None:
        self._modules: dict[str, GameModule] = {}

    def register(self, module: GameModule) -> None:
        self._modules[module.key] = module

    def get(self, key: str) -> GameModule | None:
        return self._modules.get(key)

    def all(self) -> list[GameModule]:
        return list(self._modules.values())

    def observe_all(
        self,
        event: RawMessageEvent,
        ctx: ObserveContext,
        *,
        get_state: Callable[[int, str], dict | None],
        save_state: Callable[[int, str, dict, str], None],
    ) -> list[ObserveResult]:
        """对每个 module 跑 observe,有变化的写入。

        get_state(send_as_id, key) -> dict | None
        save_state(send_as_id, key, state, source_message_id)
        """
        out: list[ObserveResult] = []
        for module in self._modules.values():
            try:
                target = module.resolve_target(event, ctx)
            except Exception:
                continue
            if not target:
                continue
            current = get_state(int(target), module.key)
            if current is None:
                current = dict(module.default_state)
            try:
                new_state = module.observe(event, ctx, current)
            except Exception:
                continue
            if new_state is None:
                continue
            try:
                save_state(int(target), module.key, dict(new_state), str(event.id or ""))
            except Exception:
                continue
            out.append(
                ObserveResult(
                    module_key=module.key,
                    send_as_id=int(target),
                    state=dict(new_state),
                )
            )
        return out


def build_default_registry() -> ModuleRegistry:
    """默认状态模块。复杂玩法独立实现,普通 CD 由 cooldown specs 覆盖。"""
    from backend.identity_state.deep_retreat import DeepRetreatModule
    from backend.identity_state.cooldown import build_cooldown_modules
    from backend.identity_state.pet_touch import PetTouchModule
    from backend.identity_state.pet_warm import PetWarmModule
    from backend.identity_state.search_node import SearchNodeModule
    from backend.identity_state.small_world import SmallWorldModule
    from backend.identity_state.weakness import WeaknessModule
    from backend.identity_state.wendao import WendaoModule
    from backend.identity_state.yindao import YindaoModule
    from backend.identity_state.yuanying import YuanyingModule

    reg = ModuleRegistry()
    reg.register(DeepRetreatModule())
    reg.register(YuanyingModule())
    reg.register(PetTouchModule())
    reg.register(PetWarmModule())
    reg.register(WeaknessModule())
    reg.register(SmallWorldModule())
    reg.register(WendaoModule())
    reg.register(YindaoModule())
    reg.register(SearchNodeModule())
    for module in build_cooldown_modules():
        reg.register(module)
    return reg


__all__ = [
    "GameModule",
    "ModuleRegistry",
    "ObserveContext",
    "ObserveResult",
    "build_default_registry",
    "classify_sender",
    "fmt_remain",
]
