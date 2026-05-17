"""Parser 注册表。新增玩法只要在此处加一行 `registry.register(...)`,
其他模块(pipeline / store / API)不用动。"""

from __future__ import annotations

from backend.domain.registry import ParserRegistry

from .battle_power import BattlePowerParser
from .deep_retreat_summary import DeepRetreatSummaryParser
from .dungeon import DungeonParser
from .dungeon_result import DungeonResultParser
from .inventory import InventoryParser
from .naming import NamingParser
from .panels import (
    ConcubinePanelParser,
    GuanxingParser,
    PetParser,
    SmallWorldPanelParser,
    StargazerPanelParser,
    TaiyiParser,
    TiantiPanelParser,
    TreeParser,
)
from .profile import ProfileParser
from .prompts import (
    HeartPromptParser,
    JiyinPromptParser,
    NanlongPromptParser,
    QuizPromptParser,
    TiandaoPromptParser,
    TianjiQuizPromptParser,
)
from .realm_breakthrough import RealmBreakthroughParser
from .retreat_success import RetreatSuccessParser
from .risk import RiskParser
from .second_soul import SecondSoulParser
from .tower_trial_report import TowerTrialReportParser


def build_parser_registry() -> ParserRegistry:
    registry = ParserRegistry()
    # 优先级:风险/审判类最高(用户决策窗口短),然后 prompt 类,然后 panel/结算 类
    registry.register(RiskParser())
    registry.register(TiandaoPromptParser())
    registry.register(QuizPromptParser())
    registry.register(TianjiQuizPromptParser())
    registry.register(JiyinPromptParser())
    registry.register(NanlongPromptParser())
    registry.register(HeartPromptParser())
    registry.register(SecondSoulParser())
    registry.register(DungeonParser())
    registry.register(DungeonResultParser())
    registry.register(NamingParser())
    registry.register(RealmBreakthroughParser())
    # 面板类(状态/查询)
    registry.register(TiantiPanelParser())
    registry.register(StargazerPanelParser())
    registry.register(GuanxingParser())
    registry.register(SmallWorldPanelParser())
    registry.register(ConcubinePanelParser())
    registry.register(TreeParser())
    registry.register(PetParser())
    registry.register(TaiyiParser())
    # 现成的「结算 / 玉牒 / 战力 / 储物袋 / 试炼塔」最后
    registry.register(ProfileParser())
    registry.register(BattlePowerParser())
    registry.register(InventoryParser())
    registry.register(DeepRetreatSummaryParser())
    registry.register(RetreatSuccessParser())
    registry.register(TowerTrialReportParser())
    return registry


__all__ = ["build_parser_registry"]
