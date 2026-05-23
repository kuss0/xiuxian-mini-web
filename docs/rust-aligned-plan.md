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

## 外部 Web 游戏仓库映射

参考 `JeasonLoop/react-xiuxian-game`：

- `views/<feature>/index.ts + useXxxHandlers.ts` 对应 Mini Web 的 `web/static/views/<feature>.js + handlers/selectors`。
- `components/common/Modal.tsx` 对应 Mini Web 的通用 `ui/modal.js`，避免每个弹层重复关闭、footer、状态提示逻辑。
- `store/gameStore.ts + uiStore.ts` 对应 Mini Web 的 `state.js`，但 Mini Web 不把服务端事实复制成第二份事实来源，只保存筛选、选中、弹层、加载状态。
- `constants/*` 对应 Mini Web 的频道、模块、技能、展示规则表；固定配置不能散落在渲染函数里。
- `services/*` 对应 Mini Web 的前端纯计算或后端 service。凡是涉及 Telegram、SQLite、发送、排班的逻辑仍放后端。

参考 `setube/vue-idle-xiuxian`：

- 顶部功能导航 + 全局角色摘要适合作为 Mini Web 的角色 HUD 和玩法入口组织方式。
- `plugins/*` 的规则表思路可借鉴到 `domain/constants` 或前端 `constants.js`，用于境界、模块、频道、资源展示配置。
- `workers/*` 的后台计算思路适合后续消息重算、资源统计、库存计划；第一版优先放后端 API，前端 worker 只处理纯浏览器计算。
- `stores/db.js` 的 IndexedDB 思路只作为离线缓存参考。Mini Web 的事实来源仍是 SQLite，浏览器不承担权威存档。

不吸收的部分：

- 不搬单机修仙数值循环。
- 不搬自动历练/自动修炼作为发送驱动。
- 不让前端成为游戏状态事实来源。
- 不为了套框架立刻迁 React/Vue；先用模块化原生 JS 清理现有债务。

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
    planner.py
    send.py
    schedule.py

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
  -> outbox.send 手动发送 或 outbox.schedule 官方定时
  -> send log
```

要求：

- API route 不能直接调 tg.send。
- parser/processor 不能直接调 tg.send。
- 手动发送由 `/api/skills/send` 兼容入口触发，但实现必须收口到 `backend/outbox/send.py`。
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

1. 消息流顶部频道支持横向过滤和多频道合并，不再只有单选 tab。
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

## Phase 3.5：前端模块化

目标：吸收两个修仙游戏仓库的 UI 组织方式，把当前单体 `app.js/styles.css` 拆成可维护模块。

任务：

1. 建前端基础目录：
   - `web/static/api.js`
   - `web/static/state.js`
   - `web/static/constants.js`
   - `web/static/ui/modal.js`
   - `web/static/ui/format.js`
   - `web/static/views/`
2. 先拆无业务风险的公共层：
   - `apiFetch/postJson/fetchJson`
   - modal/toast/status helpers
   - escape/time/number/text formatters
   - 频道、模块、技能、快捷入口常量
3. 再按玩法拆 view：
   - `chat`
   - `cockpit`
   - `outbox`
   - `schedule`
   - `inventory`
   - `dungeon`
   - `resources`
   - `accounts/settings`
4. 每个 view 只暴露 `render/bind/load` 这类小入口。
5. `app.js` 逐步缩成 bootstrap：初始化 state、注册 view、启动 polling。
6. CSS 同步按模块切分或至少按 section 重排，避免新 UI 继续追加到文件尾部。

验收：

- `app.js` 不再承担所有 DOM 查询和所有玩法渲染。
- 新增一个玩法面板时，只改对应 view、constants、少量 bootstrap。
- 公共 modal/status/format 不重复实现。
- `node --check` 和现有 pytest 全通过。

## Phase 4：Outbox 和确认发送

目标：所有发送都有统一出口。

任务：

1. 建 `outbox_drafts`。
2. 建 `send_logs`。
3. API：
   - `GET /api/outbox`
   - `GET /api/outbox/drafts?status=draft`
   - `POST /api/outbox/plan`
   - `POST /api/outbox/drafts`
   - `POST /api/outbox/drafts/delete`
   - `POST /api/skills/send`
4. outbox sender 接手动发送；`/api/skills/send` 是用户点击确认后的兼容入口，不是 parser/processor 可直接调用的自动出口。

验收：

- API route 不直接调用 Telegram。
- 每次发送都能追溯到 action/card。
- 用户能在确认前看到账号、群、命令。
- parser/processor 不能因为识别到消息内容而触发 `/api/skills/send`。

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

- 可以一次排最多 7 天。
- 单个身份最多接受 100 条未来官方定时；超过后不继续发送定时创建请求，只提示用户手动处理。
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

目标：把“消息盒子”的价值迁过来；只吸收旧脚本里可被动验证的
projection / ledger 思路，不吸收自动挂机、链式调度、重试发送。

任务：

1. 身份面板投影：
   - 灵根
   - 修为
   - 宗门
   - 法宝
2. 战力投影。
3. 储物袋库存：
   - `.储物袋` 面板是权威快照。
   - 树采摘、赠送、上架等明确成功回执可写入估算账本。
   - 估算库存必须暴露 `confidence`，手动 `.储物袋` 仍是校准兜底。
4. 小世界状态：
   - 被动记录面板里的信仰、待收香火、香火库存、祈愿等待时间。
   - 收割、淬炼、布道、资源不足只更新状态，不触发下一条命令。
5. 第二元神状态。
6. 风险状态。

验收：

- 状态来自消息投影，不来自旧脚本 runtime。
- 每个状态字段有来源消息。
- UI 可显示“更新时间/来源”。
- parser / 状态机不能直接调用发送出口。

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
   - 展示快照库存和估算 current 库存。
   - 只生成命令草稿，不自动发送。

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
