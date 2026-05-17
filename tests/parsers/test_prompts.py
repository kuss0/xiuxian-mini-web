"""测试 prompt parsers — 验证每类提示都能被识别 + 抽出关键字段 + 给出 .作答 / .稳 等回复动作。"""

from backend.parsers.prompts import (
    HeartPromptParser,
    JiyinPromptParser,
    NanlongPromptParser,
    QuizPromptParser,
    TiandaoPromptParser,
    TianjiQuizPromptParser,
)
from tests.parsers import make_event


# ---------- 玄骨考校 ----------
QUIZ_TEXT = """神念直入脑海，一个苍老的声音向 @ilinuxio 提问：

"在虚天殿中，韩立最终获得的"补天丹"有何奇效？"

A. 令人死而复生
B. 白日飞升灵界
C. 增加结婴几率
D. 大幅增加寿元

小辈，你有 300秒 的时间，回复本消息并使用 .作答 <选项> 给出你的答案。"""


def test_quiz_extracts_options_and_emits_4_actions():
    output = QuizPromptParser().parse(make_event(QUIZ_TEXT))
    assert output is not None
    card = output.cards[0]
    assert card.title == "玄骨考校"
    assert card.fields["timeout_sec"] == 300
    assert card.fields["target"] == "ilinuxio"
    opts = card.fields["options"]
    assert opts["A"].startswith("令人死")
    assert {a.command for a in card.actions} == {".作答 A", ".作答 B", ".作答 C", ".作答 D"}


def test_quiz_skips_message_without_command_hint():
    assert QuizPromptParser().parse(make_event("无关消息")) is None


# ---------- 天机考验 ----------
TIANJI_TEXT = """【天机考验】
@user 道友，请在 10 分钟内直接回复本消息选出正确答案。回答错误或超时将...
A. 选项一
B. 选项二
C. 选项三
D. 选项四"""


def test_tianji_quiz_recognizes_minutes_and_options():
    output = TianjiQuizPromptParser().parse(make_event(TIANJI_TEXT))
    assert output is not None
    assert output.cards[0].fields["timeout_sec"] == 600
    assert len(output.cards[0].actions) == 4


# ---------- 天道审判 ----------
TIANDAO_TEXT = """【天道审判】
对象 【@user】 自证嫌疑，速答以下问心：
阵眼口令: abc123
速答: 三 加 五 等于？
请在 5 分钟内回复本消息。"""


def test_tiandao_extracts_target_token_and_action():
    output = TiandaoPromptParser().parse(make_event(TIANDAO_TEXT))
    assert output is not None
    card = output.cards[0]
    assert card.title == "天道审判"
    assert card.severity == "risk"
    assert card.fields["target"] == "user"
    assert card.fields["token"] == "abc123"
    assert card.fields["timeout_sec"] == 300
    assert card.actions[0].command == ".自证"


# ---------- 极阴祖师 ----------
JIYIN_TEXT = """@vvlvdfr！你感到一股无法抗拒的意志锁定了你的神魂！
一个沙哑的声音在你脑海中响起："小辈，让老夫看看你的成色..."

你必须在 180 分钟 内做出抉择：
1. 回复本消息 .献上魂魄 (高风险，高回报)
2. 回复本消息 .收敛气息 (低风险，低回报)"""


def test_jiyin_emits_two_actions():
    output = JiyinPromptParser().parse(make_event(JIYIN_TEXT))
    assert output is not None
    card = output.cards[0]
    assert card.fields["target"] == "vvlvdfr"
    assert card.fields["timeout_sec"] == 180 * 60
    cmds = {a.command for a in card.actions}
    assert cmds == {".献上魂魄", ".收敛气息"}


# ---------- 南陇侯 ----------
NANLONG_TEXT = """【天机异闻·南陇侯的交易】
@user，南陇侯化身缥缈而至...
你有 30 分钟时间抉择：
1. 回复本消息.交换法宝
2. 回复本消息.交换功法
3. 回复本消息.拒绝交易"""


def test_nanlong_emits_three_actions():
    output = NanlongPromptParser().parse(make_event(NANLONG_TEXT))
    assert output is not None
    card = output.cards[0]
    assert card.fields["timeout_sec"] == 30 * 60
    cmds = {a.command for a in card.actions}
    assert cmds == {".交换 法宝", ".交换 功法", ".拒绝交易"}


# ---------- 共历心劫 ----------
HEART_TEXT = """坠魔心劫降临！你的侍妾紫灵神色凝重。
请在心劫降临时回复 .稳 以共历此劫。"""


def test_heart_emits_steady_action():
    output = HeartPromptParser().parse(make_event(HEART_TEXT))
    assert output is not None
    card = output.cards[0]
    assert card.title == "共历心劫"
    assert card.actions[0].command == ".稳"


def test_heart_skips_status_text_without_steady_hint():
    output = HeartPromptParser().parse(make_event("心劫余波未散,等待恢复"))
    assert output is None or output.cards[0].title != "共历心劫" or len(output.cards[0].actions) == 0
