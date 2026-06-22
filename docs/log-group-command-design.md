# Mini-Web Log Group Command Design

mini-web 的日志群 listener 对齐 Rust 线 `notify_bot` 的入口拆分:

- `/command`: admin 控制台入口。临时策略下,`log_command_chat_id` 群内任何成员
  都视为 admin;admin DM 仍只允许 `log_command_admin_ids` 中的用户触发。
- `.command`: 群业务映射入口,只在 `log_command_mapping_chat_id` 命中的群里
  认领。未配置映射群时回退到 `log_command_chat_id`。
- 未命中的文本、未知点号命令、非 admin slash 命令都静默跳过。
- 日志群入口只读,不创建 outbox draft,不实发,不创建官方定时。

## Rust-Line Structure Absorbed

| Rust 线 | mini-web 落点 | 说明 |
| --- | --- | --- |
| `notify_bot::allowlist::ingress_kind` | `backend/log_commands/allowlist.py` | `/` 与 `.` 的入口分类是真源。 |
| `notify_bot::pump` | `backend/log_commands/tg_listener.py` | Bot API I/O 先做 ingress 预过滤,只把命中的最小 payload 交给 dispatcher。 |
| `heretical_mapping::ALL` | `backend/log_commands/mapping.py` | 群业务映射使用 registry,每个映射带 usage 和 permission。 |
| `ConsoleSlash` | `LogCommandDispatcher` slash handlers | 只读 admin 命令:帮助、健康、通知状态。 |
| `Mapping(Heretical)` | group mapping handlers | 当前只落 `.还有多少 <物品名>` 的脱敏库存查询。 |

## Command Set

Admin slash:

| 命令 | 返回内容 |
| --- | --- |
| `/帮助` / `/指令` / `/help` | 控制台命令和群业务映射清单。 |
| `/状态` / `/health` / `/status` | mini-web、listener、数据库健康摘要。 |
| `/日志推送状态` / `/通知状态` / `/notify` | 通知配置摘要,不泄露 token。 |

Group mapping:

| 命令 | 权限 | 返回内容 |
| --- | --- | --- |
| `.还有多少 <物品名>` | admin-only | 当前库存子串匹配合计,脱敏,不显示账号明细。 |

## Safety Rules

- 临时策略:配置群内成员视为 admin,可触发只读 slash 和 admin-only mapping。
- `log_command_admin_ids` 仍是 admin DM 的权限来源。
- `log_command_chat_id` 是 admin slash 群入口;admin DM 仍可用。
- `log_command_mapping_chat_id` 是点号业务映射群入口;未配置时回退控制台群。
- listener 使用 raw 前缀语义,不会把带前导空格的 `.cmd` 修正成命令。
- mapping registry 只注册只读行为。副本调度、发送、排班类命令不在 mini-web
  日志群入口落地。
- outbox draft、manual send、official schedule 仍是 Web/UI 明确确认流程,不是
  日志群命令流程。

## Implementation Status

1. 已完成: `backend/log_commands/allowlist.py` 承担 ingress 分类。
2. 已完成: `backend/log_commands/mapping.py` 使用 registry 落 `.还有多少`。
3. 已完成: Telegram listener 预过滤未认领消息。
4. 已完成: `/api/log-commands` 返回只读命令、mapping 和策略摘要。
5. 已完成: 设置弹窗可配置 listener、控制台群、映射群和 admin user id。
