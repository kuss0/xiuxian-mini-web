"""Parser 注册表。新增玩法只要在此处加一行 `registry.register(...)`,
其他模块(pipeline / store / API)不用动。"""

from __future__ import annotations

from backend.domain.registry import ParserRegistry

from .battle_power import BattlePowerParser
from .deep_retreat_summary import DeepRetreatSummaryParser
from .dungeon import DungeonParser
from .inventory import InventoryParser
from .naming import NamingParser
from .profile import ProfileParser
from .realm_breakthrough import RealmBreakthroughParser
from .retreat_success import RetreatSuccessParser
from .risk import RiskParser
from .second_soul import SecondSoulParser
from .tower_trial_report import TowerTrialReportParser


def build_parser_registry() -> ParserRegistry:
    registry = ParserRegistry()
    registry.register(RiskParser())  # 风险优先,优先级最高
    registry.register(SecondSoulParser())
    registry.register(DungeonParser())
    registry.register(NamingParser())
    registry.register(RealmBreakthroughParser())
    registry.register(ProfileParser())
    registry.register(BattlePowerParser())
    registry.register(InventoryParser())
    registry.register(DeepRetreatSummaryParser())
    registry.register(RetreatSuccessParser())
    registry.register(TowerTrialReportParser())
    return registry


__all__ = ["build_parser_registry"]
