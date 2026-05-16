# Rust-Aligned Implementation Plan

## 目标

Mini Web 按 Rust 主线的结构理念重建，而不是按旧 Python 脚本的功能堆叠方式重建。

Rust 主线值得吸收的是：

- 单一 `Server` 拥有运行态。
- `tg` 只做 Telegram 接入。
- `inbox` 是消息事实来源。
- 业务模块通过注册表接入。
- 决策输出不直接发送，统一进入发送出口。
- `repo` 统一持久化。
- 测试围绕模块边界和 fixture。

Mini Web 的差异是：

- 不做自动挂机行为。
- 不做自动补发和链式发送。
- `Behavior -> PendingSend` 改成 `Parser -> Card/StatePatch/ActionSuggestion`。
- `sender` 只接受用户确认发送或官方定时。

## Rust 主线映射

| Rust 主线 | Mini Web 对应 | 说明 |
| --- | --- | --- |
| `src/tg` | `backend/tg` | Telegram 登录、更新、发送、官方定时。 |
| `src/inbox` | `backend/inbox` | 原始消息箱、索引、replay、增量扫描。 |
| `src/xiuxian/behaviors` | `backend/parsers` | 每个玩法一个模块，但只解析，不发送。 |
| `src/xiuxian/decide.rs` | `backend/processors/message_pipeline.py` | 集中调 parser、分类、生成卡片和动作建议。 |
| `src/sender.rs` | `backend/outbox` | 统一发送出口，禁止绕过。 |
| `src/repo` | `backend/repo` | SQLite row types、读写 helper、migration。 |
| `src/server/main_loop.rs` | `backend/server.py` | 服务生命周期、消息泵、pipeline 调度。 |
| `src/server/global_processors` | `backend/processors` | 全局消息学习/状态投影，第一阶段只做被动投影。 |
| `tests/fixtures` | `tests/fixtures` | 真实文案 fixture 驱动 parser 测试。 |

## 目录计划

```text
backend/
  app.py                  # HTTP 入口，尽量薄
  server.py               # MiniWebServer，拥有 tg/inbox/repo/outbox
  config.py               # env/config 解析

  api/
    __init__.py
    routes.py             # HTTP route 分发
    schemas.py            # API 输出 schema

  tg/
    __init__.py
    client.py             # Telethon client wrapper
    events.py             # Telegram update -> RawMessageEvent
    session.py            # session 路径和登录状态
    scheduled.py          # 官方定时 create/list/delete

  inbox/
    __init__.py
    events.py             # RawMessageEvent
    store.py              # Inbox in-memory view
    index.py              # msg_id/date/tag 索引
    replay.py             # SQLite/jsonl replay

  domain/
    __init__.py
    channels.py           # 频道定义
    models.py             # RawMessageEvent/Card/ActionSuggestion/StatePatch
    registry.py           # parser registry 类型

  parsers/
    __init__.py
    dungeon.py
    second_soul.py
    profile.py
    battle_power.py
    inventory.py
    risk.py

  processors/
    __init__.py
    classifier.py
    message_pipeline.py
    state_projection.py

  outbox/
    __init__.py
    drafts.py
    sender.py
    schedules.py

  repo/
    __init__.py
    db.py
    migrations.py
    messages.py
    cards.py
    identities.py
    outbox.py
    schedules.py
```

## 核心数据流

### 入站消息

```text
Telegram update
  -> tg.events.to_raw_message_event
  -> inbox.upsert
  -> repo.messages.insert
  -> message_pipeline.process
  -> repo.cards/action_suggestions/state_projection upsert
  -> API/Web 读取
```

要求：

- 原始消息先落库，再进内存 view。
- parser 失败不能影响原始消息入库。
- 每条 parser 结果必须能追溯到 raw message id。
- 编辑消息按同一 msg_id 更新。
- 删除消息先记录 tombstone，UI 再隐藏或标记。

### 出站动作

```text
ActionSuggestion
  -> outbox draft
  -> Web 展示账号/群/命令/时间
  -> 用户确认
  -> outbox.sender 普通发送 或 outbox.schedules 官方定时
  -> send log
```

要求：

- API route 不能直接调 tg.send。
- parser/processor 不能直接调 tg.send。
- 发送日志必须记录来源 card、identity、命令、时间、结果。
- 官方定时必须支持 list/delete。

## Server 主循环

参考 Rust 主线固定八步，Mini Web 简化成六步：

1. `drain_tg_updates`
   - 从 Telegram update queue 取消息。
   - 折叠成 `RawMessageEvent`。

2. `upsert_inbox`
   - 原始消息落库。
   - 更新 inbox 内存索引。

3. `run_pipeline`
   - classifier 打频道标签。
   - parser registry 逐个尝试。
   - 生成 `ParsedCard`、`StatePatch`、`ActionSuggestion`。

4. `flush_projections`
   - 写卡片、状态投影、动作建议。
   - 更新 UI 可查询索引。

5. `drain_api_commands`
   - 处理用户确认发送、创建/删除官方定时。
   - 所有出站都进入 outbox。

6. `flush_outbox`
   - 执行已确认的发送或定时变更。
   - 写 send log。

第一版可以不做后台 tick，用 HTTP 请求和 Telegram event handler 驱动；但代码边界仍按这六步设计。

## Phase 0：结构重排

目标：先把项目从单文件 demo 变成 Rust 主线式骨架。

任务：

1. 建立目录结构。
2. 把 `Channel`、sample message、API schema 从 `backend/app.py` 拆到 `domain/api`。
3. 建立 `RawMessageEvent`、`ParsedCard`、`ActionSuggestion`、`StatePatch` dataclass。
4. 建立 parser registry，但先只接 sample parser。
5. `backend/app.py` 变薄，只负责启动 HTTP server。
6. 测试从 `backend.app` 常量迁到 domain/repo/pipeline。

验收：

- `python3 backend/app.py` 仍能启动。
- `GET /api/channels`、`GET /api/messages` 不变或只做兼容扩展。
- 测试通过。
- 没有任何 Telegram 依赖。

## Phase 1：Inbox MVP

目标：做出 miniweb 的事实来源。

任务：

1. 建 `backend/inbox/events.py`。
2. 建 SQLite `raw_messages`。
3. 建 `InboxStore.upsert/scan_after/range_in_window/get`。
4. 支持 sample replay。
5. API 从 store 取消息，而不是从内存常量取。

验收：

- 原始消息能入库。
- 重启后能 replay。
- 同 msg_id 编辑不会重复生成多条卡片。
- parser 失败不丢 raw message。

## Phase 2：Pipeline 和 Parser 注册表

目标：玩法解析从一开始就是可注册、可测试、无副作用。

任务：

1. 建 `Parser` 协议：`parse(event, ctx) -> ParserOutput | None`。
2. 建 `ParserOutput(cards, state_patches, actions)`。
3. 建 `message_pipeline.process(event)`。
4. 首批 parser：
   - `dungeon`
   - `second_soul`
   - `profile`
   - `battle_power`
   - `inventory`
   - `risk`
5. 每个 parser 配真实 fixture。

验收：

- parser 不 import tg/outbox/repo。
- parser 测试只喂文本 fixture。
- 没有 fixture 的文案不写死为规则。
- UI 能看到结构化字段和候选动作。

## Phase 3：UI 频道化

目标：形成“网游聊天频道”体验。

任务：

1. 左侧频道支持多选合并，不再只有单选 tab。
2. 中间消息流按频道/标签/角色过滤。
3. 右侧详情展示：
   - 原文
   - 字段
   - 标签
   - 关联角色
   - 动作建议
4. 动作按钮只做复制或进入确认弹层。

验收：

- 可以同时勾选副本+风险+我的相关。
- 消息详情能看原文。
- 动作不会点击即发送。
- UI 第一屏是消息界面，不是设置页。

## Phase 4：Outbox 和确认发送

目标：所有发送都有统一出口。

任务：

1. 建 `outbox_drafts`。
2. 建 `send_logs`。
3. API：
   - `POST /api/outbox/drafts`
   - `POST /api/outbox/drafts/{id}/confirm`
   - `GET /api/outbox/logs`
4. outbox sender 接普通发送，但默认仍可 dry-run。

验收：

- API route 不直接调用 Telegram。
- 每次发送都能追溯到 action/card。
- 用户能在确认前看到账号、群、命令。
- dry-run 模式下不真的发 Telegram。

## Phase 5：官方定时

目标：替代部分脚本发送机制，但不变成自动挂机。

任务：

1. 接 Telegram 官方定时 create/list/delete。
2. 建 `schedule_plans`。
3. 预设：
   - 深度闭关
   - 抚摸法宝
   - 温养器灵
4. 自定义排班：
   - 命令文本
   - 起始时间
   - 间隔
   - 次数
   - 随机/固定偏移

验收：

- 可以一次排 1-3 天。
- 可以删除未来定时。
- 不自动补发。
- 不在游戏群输出工具日志。

## Phase 6：Telegram 接入

目标：从 sample 数据切到真实 Telegram 消息。

任务：

1. 接 Telethon 登录。
2. 接目标群 updates。
3. 抽取 sender/reply_to/topic/mention。
4. 消息入 inbox。
5. 支持多账号 session，但先只读一个主账号也可以。

验收：

- miniweb 可与旧脚本共存。
- session 独立。
- 不触碰外部老脚本 runtime。
- 真实消息进入 UI。

## Phase 7：状态投影

目标：把“消息盒子”的价值迁过来，但不迁旧脚本状态机。

任务：

1. 身份面板投影：
   - 灵根
   - 修为
   - 宗门
   - 法宝
2. 战力投影。
3. 储物袋库存快照。
4. 第二元神状态。
5. 风险状态。

验收：

- 状态来自消息投影，不来自旧脚本 runtime。
- 每个状态字段有来源消息。
- UI 可显示“更新时间/来源”。

## 第一批 parser 优先级

1. 风险消息
   - 举报/自证/虚弱/封禁/禁言。
   - 这类消息优先级最高，只提示，不自动处理。

2. 副本公告
   - 识别副本 ID。
   - 生成加入副本动作建议。
   - 不自动加入。

3. 身份和战力
   - 服务 UI 状态面板。
   - 是后续角色筛选的基础。

4. 储物袋
   - 服务资源转移 UI。
   - 只做库存展示和命令草稿。

5. 第二元神
   - 识别归位、修炼中、心魔抉择。
   - 生成 `.抉择 稳固道心`、`.元神修炼` 草稿。

## 技术选择

第一版继续 Python 是合理的：

- Telethon 接 Telegram 成本低。
- 现有 Python parser 经验可迁移。
- UI/API 迭代快。
- Rust 主线的结构理念可以照搬，不需要语言也照搬。

以后若需要高并发或严格类型，可以把 `inbox/pipeline/repo` 迁 Rust；但 miniweb 的瓶颈不是性能，而是产品结构和消息建模。

## 风险控制

硬性规则：

- `parsers/` 禁止 import `tg`、`outbox`。
- `processors/` 禁止 import `tg.client`。
- `api/` 禁止直接 import `tg.client`，只能调用 `outbox`。
- 所有出站写 `send_logs`。
- 所有 parser 文案规则必须有 fixture 或日志出处。
- 新玩法先 parser 测试，再 UI，再 outbox。

这几个规则是 miniweb 不滑回挂机脚本的护栏。
