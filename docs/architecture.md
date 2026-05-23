# Architecture

## 结论

Mini Web 不应该做成“旧挂机脚本加一个 UI”。最佳结构应当是一个 Telegram 消息客户端：

```text
Telegram updates
  -> inbox 原始消息箱
  -> classifier 重点/会长/归档/频道分类
  -> parser 注册表
  -> card/state/action suggestion
  -> SQLite store
  -> HTTP API
  -> Web 多频道游戏界面
```

发送链路反过来只允许：

```text
Web action
  -> outbox 草稿
  -> 用户确认
  -> 普通发送 或 Telegram 官方定时
  -> send log
```

任何玩法解析器都不能直接发送消息。
分类器也不能触发发送；它只决定消息是否进入首页重点流、会长流或归档。

## 从 Rust 主线吸收的设计

Rust 主线的核心优点不是语言本身，而是边界清楚：

- `tg`：只处理 Telegram client、session、send-as、更新流。
- `inbox`：全局唯一消息缓存，落 JSONL/索引，业务通过快照读取。
- `xiuxian/behaviors`：玩法行为注册表，每个行为独立文件，统一上下文、统一参数校验。
- `decide`：集中调度行为输出，不让行为自己操作发送器。
- `sender`：统一发送出口，批次、reply、删除策略、发送日志都在这里收口。
- `repo`：状态持久化独立，不散落在业务逻辑里。
- `global_processors`：全局消息学习器和 per-identity 行为分离。

Mini Web 要学习这些结构，但目标不同：

- Rust 主线的 `Behavior -> PendingSend` 在 miniweb 中改成 `Parser -> ActionSuggestion`。
- Rust 主线的自动调度在 miniweb 中只保留为“官方定时排班管理”和“手动快捷回复建议”。
- Rust 主线的 inbox 思路应当保留，而且要成为整个产品的核心。

## 进程边界

第一阶段保持一个独立服务，和现有挂机脚本隔离：

- 不导入旧脚本的 runtime。
- 不共享旧脚本的自动发送状态。
- 可以读取同一个 Telegram 群。
- 可以使用同一组 Telegram API 凭据登录，但 session 独立存放。
- 数据库独立，避免 miniweb 的 UI 状态污染挂机脚本。

## Backend 分层

目标目录：

```text
backend/
  app.py
  config.py
  api/
    routes.py
    schemas.py
  tg/
    client.py
    session.py
    updates.py
    scheduled.py
  inbox/
    events.py
    store.py
    index.py
    replay.py
  domain/
    models.py
    channels.py
    registry.py
  parsers/
    second_soul.py
    dungeon.py
    profile.py
    inventory.py
    risk.py
  processors/
    message_pipeline.py
    state_projection.py
  outbox/
    planner.py
    send.py
    schedule.py
  repo/
    db.py
    migrations.py
    messages.py
    cards.py
    schedules.py
    identities.py
```

### `tg`

职责是接入 Telegram：

- 登录和 session。
- 读取群消息、编辑、删除。
- 抽取 sender、reply_to、topic、mention。
- 普通发送。
- 创建、查看、删除 Telegram 官方定时消息。

这一层不理解修仙玩法，不生成命令。

### `inbox`

这是核心层，功能等价于 Rust 主线的 `inbox`：

- 保存原始消息事件。
- 保留消息原文、sender、reply_to、topic、mention、时间。
- 支持按 msg_id 增量扫描。
- 支持按时间窗查询。
- 支持按频道/标签查询。
- 支持重启 replay。

所有 parser 都读取 inbox 事件，不直接读 Telegram client。

### `domain`

定义稳定 DTO：

- `RawMessageEvent`：Telegram 原始消息事件。
- `MessageEnvelope`：带身份、频道、来源可信度的消息。
- `ParsedCard`：展示给 UI 的卡片。
- `StatePatch`：可选的状态投影，例如灵根、战力、储物袋库存。
- `ActionSuggestion`：候选动作，例如复制、确认发送、创建定时。
- `SchedulePlan`：官方定时排班计划。
- `IdentityRef`：账号/角色/发言身份引用。

这一层不能依赖具体 HTTP 框架或 Telegram SDK。

### `parsers`

玩法解析器只做纯解析：

```text
RawMessageEvent -> ParsedCard + StatePatch + ActionSuggestion[]
```

要求：

- 一个玩法一个文件。
- 每个 parser 在注册表登记。
- parser 不做 I/O。
- parser 不发消息。
- parser 不修改运行时状态，只返回结构化结果。
- 所有文案规则必须有 fixture 或日志出处。

适合首批 parser：

- 副本公告：生成 `.加入副本 <id>` 候选动作。
- 第二元神：识别归位、修炼中、心魔抉择。
- 身份面板：解析灵根、修为、宗门、法宝。
- 战力面板：解析战力构成。
- 储物袋：解析库存。
- 风险：举报、自证、虚弱、封禁、禁言。

### `processors`

处理 parser 输出：

- 消息分类。
- 重点流过滤：不带点玩家消息、被 @、会长/情报源、关键词事件、风险消息、可操作副本。
- 归档分流：点命令、普通 bot 回复和默认不实时关注的消息。
- 卡片生成。
- 状态投影。
- 动作去重。
- 与账号/角色关联。

这里可以有类似 Rust 主线 `global_processors` 的全局处理器，例如题库学习、公告学习、公共事件归档。但 miniweb 第一阶段只做展示和建议，不做自动答题。

### `outbox`

统一出口：

- 保存动作草稿。
- `planner.py` 只负责把 `ActionSuggestion` 解析成待确认计划。
- `send.py` 负责用户确认后的普通发送和 outgoing ingest。
- `schedule.py` 负责 Telegram 官方定时的 plan/create/list/delete。
- 删除未来官方定时。
- 保存 send log。

禁止 parser、processor、API route 直接绕过 outbox 调 Telegram send。

### `repo`

SQLite 表建议：

- `raw_messages`：原始 Telegram 消息。
- `parsed_cards`：结构化卡片。
- `message_tags`：标签索引。
- `identity_profiles`：角色基础信息投影。
- `inventory_snapshots`：储物袋快照。
- `action_suggestions`：候选动作。
- `outbox_drafts`：待确认动作。
- `send_logs`：实际发送记录。
- `schedule_plans`：miniweb 管理的官方定时计划。
- `settings`：频道、语言、账号配置。

## Frontend 分层

Web 第一屏应当是游戏聊天辅助界面，不是控制台或营销页。

从两个修仙游戏仓库吸收的方向：

- `react-xiuxian-game` 的优点是前端按功能切片：`views` 组合 UI，`components` 只展示，`hooks/useXxxHandlers` 收拢交互，`services` 放规则计算，`store` 放全局状态，`constants` 放玩法配置。
- `vue-idle-xiuxian` 的优点是信息架构直接：顶层功能导航、全局角色摘要、每个玩法一个页面，长期状态进 store/IndexedDB，耗时计算用 worker。
- Mini Web 的差异是消息客户端，不是单机放置游戏；因此模块边界围绕“消息、状态投影、动作确认、官方定时”，而不是围绕真实游戏战斗循环。

目标布局：

```text
左侧：官方定时 + 常用入口 + 账号/角色/频道
中间：消息流
右侧：消息详情 + 操作抽屉
底部：发送栏 + 快捷动作
```

目标前端目录：

```text
web/static/
  app.js                 # 启动入口，后续只做 bootstrap
  api.js                 # apiFetch 和 API 封装
  state.js               # 全局状态、选择器、轻量事件派发
  constants.js           # 频道、模块、快捷入口、展示规则表
  ui/
    modal.js             # 通用弹层
    toast.js             # 提示
    format.js            # 时间、数字、文本格式化
  views/
    chat.js              # 消息流、详情、搜索、频道过滤
    cockpit.js           # 角色摘要、模块状态、世界事件
    outbox.js            # 草稿、发送日志、官方定时入口
    inventory.js         # 背包/资源转移
    dungeon.js           # 副本状态和虚天指引
    resources.js         # 资源统计
    accounts.js          # 账号/身份/登录
    settings.js          # 通知、过滤、bot 设置
```

第一阶段可以继续使用原生 JS，不强行引入 React/Vue；关键是先把职责拆开。后续若 UI 继续扩张，再评估 Vite + TypeScript，而不是在单文件里继续堆功能。

### 频道模型

频道不是单选 Tab，而是可合并过滤：

- 世界聊天
- 系统公告
- 我的相关
- 修炼
- 副本
- 资源/交易
- 洞府/家园
- 风险
- 工具日志

用户可以单独查看，也可以勾选合并展示。

### 卡片模型

每条消息保留：

- 摘要标题。
- 原始文本。
- 标签。
- 可信来源。
- 关联角色。
- 结构化字段。
- 候选动作。

UI 面向玩家语言，底层字段保持机器可读。

### 操作模型

动作分三类：

- `copy`：复制命令，零风险。
- `confirm_send`：用户确认后立即发送。
- `schedule`：创建官方定时消息。

没有 `auto_send`。
`confirm_send` 只能来自用户点击，不允许由 parser / processor 根据消息内容自动调用。

### 前端模块边界

每个玩法面板至少分三层：

- `view`：读取 state，渲染 DOM，绑定事件。
- `handler`：把用户操作转换成 API 请求或 state 更新。
- `model/selector`：把 API 数据整理成 UI 可直接使用的展示模型。

禁止继续新增跨域巨型函数，例如一个函数同时 fetch、筛选、生成 HTML、绑定事件、写全局状态。新功能先落到对应 view 文件；共享逻辑上移到 `api/state/ui/constants`。

### 状态和后台计算

Mini Web 的状态分三类：

- 服务端事实：消息、卡片、账号、身份、发送日志、排班，SQLite 是事实来源。
- 前端会话态：当前频道过滤、展开项、选中消息、弹层状态，只保存在浏览器内存。
- 可重算投影：资源统计、库存计划、健康诊断、消息覆盖率，来源必须可追溯。

耗时或批量任务不应阻塞 UI：

- 服务端已有的数据重算优先放后端 API/job。
- 纯前端大量计算以后可以加 Web Worker。
- 所有重算结果都要带来源范围、更新时间和失败状态。

## 官方定时设计

官方定时是 miniweb 的重点能力，不是旧脚本 scheduler。

预设模块：

- 深度闭关：例如 `查看闭关`、数分钟后 `.深度闭关`，按 8h+偏移排多天。
- 抚摸法宝：固定 CD，可排多天。
- 温养器灵：固定 CD，可排多天。
- 自定义排班：用户输入命令、间隔、次数、偏移。

原则：

- 一次排未来最多 7 天；单个身份最多接受 100 条未来官方定时，超过后只提示手动处理。
- 支持查看和删除已排定时。
- 不做自动补发。
- 不在游戏群输出工具日志。
- 排班命令像玩家提前设好的定时消息，而不是后台实时脚本。

## 与旧脚本的关系

旧脚本可提供经验，但不能直接搬运行时：

- 可以复用文案规则。
- 可以复用消息盒子的解析思路。
- 可以复用储物袋、战力、灵根等 parser 规则。
- 不能复用自动补发、全局锁、模块状态机。
- 不能让 miniweb 读取旧脚本状态后直接修改旧脚本状态。

## 施工顺序

### Phase 0：结构定型

- 建立上述目录骨架。
- 定义 domain models。
- 建立 parser registry。
- 建立 sample/in-memory store，让 UI 从新结构取数据。
- 写 API contract tests。

### Phase 1：消息客户端 MVP

- 接 Telegram updates。
- 原始消息入 SQLite。
- inbox 增量扫描。
- Web 多频道展示。
- 原文/结构化卡片/标签展示。

### Phase 2：核心 parser

- 副本公告。
- 第二元神。
- 身份面板。
- 战力面板。
- 储物袋。
- 风险消息。

每个 parser 必须带 fixture 测试。

### Phase 3：动作与官方定时

- 动作草稿。
- 复制命令。
- 用户确认发送。
- 创建/查看/删除官方定时。
- 深度闭关、抚摸、温养器灵预设排班。

### Phase 4：体验完善

- 多账号/多角色视图。
- 繁简显示映射。
- 自定义频道规则。
- 自定义 parser/动作模板。
- 状态面板和库存投影。

## 不做什么

第一阶段明确不做：

- 自动挂机。
- 自动补发。
- 自动链式指令。
- 自动刷状态。
- 自动答题。
- AI 防举报。
- 游戏群工具日志。

这些边界是防止 miniweb 变成第二套高风险脚本的核心。
