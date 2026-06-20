# Mini-Web Log Group Command Design

本机 mini-web 目前只有通知 bot 推送能力,没有像 `/opt/xiuxian-main`
那样的日志群命令 listener。本轮已先落地后端命令架构:
日志群 listener 未来只做 Telegram I/O,把消息交给
`/api/log-commands/dispatch`;真正的解析、白名单、发放层级和 outbox
动作都在 `backend/log_commands` 与 `MiniWebServer` 内收口。

## Reference From Mainline

`/opt/xiuxian-main` 的日志群命令分四类:

| 类别 | 主线命令 | mini-web 对应 |
| --- | --- | --- |
| 帮助 | `.指令` / `.帮助` / `.help` | 返回本命令清单和 Web UI 地址 |
| 状态 | `.状态`, `.<模块>状态` | 读取 `/api/health`, `/api/identity-state`, `/api/schedule/modules` |
| 分析 | `.玩法总览`, `.运行健康`, `.日志群分析`, `.miniweb分析` | 生成只读健康摘要、状态机覆盖、未观测模块和消息缺口 |
| 维护 | `.日志推送状态`, `.上线预检`, `.发送日志汇总` | 读取通知配置、schedule sync、listener 状态和最近错误 |

主线有开关和副本群指令,mini-web 先不吸收为日志群动作。mini-web 的发送
入口已经在 Web UI 中有显式确认、outbox guard 和官方定时,日志群不绕过这些
边界;它只能把 intent 落到明确的层级里。

## Rust-Line Structure Absorbed

Rust 线的 `notify_bot`/`console`/`sender` 拆分在 mini-web 中对应为:

| Rust 线 | mini-web 落点 | 说明 |
| --- | --- | --- |
| `notify_bot::parse` | `backend/log_commands.parse_log_command` | 只负责 `.cmd`/`/cmd@bot` 解析,不碰 I/O。 |
| `notify_bot::allowlist` | `LogCommandPolicy` | admin user_id、来源 chat、命令 allowlist 三层分类。 |
| `console::CommandSender` | `LogCommandSource` + dispatch result | 命令体只拿来源元数据和 argv,回复/动作由结果携带。 |
| `sender::PendingSend` | `actions[]` | 命令只生成 `outbox_draft`/`manual_send`/`official_schedule` 动作,由 server 应用。 |
| send log append | 现有 outbox/send log | 真正实发仍走 `/api/skills/send` 和现有 send log。 |

后续加 Telegram listener 时,listener 不能直接调用 `SkillSendService` 或 Telegram
client;只能构造 `LogCommandSource(kind="telegram")` 后调用同一 dispatch 层。

## Command Set

已落地命令:

| 命令 | 返回内容 | 数据源 |
| --- | --- | --- |
| `.帮助` / `.指令` / `.help` | 支持的命令、身份选择格式、发放层级提示 | 静态命令表 + settings |
| `.层级` / `.发送层级` / `.发放层级` | observe/draft/manual_send/official_schedule 分层和当前开关 | `COMMAND_LEVELS` + settings |
| `.状态 [@身份或ID]` | listener、账号、身份、模块状态摘要 | `/api/health`, `/api/identity-state` |
| `.<模块>状态 [@身份或ID]` | 当前先识别模块状态查询;详细 per-identity 状态仍以 Web UI/API 为准 | command layer + 后续 state contract |
| `.运行健康` / `.健康摘要` | listener、数据库、消息断档、调度队列、通知配置摘要 | `/api/health`, `/api/health/audit`, schedule sync |
| `.日志推送状态` | 通知开关、目标 chat、卡片标题订阅、最近推送错误 | settings + notification dispatcher |
| `.草稿 <命令或技能key> [@身份]` | 创建 outbox draft,不实发 | `backend/outbox/planner.py` |
| `.发送 <命令或技能key> @身份` | 建模为 manual_send 层级,默认 blocked | `log_command_manual_send_enabled` |
| `.官方定时 ...` / `.排班 ...` | 建模为 official_schedule 层级,默认 blocked | `log_command_schedule_enabled` |

后续只读命令可继续加 `.玩法总览`、`.miniweb分析`、`.上线预检`;
新增时只需要补 `LOG_COMMAND_SPECS` 和 handler,无需改 Telegram listener。

身份选择沿用主线习惯:命令后可追加 `@昵称` 或 send_as_id。解析不到身份时,
只返回全局摘要和“需要指定身份”的提示,不猜测。

## Send Levels

| 层级 | 默认 | 是否落库/发送 | 当前落地 |
| --- | --- | --- | --- |
| `observe` | 开 | 不变更 | `.帮助`, `.层级`, `.状态`, `.日志推送状态`, `.<模块>状态` |
| `draft` | 开 | 只创建 outbox draft | `.草稿 wild_training @身份` 会保存草稿,后续人工确认 |
| `manual_send` | 关 | 可调用 `/api/skills/send` | `.发送` 先被策略挡住;即使开启也走现有 skill send/send log |
| `official_schedule` | 关 | 可创建 Telegram scheduled message | 命令层已建模,当前仍要求走 Web 排班预检 |

`.草稿` 的命令参数可以是技能 key、技能 label、技能命令或原始命令:

```text
.草稿 wild_training @123456
.草稿 野外历练 @角色名
.草稿 .野外历练 谨慎 --identity 123456
```

身份选择支持 `@send_as_id`、`@label`、`@username`、`--identity <value>`。
解析不到身份时仍可创建 unresolved draft,由 outbox 展示 missing 字段。

## Safety Rules

- 只允许管理员触发;未配置管理员时不启动命令 listener。
- Telegram 入站必须同时通过 admin user_id、来源 chat、命令 allowlist。
- 本地 Web/API 以 `source_kind=local_api` 进入,可用于预演和创建 draft;Telegram
  listener 必须传 `source_kind=telegram`。
- `draft` 层级只创建 outbox draft,不实发。
- `manual_send` 层级默认关闭;开启后也只能走现有 `/api/skills/send` 与 send log。
- `official_schedule` 层级默认关闭;当前仍要求走 Web 排班接口。
- 所有模块状态必须来自 `identity_module_state`、真实 bot 回复或健康接口;
  用户命令文本只作为 intent,不能证明状态。
- 单模块状态要显示 `confidence`, `next_at_source`, `source_message_id` 和 warnings。
- 未观测或 stale 状态只报告风险,不把命令补排为 ready。
- 神物换取、副本抉择、定星、心劫等需要回复上下文的动作只给 Web UI 链接或
  composer 手动入口,日志群不发。

## Implementation Plan

1. 已完成: `backend/log_commands` 纯命令层,输入 text/source/settings,
   输出 reply/actions。
2. 已完成: `/api/log-commands` 返回命令和层级清单。
3. 已完成: `/api/log-commands/dispatch` 分发命令;非 dry-run 时只应用允许动作。
4. 已完成: `.草稿` 落到 outbox draft;`.发送`/`.官方定时` 默认 blocked。
5. 待做: 通知 bot 之外新增可选 command listener,配置项与通知推送分开:
   `log_command_enabled`, `log_command_chat_id`, `log_command_admin_ids`。
6. 待做: listener 只调用命令层生成回复,不复用游戏发送 adapter。
7. 待做: Web UI 的状态页复用同一份命令清单,避免日志群和前端支持项分叉。

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
