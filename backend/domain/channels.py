from __future__ import annotations

from .models import Channel


CHANNELS = [
    Channel("world", "世界", "普通玩家聊天和公共发言"),
    Channel("system", "系统", "游戏公告、全服事件和 bot 回复"),
    Channel("mine", "我的", "当前角色相关消息"),
    Channel("training", "修炼", "闭关、元婴、第二元神"),
    Channel("dungeon", "副本", "副本开启、加入和队伍状态"),
    Channel("resource", "资源", "储物袋、交易和资源转移"),
    Channel("home", "洞府", "灵树、小世界、侍妾、法宝和灵兽"),
    Channel("risk", "风险", "举报、自证、禁言、虚弱和封禁"),
    Channel("console", "操作", "复制命令、人工确认和官方定时"),
]


def channel_keys() -> set[str]:
    return {channel.key for channel in CHANNELS}
