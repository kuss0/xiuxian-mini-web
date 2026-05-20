from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable

from backend.domain.models import ParsedCard, RawMessageEvent

CURRENT_MESSAGE_FILTER_VERSION = 10


DEFAULT_FOCUS_KEYWORDS = (
    "猴子",
    "玄骨",
    "极阴",
    "风希",
    "洞府",
    "虚天殿",
    "黄龙山",
    "昆吾山",
    "坠魔谷",
    "血色试炼",
    "副本ID",
    "稳控全场",
    "天道审判",
    "挂机嫌疑",
    "自证",
    "举报",
    "封禁",
    "虚弱",
    "静思崖",
    "共历心劫",
    "心魔",
    "显灵",
)

DEFAULT_FOCUS_EXCLUDE_PATTERNS = (
    r"^\d{1,2}$",
    r"^[０-９]{1,2}$",
    r"^[!！?？。．.、,，;；:：~～…·`'\"“”‘’/\\|()[\]{}<>《》【】「」『』\-_=+*#@￥$%^&]{1,4}$",
    r"^(a+|o+|嗯+|哦+|噢+|喵+|哈+|哈哈+|哇+|呜+|额+|呃+|好+|好的|好的呢|好吧|行吧?|对|是|是的|收到|收到了|来了|来了来了|回来了|晚安|谢谢|谢谢老板|等下|稍等|明白|知道了|没问题|可以|冒泡|打卡|起来了|欸行|你好|早安|差不多|差不多了|得嘞|妥了|好嘞|在呢|在吗|嘿嘿|呵呵|了解|okk|619|555|拉屎好爽)$",
    r"^(查看闭关|宗门点卯|宗门悬赏|宗门战况|天机代卜|闯塔|我的侍妾|查看侍妾|我的货摊|我的宗门|宗门宝库|每日问安|万宝楼|洞府|战力|状态|观星台|观星|助阵|启阵|出关|归来|强行出关|深度闭关|闭关修炼|闭关结束|登天阶|元婴状态|元婴出窍|元婴归窍|冲击元婴|第二元神|安抚星辰|入梦寻图|黄粱一梦|共历心劫|野外历练|斩妖除魔|小药园|洞天绘卷|宗门传功|我的灵根|收集精华|解散副本)$",
    r"^(上架\s+.+\s+换\s+.+|炼制.+材料)$",
)

LEGACY_FOCUS_EXCLUDE_PATTERNS = (
    r"^(嗯+|哦+|噢+|好+|好的|行吧?|对|是|收到|收到了|来了|回来了|晚安|谢谢|谢谢老板)$",
    r"^(查看闭关|宗门点卯|宗门悬赏|天机代卜|闯塔|我的侍妾|查看侍妾|我的货摊|我的宗门|宗门宝库|每日问安|万宝楼|洞府|战力|状态|观星台|观星|助阵|启阵|出关|归来|强行出关|深度闭关|闭关修炼|登天阶|元婴状态|元婴出窍|安抚星辰|入梦寻图|黄粱一梦|共历心劫)$",
    r"^(a+|o+|嗯+|哦+|噢+|喵+|哈+|哈哈+|哇+|呜+|额+|呃+|好+|好的|好的呢|好吧|行吧?|对|是|是的|收到|收到了|来了|来了来了|回来了|晚安|谢谢|谢谢老板|等下|稍等|明白|知道了|没问题|可以|冒泡|打卡|起来了|欸行)$",
    r"^(查看闭关|宗门点卯|宗门悬赏|天机代卜|闯塔|我的侍妾|查看侍妾|我的货摊|我的宗门|宗门宝库|每日问安|万宝楼|洞府|战力|状态|观星台|观星|助阵|启阵|出关|归来|强行出关|深度闭关|闭关修炼|闭关结束|登天阶|元婴状态|元婴出窍|第二元神|安抚星辰|入梦寻图|黄粱一梦|共历心劫|野外历练|洞天绘卷|宗门传功|我的灵根|收集精华)$",
    r"^(查看闭关|宗门点卯|宗门悬赏|宗门战况|天机代卜|闯塔|我的侍妾|查看侍妾|我的货摊|我的宗门|宗门宝库|每日问安|万宝楼|洞府|战力|状态|观星台|观星|助阵|启阵|出关|归来|强行出关|深度闭关|闭关修炼|闭关结束|登天阶|元婴状态|元婴出窍|第二元神|安抚星辰|入梦寻图|黄粱一梦|共历心劫|野外历练|洞天绘卷|宗门传功|我的灵根|收集精华|解散副本)$",
    r"^[\W_]{1,4}$",
)

BOT_FORMAT_MARKERS = (
    "【",
    "】",
    "────",
    "━━━━",
    "当前",
    "进度",
    "奖励",
    "获得",
    "消耗",
    "灵石",
    "贡献",
    "冷却",
    "倒计时",
    "请在",
    "无法",
    "不足",
    "尚未",
    "并未",
    "成功",
    "失败",
    "已进入",
    "已加入",
    "已完成",
    "正在",
    "下一次发言",
    "自动结算",
    "将在外",
    "队伍",
    "房间",
    "副本ID",
    "使用.",
    "使用 .",
    "命令:",
    "命令：",
    "相关指令",
    "卦象验阵",
    "卦门灵机",
    "心劫锚点",
    "天机剧变",
    "重宝降世",
    "情缘未至",
    "方可代卜天机",
    "天道综合指数",
    "走势图",
)
_UNSET_REPLY = object()


@dataclass(frozen=True)
class FilterResult:
    channels: tuple[str, ...]
    tags: tuple[str, ...]
    reasons: tuple[str, ...] = ()


def enrich_filter_channels(
    card: ParsedCard,
    event: RawMessageEvent,
    settings: dict,
    *,
    is_game_bot_sender: Callable[[int | None], bool],
    parent_event: RawMessageEvent | None = None,
    clean_reply_to_msg_id: int | None | object = _UNSET_REPLY,
    my_identity_ids: Iterable[int] = (),
) -> FilterResult:
    """Add product-level message filtering channels.

    This layer is deliberately presentation-oriented: it does not infer game
    state or trigger sends. It only decides whether a card belongs in the
    realtime focus stream, leader stream, or archive.
    """
    channels = list(card.channels or ())
    tags = list(card.tags or ())
    reasons: list[str] = []
    text = event.text or card.raw or ""
    sender_id = event.sender_id
    bot_like = bool(event.sender_is_bot) or bool(is_game_bot_sender(sender_id))
    dot_command = is_dot_command(text)
    my_ids = _int_set(my_identity_ids)
    clean_reply_id = (
        _safe_int(event.reply_to_msg_id)
        if clean_reply_to_msg_id is _UNSET_REPLY
        else _safe_int(clean_reply_to_msg_id)
    )
    has_real_reply = bool(parent_event is not None or clean_reply_id)
    mine = bool(_safe_int(sender_id) and _safe_int(sender_id) in my_ids)
    parent_sender = _safe_int(parent_event.sender_id if parent_event else None)
    bot_reply_to_mine = bool(bot_like and parent_sender and parent_sender in my_ids)
    bot_reply_to_other = bool(bot_like and parent_sender and my_ids and parent_sender not in my_ids)

    own_mention = has_own_mention(
        text,
        mentions=event.mentions,
        aliases=_list_setting(settings, "own_aliases"),
    )
    bot_mentions_other = bool(
        bot_like and has_any_mention(text, mentions=event.mentions) and not own_mention
    )
    configured_leader_sender = is_leader_message(
        event,
        leader_sender_ids=_int_list_setting(settings, "leader_sender_ids"),
        leader_source_names=_list_setting(settings, "leader_source_names"),
    )
    configured_leader = configured_leader_sender and is_plain_leader_message(
        text,
        has_real_reply=has_real_reply,
    )
    tianzun_plain_leader = is_plain_tianzun_leader_message(
        event,
        text,
        is_confirmed_tianzun_sender=bool(sender_id and is_game_bot_sender(sender_id)),
        has_real_reply=has_real_reply,
    )
    leader = configured_leader or tianzun_plain_leader
    keyword_hits = focus_keyword_hits(
        text,
        _list_setting(settings, "focus_keywords") or list(DEFAULT_FOCUS_KEYWORDS),
    )

    card_important = (
        card.severity == "risk"
        or "risk" in channels
        or bool(card.actions)
        or "dungeon" in channels
        or own_mention
        or leader
        or bool(keyword_hits)
        or bot_reply_to_mine
        or mine
    )
    exclude_patterns = _list_setting(settings, "focus_exclude_patterns")
    if "focus_exclude_patterns" not in settings:
        exclude_patterns = list(DEFAULT_FOCUS_EXCLUDE_PATTERNS)
    exclude_hits = focus_exclude_hits(text, exclude_patterns)
    protected_important = (
        mine
        or bot_reply_to_mine
        or own_mention
        or leader
        or card.severity == "risk"
        or "risk" in channels
        or bool(card.actions)
    )
    focus_muted = is_focus_muted_sender(
        event,
        muted_sender_ids=_int_list_setting(settings, "focus_muted_sender_ids"),
        muted_source_names=_list_setting(settings, "focus_muted_source_names"),
    )
    # 自定义归档规则应当能压过关键词关注,例如:
    # focus_keywords=["坠魔谷"], focus_exclude_patterns=["坠魔谷护持"]
    # 时,“坠魔谷护持”进 archive,其它“坠魔谷”仍进 focus。
    # 只保护真正需要人工处理的消息:我发的、bot 回复我、@我、会长、风险和动作卡。
    excluded_focus = bool((exclude_hits or focus_muted) and not protected_important)
    plain_player = (
        bool(settings.get("focus_include_player_plain", True))
        and not bot_like
        and not dot_command
        and not excluded_focus
    )

    if leader:
        _append_unique(channels, "leader")
        _append_unique(tags, "会长")
        _append_unique(reasons, "会长/情报源普通发言")
    if tianzun_plain_leader:
        _append_unique(tags, "会长上号")
    if mine:
        _append_unique(tags, "我发出")
        _append_unique(reasons, "我的发送")
    if own_mention:
        _append_unique(tags, "被@")
        _append_unique(reasons, "提到我")
    if bot_reply_to_mine:
        _append_unique(tags, "回复我")
        _append_unique(reasons, "天尊回复我")
    if bot_reply_to_other:
        _append_unique(tags, "回复别人")
        _append_unique(reasons, "天尊回复别人")
    if bot_mentions_other:
        _append_unique(tags, "提到别人")
        _append_unique(reasons, "天尊提到别人")
    for hit in keyword_hits[:3]:
        _append_unique(tags, f"关键词:{hit}")
        _append_unique(reasons, f"关键词:{hit}")
    for hit in exclude_hits[:1]:
        if excluded_focus:
            _append_unique(tags, f"重点排除:{hit}")
            _append_unique(reasons, f"重点排除:{hit}")
    if focus_muted and excluded_focus:
        _append_unique(tags, f"重点静音:{event.source or event.sender_id or 'unknown'}")
        _append_unique(reasons, f"重点静音:{event.source or event.sender_id or 'unknown'}")

    archive_dot = bool(settings.get("archive_dot_commands", True))
    archive_bot = bool(settings.get("archive_bot_replies", True))

    suppress_focus = (
        bot_reply_to_other
        or (bot_mentions_other and not bot_reply_to_mine)
        or (archive_dot and dot_command and not mine)
        or excluded_focus
    )
    if not suppress_focus and (card_important or plain_player):
        _append_unique(channels, "focus")
        if plain_player and not card_important:
            _append_unique(reasons, "普通玩家消息策略")
    if suppress_focus and "focus" in channels:
        channels = [channel for channel in channels if channel != "focus"]

    archive_due_other = bot_like and not bot_reply_to_mine and (bot_reply_to_other or bot_mentions_other)
    archive_due_bot = archive_bot and bot_like and not card_important
    if (archive_dot and dot_command) or archive_due_other or archive_due_bot or excluded_focus:
        _append_unique(channels, "archive")
        _append_unique(tags, "归档")
        if archive_dot and dot_command:
            _append_unique(reasons, "点命令归档")
        if archive_due_other:
            _append_unique(reasons, "回复/提到别人归档")
        if archive_due_bot:
            _append_unique(reasons, "普通天尊回复归档")
        if excluded_focus:
            _append_unique(reasons, "命中排除规则归档")

    if card.severity == "risk" or "risk" in channels:
        _append_unique(reasons, "风险消息")
    if card.actions:
        _append_unique(reasons, "有可操作按钮")
    if "dungeon" in channels:
        _append_unique(reasons, "副本消息")
    if "resource" in channels:
        _append_unique(reasons, "资源/背包消息")
    if "training" in channels:
        _append_unique(reasons, "修炼状态消息")
    if "home" in channels:
        _append_unique(reasons, "洞府/家园消息")

    if not channels:
        channels.append("world")
    if "focus" not in channels and not reasons:
        _append_unique(reasons, "未命中重点规则")
    return FilterResult(channels=tuple(channels), tags=tuple(tags), reasons=tuple(reasons))


def is_dot_command(text: str) -> bool:
    stripped = str(text or "").lstrip()
    return stripped.startswith(".") or stripped.startswith("。")


def has_own_mention(text: str, *, mentions: tuple[str, ...], aliases: list[str]) -> bool:
    raw_text = str(text or "")
    normalized_aliases = [_normalize_alias(alias) for alias in aliases if _normalize_alias(alias)]
    normalized_mentions = {_normalize_alias(item) for item in (mentions or ()) if _normalize_alias(item)}
    if normalized_aliases:
        if normalized_mentions.intersection(normalized_aliases):
            return True
        lowered = raw_text.lower()
        return any(f"@{alias.lower()}" in lowered for alias in normalized_aliases)
    return False


def has_any_mention(text: str, *, mentions: tuple[str, ...]) -> bool:
    if any(_normalize_alias(item) for item in (mentions or ())):
        return True
    return bool(re.search(r"@[A-Za-z0-9_]{3,32}\b", str(text or "")))


def is_leader_message(
    event: RawMessageEvent,
    *,
    leader_sender_ids: list[int],
    leader_source_names: list[str],
) -> bool:
    sender_id = int(event.sender_id or 0)
    # 会长频道的身份判定只认 sender_id，避免普通玩家把 source/昵称伪装成
    # 会长或情报源后被抬进重点流。leader_source_names 仅作为旧设置保留。
    _ = leader_source_names
    return bool(sender_id and sender_id in set(leader_sender_ids))


def is_plain_leader_message(text: str, *, has_real_reply: bool = False) -> bool:
    raw = str(text or "").strip()
    return bool(raw and not is_dot_command(raw) and not has_real_reply)


def is_focus_muted_sender(
    event: RawMessageEvent,
    *,
    muted_sender_ids: list[int],
    muted_source_names: list[str],
) -> bool:
    sender_id = _safe_int(event.sender_id)
    if sender_id and sender_id in set(muted_sender_ids):
        return True
    source = str(event.source or "").strip().lower()
    if not source:
        return False
    return any(name.lower() in source for name in muted_source_names if name)


def is_plain_tianzun_leader_message(
    event: RawMessageEvent,
    text: str,
    *,
    is_confirmed_tianzun_sender: bool,
    has_real_reply: bool = False,
) -> bool:
    """确认过的天尊 ID 的普通发言按会长频道处理。

    游戏 bot 的大多数回复都有稳定结构:面板括号、数值、CD、资源、命令提示、
    或者是对某条玩家命令的 reply。会长借天尊身份说话通常更像普通聊天文本。
    这里按结构保守识别,避免把大量重复游戏回复塞进会长频道。
    """
    if not is_confirmed_tianzun_sender:
        return False
    raw = str(text or "").strip()
    if not raw or is_dot_command(raw):
        return False
    if has_real_reply:
        return False
    if has_any_mention(raw, mentions=event.mentions):
        return False
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(lines) > 8:
        return False
    if raw.startswith("*") and raw.endswith("*"):
        return False
    compact = raw.replace(" ", "")
    if any(marker in compact for marker in BOT_FORMAT_MARKERS):
        return False
    if re.search(r"(^|\n)\s*[-•]\s+", raw):
        return False
    if re.search(r"(^|[\s(（:：])[+＋-]\s*\d+", raw):
        return False
    return True


def focus_keyword_hits(text: str, keywords: list[str]) -> list[str]:
    raw = str(text or "")
    hits = []
    for keyword in keywords:
        key = str(keyword or "").strip()
        if key and key in raw and key not in hits:
            hits.append(key)
    return hits


def focus_exclude_hits(text: str, patterns: list[str]) -> list[str]:
    raw = str(text or "").strip()
    if not raw:
        return []
    hits = []
    for pattern in patterns:
        item = str(pattern or "").strip()
        if not item:
            continue
        matched = False
        try:
            matched = bool(re.search(item, raw))
        except re.error:
            matched = item == raw
        if matched and item not in hits:
            hits.append(item)
    return hits


def _append_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


def _normalize_alias(value: str) -> str:
    return str(value or "").strip().lstrip("@")


def _list_setting(settings: dict, key: str) -> list[str]:
    raw = settings.get(key) or []
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    return [str(item).strip() for item in raw if str(item or "").strip()]


def _int_list_setting(settings: dict, key: str) -> list[int]:
    out = []
    for item in _list_setting(settings, key):
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            continue
    return out


def _int_set(values: Iterable[int]) -> set[int]:
    out = set()
    for value in values or ():
        parsed = _safe_int(value)
        if parsed:
            out.add(parsed)
    return out


def _safe_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0
