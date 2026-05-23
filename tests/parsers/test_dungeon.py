from backend.parsers.dungeon import DungeonParser
from backend.parsers.xutian_oracle import load_xutian_oracle_cases, xutian_advice
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


def test_xutian_oracle_cases_are_loaded_from_data_file():
    cases = load_xutian_oracle_cases()
    assert len(cases["explicit"]) >= 20
    assert len(cases["success"]) >= 5
    assert len(cases["failure"]) >= 5
    advice = xutian_advice("兑泽上离火下 · 四爻转阵")
    assert advice["行运建议"] == "冰路 / 稳策"
    assert advice["历史顺例"] == ["冰路 / 稳策 (#659 顺)"]


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


def test_extracts_xutian_hou_dian_strategy_actions():
    event = make_event(
        "【第四关·后殿试阵】\n"
        "三座残碑正在争抢殿心主权，队长必须先定试阵之法，才能真正摸到后殿炉心。\n"
        "请在 120秒 内点击按钮，或输入 .后殿阵策 镇/夺/卦：\n"
        "- 镇碑固脉：稳住残碑。\n"
        "- 裂纹夺隙：抢夺裂隙。\n"
        "- 借卦逆推：借卦推演。"
    )

    output = DungeonParser().parse(event)

    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿推进"
    assert card.fields["副本名"] == "虚天殿"
    assert card.fields["阶段"] == "第四关·后殿试阵"
    assert [action.command for action in card.actions] == [
        ".后殿阵策 镇",
        ".后殿阵策 夺",
        ".后殿阵策 卦",
    ]


def test_extracts_xutian_hou_dian_continue_choice_and_result_states():
    afterwave = DungeonParser().parse(
        make_event(
            "【后殿余波】\n"
            "第三关的战利品已先行封存，后续冲关无论成败，都不会回吐当前已得奖励。\n"
            "队长 @cupaopao，请在 120秒 内决定是否继续深入后殿：\n"
            "- 见好就收：就此退去，稳稳带走第三关全部收获\n"
            "- 继续冲关：开启第四、第五关，去抢后殿追加机缘\n"
            "- 也可输入 .后殿抉择 收手 / .后殿抉择 冲关"
        )
    )
    assert afterwave is not None
    assert afterwave.cards[0].title == "虚天殿推进"
    assert afterwave.cards[0].fields["阶段"] == "后殿余波"
    assert afterwave.cards[0].fields["后殿奖励"] == "第三关战利品已锁定"
    assert [action.command for action in afterwave.cards[0].actions] == [
        ".后殿抉择 收手",
        ".后殿抉择 冲关",
    ]

    fifth = DungeonParser().parse(
        make_event(
            "【第五关·虚天鼎灵·残焰】\n"
            "后殿真正的考验终于现身。鼎灵残焰不再吃单纯打断，而会不断抬升 鼎压。\n"
            "你们必须在 5 回合内 压灭残焰，并把鼎压控制在 100 以下。\n"
            "（推演血量：551.58亿 | 开局士气：111% | 开局鼎压：14）"
        )
    )
    assert fifth is not None
    assert fifth.cards[0].fields["状态"] == "后殿冲关中"
    assert fifth.cards[0].fields["推演血量"] == "551.58亿"
    assert fifth.cards[0].fields["开局士气"] == "111%"
    assert fifth.cards[0].fields["开局鼎压"] == "14"

    success = DungeonParser().parse(
        make_event(
            "【第五关·鼎灵余焰】 你们硬生生压灭了后殿残焰，逼得鼎灵退散。\n"
            "所有队员额外获得 2800修为 与 220贡献。\n"
            "路径余韵回响：每位队员再得 天雷竹x1。\n"
            "最终鼎压：32 | 最终士气：118%"
        )
    )
    assert success is not None
    assert success.cards[0].title == "虚天殿后殿冲关成功"
    assert success.cards[0].summary == "虚天殿后殿冲关成功,已记录最终状态。"
    assert success.cards[0].fields["状态"] == "后殿冲关成功"
    assert success.cards[0].fields["后殿追加"] == "已获得"
    assert success.cards[0].fields["最终鼎压"] == "32"
    assert success.cards[0].fields["最终士气"] == "118%"

    stopped = DungeonParser().parse(
        make_event(
            "【后殿冲关止步】\n"
            "回合耗尽，鼎灵残焰仍未被真正压灭。\n"
            "好在第三关结算所得早已锁定，这次失去的只有后殿追加机缘。"
        )
    )
    assert stopped is not None
    assert stopped.cards[0].title == "虚天殿后殿冲关止步"
    assert stopped.cards[0].fields["阶段"] == "后殿冲关止步"
    assert stopped.cards[0].fields["状态"] == "后殿冲关止步"
    assert stopped.cards[0].fields["后殿追加"] == "未获得"


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


def test_extracts_cangkun_open_with_room_id_and_join_action():
    event = make_event(
        "【苍坤上人洞府·集结】\n"
        "@takaranoao_bot 以【苍坤残图】锁定了太妙神禁的薄弱方位！\n"
        "房间ID: 15\n"
        "其他道友可使用 .加入苍坤洞府 15 加入队伍！(5人满)\n"
        "队长可在满员后使用 .进入苍坤洞府。"
    )

    output = DungeonParser().parse(event)

    assert output is not None
    card = output.cards[0]
    assert card.title == "苍坤上人洞府开启"
    assert card.fields["副本名"] == "苍坤上人洞府"
    assert card.fields["副本ID"] == "15"
    assert card.fields["房间ID"] == "15"
    assert card.fields["开门人"] == "@takaranoao_bot"
    assert card.fields["消耗道具"] == "苍坤残图"
    assert card.fields["人数上限"] == "5人"
    assert card.actions[0].label == "加入苍坤洞府"
    assert card.actions[0].command == ".加入苍坤洞府 15"
    assert card.actions[0].reply_to_msg_id is None


def test_extracts_cangkun_choices_and_paths():
    first = DungeonParser().parse(
        make_event(
            "【苍坤上人洞府·第一幕】\n"
            "1 · 匿踪潜行：压低气息。\n"
            "2 · 伪装混入：借势入阵。\n"
            "3 · 强闯速进：强破禁制。\n"
            "请队长使用 .苍坤抉择 1/2/3 做出第一步选择。"
        )
    )
    assert first is not None
    assert first.cards[0].title == "苍坤上人洞府推进"
    assert first.cards[0].fields["阶段"] == "第一幕"
    assert first.cards[0].fields["可选路径"] == [
        "1 · 匿踪潜行",
        "2 · 伪装混入",
        "3 · 强闯速进",
    ]
    assert [action.command for action in first.cards[0].actions] == [
        ".苍坤抉择 1",
        ".苍坤抉择 2",
        ".苍坤抉择 3",
    ]

    later = DungeonParser().parse(
        make_event(
            "【第一幕结果】\n"
            "【第三幕·玉矶阁取宝】\n"
            "1 · 先取卷轴：取走案上古卷。\n"
            "2 · 先开玉盒：强行启盒。\n"
            "3 · 先探偏殿：绕行偏殿。\n"
            "请队长使用 .苍坤抉择 1/2/3 做出取宝选择。"
        )
    )
    assert later is not None
    assert later.cards[0].title == "苍坤上人洞府推进"
    assert later.cards[0].fields["阶段"] == "第三幕·玉矶阁取宝"
    assert later.cards[0].fields["可选路径"] == [
        "1 · 先取卷轴",
        "2 · 先开玉盒",
        "3 · 先探偏殿",
    ]


def test_bare_first_stage_with_xutian_context_is_not_cangkun():
    output = DungeonParser().parse(
        make_event(
            "【第一幕·前殿探路】\n"
            "你们刚踏入虚天殿外层，残破宫阙间便接连涌现尸煞、迷雾与古禁。"
        )
    )

    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿推进"
    assert card.fields["副本名"] == "虚天殿"
    assert card.fields["阶段"] == "第一幕·前殿探路"


def test_extracts_cangkun_all_member_choice_and_final_state():
    choice = DungeonParser().parse(
        make_event(
            "【第四幕·玉矶阁反目】\n"
            "1 · 守契护人：守住契约。\n"
            "2 · 夺图背盟：强夺残图。\n"
            "此阶段需全员表态。每位队员都可使用 .苍坤抉择 1/2 决定立场。"
        )
    )
    assert choice is not None
    assert choice.cards[0].fields["阶段"] == "第四幕·玉矶阁反目"
    assert [action.command for action in choice.cards[0].actions] == [
        ".苍坤抉择 1",
        ".苍坤抉择 2",
    ]

    final = DungeonParser().parse(
        make_event(
            "【苍坤上人洞府·脱身成功】\n"
            "通关保底：每位队员获得 6256修为、555贡献。\n"
            "最终禁制裂隙：108 | 神魂稳度：102 | 慕兰警戒：52 | 卷轴线索：3"
        )
    )
    assert final is not None
    card = final.cards[0]
    assert card.title == "苍坤上人洞府脱身成功"
    assert card.fields["禁制裂隙"] == "108"
    assert card.fields["神魂稳度"] == "102"
    assert card.fields["慕兰警戒"] == "52"
    assert card.fields["卷轴线索"] == "3"


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
