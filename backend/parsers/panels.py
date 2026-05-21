"""Panel parsers — bot 对查询命令返回的「状态/面板」回复。

跟 prompts 不同,这些消息不要求 user 回复,只是展示当前状态;parser 抽出
关键字段,卡片高亮显示。覆盖老脚本里 8 类常见 panel:

- 登天阶 / 凌霄云阶  → tianti.py
- 观星台 / 星宫       → stargazer.py
- 观星结果 / 星盘显化 → guanxing.py
- 小世界              → small_world.py
- 我的侍妾 panel      → concubine.py
- 灵树状态            → tree.py
- 法宝抚摸/温养/试炼  → pet.py
- 太一引动 / 节点      → taiyi.py
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput


# ============ 登天阶 ============
TIANTI_PANEL_KW = "【凌霄云阶】"
TIANTI_PROGRESS_RE = re.compile(r"当前(?:云阶)?进度[:：]\s*(\d+)\s*/\s*(\d+)(?:\s*阶)?")
TIANTI_CYCLE_RE = re.compile(r"已完成周天[:：]\s*(\d+)\s*轮")
TIANTI_GANGFENG_RE = re.compile(r"罡风淬体[:：]\s*(\d+)\s*/\s*(\d+)(?:\s*层)?")
TIANTI_CD_RE = re.compile(r"登阶冷却[:：]\s*([^\n]+)")
TIANTI_WENXIN_RE = re.compile(r"问心状态[:：]\s*([^\n]+)")


class TiantiPanelParser:
    name = "tianti_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if TIANTI_PANEL_KW not in text:
            return None
        fields: dict[str, object] = {}
        if m := TIANTI_PROGRESS_RE.search(text):
            fields["阶进度"] = f"{m.group(1)} / {m.group(2)}"
            fields["阶进度数值"] = {"current": int(m.group(1)), "max": int(m.group(2))}
        if m := TIANTI_CYCLE_RE.search(text):
            fields["周天"] = f"{m.group(1)} 轮"
        if m := TIANTI_GANGFENG_RE.search(text):
            fields["罡风淬体"] = f"{m.group(1)} / {m.group(2)} 层"
        if m := TIANTI_CD_RE.search(text):
            fields["登阶冷却"] = m.group(1).strip()
        if m := TIANTI_WENXIN_RE.search(text):
            fields["问心"] = m.group(1).strip()
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine", "training"),
                    title="登天阶面板",
                    summary="凌霄云阶状态",
                    source=event.source,
                    time=event.date,
                    tags=("修炼", "登天阶"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
        )


# ============ 观星台 panel ============
STARGAZER_TOTAL_RE = re.compile(r"引星盘总数[:：]\s*(\d+)\s*座")
STARGAZER_SLOT_RE = re.compile(r"^\s*(\d+)\s*号引星盘[:：]\s*(.+?)\s*$", re.MULTILINE)


class StargazerPanelParser:
    name = "stargazer_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if "观星台" not in text or "引星盘" not in text:
            return None
        fields: dict[str, object] = {}
        if m := STARGAZER_TOTAL_RE.search(text):
            fields["引星盘总数"] = int(m.group(1))
        slots = [
            {"idx": int(idx), "status": status.strip()}
            for idx, status in STARGAZER_SLOT_RE.findall(text)
        ]
        if not slots and "引星盘总数" not in fields:
            return None
        if slots:
            fields["引星盘"] = slots
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine", "training"),
                    title="观星台面板",
                    summary=f"{len(slots)} 座引星盘状态" if slots else "观星台状态",
                    source=event.source,
                    time=event.date,
                    tags=("星宫", "观星台"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
        )


# ============ 观星结果 ============
GUANXING_PANEL_KW = "【星盘显化】"
GUANXING_RESULT_KW = "天机演化结果"
GUANXING_NEXT_EVENT_RE = re.compile(r"下一次天道演化将是[:：]\s*【([^】]+)】")
GUANXING_FATED_RE = re.compile(r"当前天命所归[:：]\s*(@\S+)")
GUANXING_RESULT_RE = re.compile(r"天机演化结果[:：]\s*([^！!\n]+)[！!]?")


class GuanxingParser:
    name = "guanxing"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if GUANXING_PANEL_KW in text:
            fields: dict[str, object] = {}
            if m := GUANXING_NEXT_EVENT_RE.search(text):
                fields["下次事件"] = m.group(1).strip()
            if m := GUANXING_FATED_RE.search(text):
                fields["天命所归"] = m.group(1).strip()
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "prompt"),
                        title="星盘显化",
                        summary="可用 .改换星移 @新目标 改命",
                        source=event.source,
                        time=event.date,
                        tags=("天机", "观星"),
                        raw=event.text,
                        fields=fields,
                    ),
                ),
            )
        if GUANXING_RESULT_KW in text:
            fields = {}
            if m := GUANXING_RESULT_RE.search(text):
                fields["演化结果"] = m.group(1).strip()
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "world"),
                        title="天机阁快报",
                        summary=fields.get("演化结果", "天机演化"),
                        source=event.source,
                        time=event.date,
                        tags=("天机", "结算"),
                        raw=event.text,
                        fields=fields,
                    ),
                ),
            )
        return None


# ============ 小世界 panel ============
SMALL_WORLD_PANEL_RE = re.compile(r"【(?P<owner>[^】]+)的小世界】")
SW_FAITH_RE = re.compile(r"信仰\s*[:：]\s*(\d+)\s*/\s*(\d+)")
SW_PENDING_RE = re.compile(r"待收香火\s*[:：]\s*([\d.]+)")
SW_STOCK_RE = re.compile(r"香火库存\s*[:：]\s*(\d+)")
SW_PRAYER_RE = re.compile(r"凡人祈愿\s*[:：]\s*([^\n]+)")
SW_WAIT_RE = re.compile(r"下一次祈愿感应需等待\s*[:：]\s*([^\n)）]+)")


class SmallWorldPanelParser:
    name = "small_world_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        owner_m = SMALL_WORLD_PANEL_RE.search(text)
        if not owner_m:
            return None
        fields: dict[str, object] = {"主人": owner_m.group("owner").strip()}
        if m := SW_FAITH_RE.search(text):
            fields["信仰"] = f"{m.group(1)} / {m.group(2)}"
        if m := SW_PENDING_RE.search(text):
            fields["待收香火"] = m.group(1)
        if m := SW_STOCK_RE.search(text):
            fields["香火库存"] = int(m.group(1))
        if m := SW_PRAYER_RE.search(text):
            fields["凡人祈愿"] = m.group(1).strip()
        if m := SW_WAIT_RE.search(text):
            fields["下次祈愿"] = m.group(1).strip()
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine", "home"),
                    title="小世界面板",
                    summary=f"{fields['主人']} 的小世界",
                    source=event.source,
                    time=event.date,
                    tags=("小世界", "面板"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
        )


# ============ 我的侍妾 panel ============
CONCUBINE_HEAD_RE = re.compile(
    r"你的(?P<kind>道心侍妾|红尘道侣)[:：]\s*【(?P<name>[^】]+)】\s*[(（]状态[:：]\s*(?P<loc>[^)）\n]+)[)）]"
)
CONCUBINE_AFFINITY_RE = re.compile(r"情缘值[:：]\s*(\d+)")
CONCUBINE_OATH_RE = re.compile(r"当前誓约[:：]\s*([^\s(（\n]+)")
DREAM_CD_RE = re.compile(r"入梦寻图冷却[:：]\s*([^\n]+)")
TIANJI_CD_RE = re.compile(r"天机代卜冷却[:：]\s*([^\n]+)")
HEART_CD_RE = re.compile(r"共历心劫冷却[:：]\s*([^\n]+)")
FRAGMENT_RE = re.compile(r"(?:虚天残图拼片|拼片进度|当前进度)\s*[:：]?\s*(\d+)\s*/\s*(\d+)")


class ConcubinePanelParser:
    name = "concubine_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        head = CONCUBINE_HEAD_RE.search(text)
        if not head:
            return None
        fields: dict[str, object] = {
            "类型": head.group("kind"),
            "侍妾": head.group("name"),
            "状态": head.group("loc"),
        }
        if m := CONCUBINE_AFFINITY_RE.search(text):
            fields["情缘值"] = int(m.group(1))
        if m := CONCUBINE_OATH_RE.search(text):
            fields["当前誓约"] = m.group(1).strip()
        if m := DREAM_CD_RE.search(text):
            fields["入梦寻图冷却"] = m.group(1).strip()
        if m := TIANJI_CD_RE.search(text):
            fields["天机代卜冷却"] = m.group(1).strip()
        if m := HEART_CD_RE.search(text):
            fields["共历心劫冷却"] = m.group(1).strip()
        if m := FRAGMENT_RE.search(text):
            fields["拼片"] = f"{m.group(1)} / {m.group(2)}"
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine", "training"),
                    title="侍妾面板",
                    summary=f"{fields['类型']} {fields['侍妾']}",
                    source=event.source,
                    time=event.date,
                    tags=("侍妾", "面板"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
        )


# ============ 灵树 ============
TREE_PANEL_KW_A = "【落云宗 · 灵眼之树】"
TREE_PANEL_KW_B = "落云宗·灵眼之树"
TREE_HARVEST_FRUIT_RE = re.compile(r"你摘下一枚【([^】]+)】")
TREE_HARVEST_XIUWEI_RE = re.compile(r"修为增长[:：]\s*\+?\s*([\d,]+)")


class TreeParser:
    name = "tree_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if TREE_PANEL_KW_A in text or TREE_PANEL_KW_B in text:
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("home",),
                        title="灵树面板",
                        summary="落云宗灵眼之树状态",
                        source=event.source,
                        time=event.date,
                        tags=("灵树", "面板"),
                        raw=event.text,
                    ),
                ),
            )
        if fruit := TREE_HARVEST_FRUIT_RE.search(text):
            fields: dict[str, object] = {"采摘果实": fruit.group(1).strip()}
            if x := TREE_HARVEST_XIUWEI_RE.search(text):
                fields["修为增长"] = x.group(1).replace(",", "") + " 点"
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("home", "resource"),
                        title="灵树采摘",
                        summary=f"摘到【{fields['采摘果实']}】",
                        source=event.source,
                        time=event.date,
                        tags=("灵树", "采摘"),
                        raw=event.text,
                        fields=fields,
                    ),
                ),
            )
        return None


# ============ 法宝 抚摸/温养/试炼 ============
PET_TOUCH_RE = re.compile(r"[(（]\s*默契\s*\+\s*(\d+)\s*[,，]\s*经验\s*\+\s*(\d+)\s*[)）]")
PET_WARM_KW = "【温养器灵】"
PET_TRIAL_KW_RE = re.compile(r"【器灵试炼[·・][^】]+】")


class PetParser:
    name = "pet_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if PET_TOUCH_RE.search(text):
            m = PET_TOUCH_RE.search(text)
            fields = {
                "默契": int(m.group(1)),
                "经验": int(m.group(2)),
            }
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("home",),
                        title="抚摸法宝",
                        summary=f"默契 +{m.group(1)}, 经验 +{m.group(2)}",
                        source=event.source,
                        time=event.date,
                        tags=("法宝", "抚摸"),
                        raw=event.text,
                        fields=fields,
                    ),
                ),
            )
        if PET_WARM_KW in text:
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("home",),
                        title="温养器灵",
                        summary="温养结算",
                        source=event.source,
                        time=event.date,
                        tags=("法宝", "温养"),
                        raw=event.text,
                    ),
                ),
            )
        if PET_TRIAL_KW_RE.search(text):
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("home",),
                        title="器灵试炼",
                        summary="器灵试炼结算",
                        source=event.source,
                        time=event.date,
                        tags=("法宝", "试炼"),
                        raw=event.text,
                    ),
                ),
            )
        return None


# ============ 太一 ============
TAIYI_YINDAO_RE = re.compile(r"你引动【([金木水火土])之道】")
TAIYI_NODE_RE = re.compile(r"获得[：:]\s*【(空间节点·[^】]+)】")
TAIYI_DEFINE_KW = "【定星成功】"


class TaiyiParser:
    name = "taiyi_panel"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if m := TAIYI_YINDAO_RE.search(text):
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("mine", "training"),
                        title="引动大道",
                        summary=f"引动 {m.group(1)} 之道",
                        source=event.source,
                        time=event.date,
                        tags=("太一", "引动"),
                        raw=event.text,
                        fields={"五行": m.group(1)},
                    ),
                ),
            )
        if m := TAIYI_NODE_RE.search(text):
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("mine",),
                        title="空间节点",
                        summary=f"获得【{m.group(1)}】",
                        source=event.source,
                        time=event.date,
                        tags=("太一", "节点"),
                        raw=event.text,
                        fields={"节点": m.group(1)},
                    ),
                ),
            )
        if TAIYI_DEFINE_KW in text:
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("mine",),
                        title="定星成功",
                        summary="节点钉成星",
                        source=event.source,
                        time=event.date,
                        tags=("太一", "定星"),
                        raw=event.text,
                    ),
                ),
            )
        return None
