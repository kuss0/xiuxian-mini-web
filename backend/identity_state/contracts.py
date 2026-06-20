"""Module contracts for schedule and observation evidence.

This layer is intentionally small.  It describes how module state is proven,
not how gameplay is automated.
"""
from __future__ import annotations

from dataclasses import dataclass

SEND_POLICY_OBSERVE_THEN_SEND = "observe_then_send"
SEND_POLICY_PASSIVE_FIRST = "passive_first"
ACTIVE_QUERY_FALLBACK_ONLY = "fallback_only"
ACTIVE_QUERY_LAST_RESORT = "last_resort"
API_POLICY_BACKUP_ONLY = "backup_only"
API_POLICY_NONE = "none"
READINESS_SAMPLE_COMPLETE = "sample_complete"
READINESS_SAMPLE_PARTIAL = "sample_partial"
READINESS_CONTRACT_ONLY = "contract_only"


@dataclass(frozen=True)
class ModuleContract:
    module_key: str
    label: str
    reply_families: tuple[str, ...] = ()
    send_policy: str = SEND_POLICY_OBSERVE_THEN_SEND
    active_query_policy: str = ACTIVE_QUERY_FALLBACK_ONLY
    duplicate_guard: str = "reply_msg_id"
    readiness: str = READINESS_SAMPLE_PARTIAL
    api_policy: str = API_POLICY_BACKUP_ONLY
    phaseful: bool = False

    def to_api(self) -> dict:
        return {
            "module_key": self.module_key,
            "label": self.label,
            "reply_families": list(self.reply_families),
            "send_policy": self.send_policy,
            "active_query_policy": self.active_query_policy,
            "duplicate_guard": self.duplicate_guard,
            "readiness": self.readiness,
            "api_policy": self.api_policy,
            "phaseful": self.phaseful,
        }


MODULE_CONTRACTS: dict[str, ModuleContract] = {
    "deep_retreat": ModuleContract(
        "deep_retreat",
        "深度闭关",
        ("deep_retreat",),
        send_policy=SEND_POLICY_PASSIVE_FIRST,
        active_query_policy=ACTIVE_QUERY_LAST_RESORT,
        duplicate_guard="phaseful",
        readiness=READINESS_SAMPLE_COMPLETE,
        phaseful=True,
    ),
    "yuanying": ModuleContract(
        "yuanying",
        "元婴出窍",
        ("yuanying",),
        send_policy=SEND_POLICY_PASSIVE_FIRST,
        active_query_policy=ACTIVE_QUERY_LAST_RESORT,
        duplicate_guard="phaseful",
        readiness=READINESS_SAMPLE_COMPLETE,
        phaseful=True,
    ),
    "wild_training": ModuleContract("wild_training", "野外历练", ("wild_training",), readiness=READINESS_SAMPLE_COMPLETE),
    "checkin": ModuleContract("checkin", "宗门点卯", ("checkin",), duplicate_guard="daily_state", readiness=READINESS_SAMPLE_COMPLETE),
    "tower": ModuleContract("tower", "闯塔", ("tower",), duplicate_guard="daily_state", readiness=READINESS_SAMPLE_COMPLETE),
    "ranch": ModuleContract("ranch", "一键放养", ("ranch",), duplicate_guard="passive_result", readiness=READINESS_SAMPLE_COMPLETE),
    "concubine_dream": ModuleContract("concubine_dream", "入梦寻图", ("concubine_dream",), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "concubine_tianji": ModuleContract("concubine_tianji", "天机代卜", ("concubine_tianji",), duplicate_guard="chain_state", readiness=READINESS_SAMPLE_COMPLETE),
    "concubine_heart": ModuleContract("concubine_heart", "共历心劫", ("concubine_heart",), duplicate_guard="round_state", readiness=READINESS_SAMPLE_COMPLETE),
    "divination": ModuleContract("divination", "卜筮问天", ("divination", "divination_exchange"), duplicate_guard="reply_msg_id", readiness=READINESS_SAMPLE_PARTIAL),
    "explore_rift": ModuleContract(
        "explore_rift",
        "探寻裂缝",
        ("explore_rift",),
        send_policy=SEND_POLICY_PASSIVE_FIRST,
        active_query_policy=ACTIVE_QUERY_LAST_RESORT,
        readiness=READINESS_SAMPLE_COMPLETE,
    ),
    "tianti_climb": ModuleContract("tianti_climb", "登天阶", ("tianti_climb", "tianti_status"), readiness=READINESS_SAMPLE_COMPLETE),
    "tianti_wenxin": ModuleContract("tianti_wenxin", "问心台", ("tianti_wenxin", "tianti_status"), duplicate_guard="daily_state", readiness=READINESS_SAMPLE_COMPLETE),
    "tianti_gangfeng": ModuleContract("tianti_gangfeng", "九天罡风", ("tianti_gangfeng", "tianti_status"), readiness=READINESS_SAMPLE_COMPLETE),
    "second_soul": ModuleContract("second_soul", "第二元神", ("second_soul_status", "second_soul_train", "second_soul_choice"), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "taiyi_cycle": ModuleContract("taiyi_cycle", "太一周期", ("taiyi_yindao", "taiyi_node_search"), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "wendao": ModuleContract("wendao", "问道", ("wendao",), readiness=READINESS_SAMPLE_COMPLETE),
    "yindao": ModuleContract("yindao", "引道", ("taiyi_yindao",), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "search_node": ModuleContract("search_node", "搜寻节点", ("taiyi_node_search", "taiyi_node_define"), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "sect_teach": ModuleContract("sect_teach", "宗门传功", ("sect_teach",), duplicate_guard="daily_state", readiness=READINESS_SAMPLE_COMPLETE),
    "pet_touch": ModuleContract("pet_touch", "抚摸法宝", ("pet",), duplicate_guard="pending_reply", readiness=READINESS_SAMPLE_COMPLETE),
    "pet_warm": ModuleContract("pet_warm", "温养器灵", ("pet_warm",), duplicate_guard="pending_reply", readiness=READINESS_SAMPLE_COMPLETE),
    "pet_trial": ModuleContract("pet_trial", "器灵试炼", ("pet_trial",), duplicate_guard="pending_reply", readiness=READINESS_SAMPLE_COMPLETE),
    "retreat_shallow": ModuleContract("retreat_shallow", "闭关修炼", ("deep_retreat",), readiness=READINESS_SAMPLE_PARTIAL),
    "stargazer_guide": ModuleContract("stargazer_guide", "牵引星辰", ("stargazer_guide",), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "stargazer_soothe": ModuleContract("stargazer_soothe", "安抚星辰", ("stargazer_soothe",), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "stargazer_collect": ModuleContract("stargazer_collect", "收集精华", ("stargazer_collect",), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "small_world": ModuleContract("small_world", "小世界", ("small_world_preach", "small_world_query", "small_world_manifest", "small_world_harvest", "small_world_refine"), duplicate_guard="phase", readiness=READINESS_SAMPLE_COMPLETE),
    "weakness": ModuleContract("weakness", "虚弱/静思", (), send_policy=SEND_POLICY_PASSIVE_FIRST, duplicate_guard="passive_observation", readiness=READINESS_CONTRACT_ONLY, api_policy=API_POLICY_NONE),
}

FAMILY_TO_MODULE_KEYS: dict[str, tuple[str, ...]] = {}
for _module_key, _contract in MODULE_CONTRACTS.items():
    for _family in _contract.reply_families:
        FAMILY_TO_MODULE_KEYS.setdefault(_family, tuple())
        FAMILY_TO_MODULE_KEYS[_family] = (*FAMILY_TO_MODULE_KEYS[_family], _module_key)


def module_contract(module_key: str) -> ModuleContract | None:
    return MODULE_CONTRACTS.get(str(module_key or "").strip())


def module_contract_api(module_key: str) -> dict:
    contract = module_contract(module_key)
    if contract:
        return contract.to_api()
    key = str(module_key or "").strip()
    return ModuleContract(key, key or "unknown", readiness=READINESS_CONTRACT_ONLY).to_api()


def module_keys_for_families(families: list[str] | tuple[str, ...]) -> list[str]:
    out: list[str] = []
    for family in families or ():
        for key in FAMILY_TO_MODULE_KEYS.get(str(family or "").strip(), ()):
            if key and key not in out:
                out.append(key)
    return out


__all__ = [
    "ACTIVE_QUERY_FALLBACK_ONLY",
    "ACTIVE_QUERY_LAST_RESORT",
    "API_POLICY_BACKUP_ONLY",
    "API_POLICY_NONE",
    "ModuleContract",
    "READINESS_CONTRACT_ONLY",
    "READINESS_SAMPLE_COMPLETE",
    "READINESS_SAMPLE_PARTIAL",
    "SEND_POLICY_OBSERVE_THEN_SEND",
    "SEND_POLICY_PASSIVE_FIRST",
    "module_contract",
    "module_contract_api",
    "module_keys_for_families",
]
