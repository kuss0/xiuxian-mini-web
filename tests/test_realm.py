from backend.domain.realm import (
    REALM_SORT_ORDER,
    infer_realm_from_xiuwei_max,
    realm_at_least,
    realm_index,
)


def test_realm_sort_order_has_known_realms():
    assert "元婴初期" in REALM_SORT_ORDER
    assert "化神初期" in REALM_SORT_ORDER
    assert REALM_SORT_ORDER.index("元婴初期") < REALM_SORT_ORDER.index("化神初期")


def test_realm_index_returns_minus_one_for_unknown():
    assert realm_index("飞升大乘") == -1
    assert realm_index("") == -1


def test_infer_realm_from_xiuwei_max_known_steps():
    assert infer_realm_from_xiuwei_max(1000000) == "元婴中期"
    assert infer_realm_from_xiuwei_max(2000000) == "元婴后期"
    assert infer_realm_from_xiuwei_max(4000000) == "化神初期"
    assert infer_realm_from_xiuwei_max(100) == "炼气一层"


def test_infer_realm_from_xiuwei_max_unknown_returns_empty():
    assert infer_realm_from_xiuwei_max(0) == ""
    assert infer_realm_from_xiuwei_max(123456) == ""
    assert infer_realm_from_xiuwei_max(None) == ""


def test_realm_at_least_compares_using_sort_order():
    assert realm_at_least("元婴后期", "元婴初期") is True
    assert realm_at_least("元婴初期", "元婴后期") is False
    assert realm_at_least("元婴初期", "元婴初期") is True
    assert realm_at_least("化神初期", "元婴后期") is True


def test_realm_at_least_passes_when_either_unknown():
    """未知境界不参与比较,放行 — 避免冷启动卡死。"""
    assert realm_at_least("", "元婴初期") is True
    assert realm_at_least("元婴初期", "异界传说境") is True
