# Mini-Web Log Group Command Design

本机 mini-web 目前只有通知 bot 推送能力,没有像 `/opt/xiuxian-main`
那样的日志群命令 listener。这里先把可落地的日志群命令面设计清楚:
日志群只做监控、查询、审计和 Web UI 入口,不直接发送游戏命令。

## Reference From Mainline

`/opt/xiuxian-main` 的日志群命令分四类:

| 类别 | 主线命令 | mini-web 对应 |
| --- | --- | --- |
| 帮助 | `.指令` / `.帮助` / `.help` | 返回本命令清单和 Web UI 地址 |
| 状态 | `.状态`, `.<模块>状态` | 读取 `/api/health`, `/api/identity-state`, `/api/schedule/modules` |
| 分析 | `.玩法总览`, `.运行健康`, `.日志群分析`, `.miniweb分析` | 生成只读健康摘要、状态机覆盖、未观测模块和消息缺口 |
| 维护 | `.日志推送状态`, `.上线预检`, `.发送日志汇总` | 读取通知配置、schedule sync、listener 状态和最近错误 |

主线有开关和副本群指令,mini-web 先不吸收为日志群动作。mini-web 的发送
入口已经在 Web UI 中有显式确认、outbox guard 和官方定时,日志群不应绕过这些
边界。

## Command Set

首批命令建议只读:

| 命令 | 返回内容 | 数据源 |
| --- | --- | --- |
| `.帮助` / `.指令` / `.help` | 支持的命令、身份选择格式、Web UI 链接提示 | 静态命令表 + settings |
| `.状态 [@身份或ID]` | listener、账号、身份、模块状态摘要 | `/api/health`, `/api/identity-state` |
| `.<模块>状态 [@身份或ID]` | 单模块状态、next_at、证据来源、风险提示 | `/api/schedule/modules` state contract |
| `.玩法总览 [@身份或ID]` | 已观测模块、未观测模块、可半自动/需接力/仅观测分组 | `/api/schedule/modules` |
| `.运行健康` / `.健康摘要` | listener、数据库、消息断档、调度队列、通知配置摘要 | `/api/health`, `/api/health/audit`, schedule sync |
| `.日志推送状态` | 通知开关、目标 chat、卡片标题订阅、最近推送错误 | settings + notification dispatcher |
| `.miniweb分析` | 状态机覆盖、补排审计风险、未接入主线模块清单 | contracts + docs/state-machine-audit.md |
| `.上线预检` | git 状态、测试建议、Docker 服务健康、未提交文件提示 | 本地只读检查 |

身份选择沿用主线习惯:命令后可追加 `@昵称` 或 send_as_id。解析不到身份时,
只返回全局摘要和“需要指定身份”的提示,不猜测。

## Safety Rules

- 只允许管理员触发;未配置管理员时不启动命令 listener。
- 日志群命令不调用 `/api/skills/send`,不创建 outbox draft,不创建 Telegram
  official scheduled message。
- 所有模块状态必须来自 `identity_module_state`、真实 bot 回复或健康接口;
  用户命令文本只作为 intent,不能证明状态。
- 单模块状态要显示 `confidence`, `next_at_source`, `source_message_id` 和 warnings。
- 未观测或 stale 状态只报告风险,不把命令补排为 ready。
- 神物换取、副本抉择、定星、心劫等需要回复上下文的动作只给 Web UI 链接或
  composer 手动入口,日志群不发。

## Implementation Plan

1. 抽一个纯函数命令层,例如 `backend/ops/log_group_commands.py`,输入
   `(text, sender_id, chat_id)` 和只读 server facade,输出纯文本/HTML card。
2. 先用单元测试覆盖命令解析、身份选择、模块别名和权限拒绝。
3. 在通知 bot 之外新增可选 command listener,配置项与通知推送分开:
   `log_command_enabled`, `log_command_chat_id`, `log_command_admin_ids`。
4. listener 只调用命令层生成回复,不复用游戏发送 adapter。
5. Web UI 的状态页复用同一份命令清单,避免日志群和前端支持项分叉。

## Module Status Alias Baseline

mini-web 第一批应覆盖这些模块状态命令:

- `.深度闭关状态`, `.元婴状态`, `.野外历练状态`, `.点卯状态`, `.宗门传功状态`
- `.闯塔状态`, `.放养状态`, `.探寻裂缝状态`, `.卜筮问天状态`
- `.问道状态`, `.引道状态`, `.搜寻节点状态`, `.第二元神状态`, `.太一状态`
- `.小世界状态`, `.抚摸法宝状态`, `.温养器灵状态`, `.器灵试炼状态`
- `.天机代卜状态`, `.共历心劫状态`, `.牵引星辰状态`, `.安抚星辰状态`,
  `.收集精华状态`

后续如果接入灵树、观星台、周天星斗、三宗门、真仙试锋等主线模块,先补
observe-only state contract,再把对应 `.<模块>状态` 加入命令清单。
