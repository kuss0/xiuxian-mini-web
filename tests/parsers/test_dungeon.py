from backend.parsers.dungeon import DungeonParser
from tests.parsers import load_fixture, make_event


def test_extracts_dungeon_id_and_join_action():
    event = make_event(load_fixture("dungeon_xutian_open.txt"))
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿开启"
    assert card.fields["副本名"] == "虚天殿"
    assert card.fields["副本ID"] == "394"
    assert card.fields["状态"] == "可加入"
    assert card.actions[0].command == ".加入副本 394"
    assert card.actions[0].chat_id == event.chat_id
    assert card.actions[0].reply_to_msg_id == event.msg_id


def test_extracts_full_open_announcement_context():
    event = make_event(
        "【虚天殿已开启】\n"
        "@tinghua01 消耗了【虚天残图】，开启了前往虚天殿的传送门！\n"
        "副本ID: 393\n"
        "其他道友可使用 .加入副本 393 加入队伍！(5人满)"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿开启"
    assert card.fields["开门人"] == "@tinghua01"
    assert card.fields["消耗道具"] == "虚天残图"
    assert card.fields["人数上限"] == "5人"
    assert card.actions[0].label == "加入副本"
    assert card.actions[0].command == ".加入副本 393"


def test_xutian_open_adds_luck_advice_from_same_trigram_history():
    event = make_event(
        "【虚天殿已开启】\n"
        "@boxboxji 消耗了【虚天残图】，开启了前往虚天殿的传送门！\n"
        "副本ID: 662\n"
        "其他道友可使用 .加入副本 662 加入队伍！(5人满)\n"
        "- 本轮卦象已锁定，冷却周期内解散重开不会刷新。\n\n"
        "【卦象词条】 乾天上巽风下 · 四爻转阵\n"
        "- 阵骨：土 必带\n"
        "- 主锋：金 x2（只认真位，不吃借生）\n"
        "- 引灵：木 位，可由 水 借生代行\n"
        "- 旁合：土 位更佳，若用 火 强顶只算偏配\n"
        "- 行运：后续道路与阵策同样受卦象牵引，但不会直示吉路与吉策。\n"
        "- 爻意：四爻重转阵，若无人护阵则整局易散。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.fields["卦象"] == "乾天上巽风下 · 四爻转阵"
    assert card.fields["行运建议"] == "火路 / 压策"
    assert card.fields["建议置信"] == "同卦系推断"
    assert "冰路 / 稳策 (#662 逆)" in card.fields["历史反例"]


def test_xutian_oracle_adds_exact_luck_advice_and_team_fit():
    event = make_event(
        "【卦象验阵】\n"
        "【卦象词条】 兑泽上离火下 · 四爻转阵\n"
        "- 阵骨：土 必带\n"
        "- 主锋：火 x2（只认真位，不吃借生）\n"
        "- 引灵：火 位，可由 木 借生代行\n"
        "- 旁合：土 位更佳，若用 火 强顶只算偏配\n"
        "- 行运：后续道路与阵策同样受卦象牵引，但不会直示吉路与吉策。\n"
        "- 当前契合：顺卦 (阵骨 已立 | 主锋 2/2 | 引灵 木借生代位 | 旁合 欠土)"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿卦象"
    assert card.fields["行运建议"] == "冰路 / 稳策"
    assert card.fields["建议置信"] == "实测顺合"
    assert card.fields["队伍契合"].startswith("顺卦")


def test_extracts_xutian_second_stage_route_actions():
    event = make_event(
        "【第二关·冰火之路】\n"
        "前方出现了两条岔路：一条寒气逼人，一条烈焰熊熊。\n"
        "队长 @boxboxji，请在2分钟内点击下方按钮抉择，"
        "或使用 .选择道路 冰 / .选择道路 火 做出决定！\n"
        "定下路线后，还需再选一次推进阵策。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿推进"
    assert card.fields["阶段"] == "第二关·冰火之路"
    assert [action.command for action in card.actions] == [
        ".选择道路 冰",
        ".选择道路 火",
    ]


def test_extracts_xutian_strategy_and_cauldron_actions():
    strategy = make_event(
        "【第二关·玄冰秘径】\n"
        "你们已定下 玄冰秘径，但要破此偏殿，还需先定推进阵策。\n"
        "队长 @boxboxji，请在 2分钟 内点击按钮，或输入 .阵策 稳/压/势 继续推进："
    )
    output = DungeonParser().parse(strategy)
    assert output is not None
    assert [action.command for action in output.cards[0].actions] == [".阵策 稳", ".阵策 压", ".阵策 势"]

    cauldron = make_event(
        "【鼎前抉择】\n"
        "队长 @boxboxji，请在 120秒 内抉择：\n"
        "- 点击下方按钮，或输入 .争鼎 求稳 / .争鼎 夺鼎\n"
        "若迟迟不决，天机阁将自动按【求稳】结算。"
    )
    output = DungeonParser().parse(cauldron)
    assert output is not None
    assert [action.command for action in output.cards[0].actions] == [".争鼎 求稳", ".争鼎 夺鼎"]


def test_extracts_xutian_route_result_verdict():
    event = make_event(
        "【极寒冰魄】的光芒被成功压制！冰火炼心阵威力大减，你们通过了第二关的考验。\n"
        "第二关余势犹存，第三关开局士气额外 +5%。\n"
        "阵策【稳扎稳打】额外稳住了队伍心气，第三关再获 +8% 士气。\n"
        "你们此轮路策逆卦而行，第三关将额外承受 4% 的卦象压力。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿路策结果"
    assert card.fields["路线"] == "冰路"
    assert card.fields["阵策"] == "稳策"
    assert card.fields["路策判定"] == "逆卦"


def test_extracts_xutian_route_selection_card():
    event = make_event(
        "你们选定了 【玄冰秘径】，主攻阵眼锁定为 【极寒冰魄】。\n"
        "当前阵策：稳扎稳打\n"
        "契合此路的主力道友：@WalterWA2000\n"
        "开局士气：128%"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿路线已选"
    assert card.fields["路线"] == "冰路"
    assert card.fields["阵策"] == "稳策"
    assert card.fields["主力道友"] == "@WalterWA2000"
    assert card.fields["开局士气"] == "128%"


def test_extracts_zhuimo_progress_choices_and_silence_status():
    event = make_event(
        "【坠魔谷·第一幕：裂隙外谷】\n"
        "你们踏入谷口，黑雾翻涌，封印符纹时明时灭。\n"
        "请队长选择推进策略：\n\n"
        "路径1 · 破煞突进：强行冲阵，抢在魔潮成形前压制谷口裂隙。\n"
        "路径2 · 稳守阵眼：以阵法缓进，先稳固封印基座再推进。\n"
        "路径3 · 潜行搜魂：避开主裂隙，绕行残阵寻找古修士遗留封纹。\n\n"
        "使用 .坠魔抉择 路径1/路径2/路径3 继续。\n\n"
        "【稳控全场】已展开\n"
        "副本结束前，天机阁将暂不响应本话题中的其他修仙指令。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "坠魔谷推进"
    assert card.fields["副本名"] == "坠魔谷"
    assert card.fields["阶段"] == "第一幕：裂隙外谷"
    assert card.fields["静场令"] == "已展开"
    assert card.fields["可选路径"] == [
        "路径1 · 破煞突进",
        "路径2 · 稳守阵眼",
        "路径3 · 潜行搜魂",
    ]
    assert [action.command for action in card.actions] == [
        ".坠魔抉择 路径1",
        ".坠魔抉择 路径2",
        ".坠魔抉择 路径3",
    ]
    assert all(action.reply_to_msg_id == event.msg_id for action in card.actions)


def test_extracts_silence_order_ready_message():
    event = make_event(
        "你已祭出【稳控全场】，为本次【坠魔谷】立下静场令。\n"
        "待队长正式带队进入副本后，直至副本结束前，天机阁将暂不响应本话题中的其他修仙指令。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "副本静场令"
    assert card.fields["副本名"] == "坠魔谷"
    assert card.fields["状态"] == "静场令待生效"
    assert card.actions == ()


def test_skips_when_no_dungeon_id_present():
    event = make_event("加入队伍但是没有副本ID 字段")
    assert DungeonParser().parse(event) is None


def test_skips_unrelated_messages():
    event = make_event("玩家聊天")
    assert DungeonParser().parse(event) is None
