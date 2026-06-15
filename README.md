# Xiuxian Mini Web

Telegram 修仙群的消息过滤与官方定时副手。

> ⚠️ **施工中 / Work in Progress** ⚠️
>
> 本项目仍在快速迭代,接口、数据结构、UI 与目录结构随时可能变动。
> 当前阶段以个人玩家自用为主,**不建议生产环境部署**,也不保证向后兼容。
> 欢迎围观、提 issue,但请勿基于现状写下游脚本/集成。
>
> 进度速览:
> - ✅ 基础聊天 UI / 消息箱 / Telegram 接入 / 多账号多身份
> - ✅ 重点流过滤：被 @、会长、关键词、风险、副本动作优先展示；点命令和普通 bot 回复归档
> - ✅ 解析器框架 + 一批战报/状态卡(深度闭关、闭关成功、试炼古塔、战力评估、角色信息 等)
> - ✅ 官方定时(schedule)：自定义命令 + CD + 次数为主，玩法预设为辅
> - ✅ 手动快捷回复 / outbox 草稿
> - ✅ 资源统计：野外历练、风希、极阴、南陇侯、非血色副本、灵树采摘按来源/稀有产物聚合
> - ✅ 储物袋库存快照 + 批量转移命令生成（只生成命令，不自动发送/扣库存）
> - ✅ 页游化主界面：角色 HUD、当前态势、世界事件、修仙地图、常用面板 dock
> - ✅ 虚天殿卦象攻略：明示/顺例/反例样本库，只填入命令不自动发送
> - ✅ 苍坤洞府攻略：默认路线、风险路线和历史样本，只填入命令不自动发送
> - 🚧 轻量状态提示(识别冷却 / 闭关倒计时 / 抚摸法宝 等)— 只做展示和排班参考
> - 🚧 卡片视觉「页游化」— 重点卡 + 通用玩法卡已套主题，剩余是专项精修
> - 🛠 待办:身份自动发现(基于 telethon `out` 标志)、更多玩法资源统计、更多卡片视觉统一

Telegram 修仙群聊的 Web 游戏化辅助界面。

游戏本体仍在 Telegram 群里：玩家聊天、发送指令、接收韩天尊回复。Mini Web 把高噪声的群聊流整理成像网游聊天频道一样的 Web 界面，让玩家更容易看懂消息、按频道筛选、复制或人工确认发送命令，并管理 Telegram 官方定时消息。

它不是旧挂机脚本的替代品，也不是控制台或仪表盘。第一屏是过滤后的修仙聊天界面：把真正需要看的消息捞出来，把点命令和普通天尊回复放进归档。

## 核心边界

- 只做 Web 版，暂不做移动 App 接入。
- 只读 Telegram 群消息并按频道分类展示。
- 指令出口只允许两类：
  - 用户人工确认后发送。
  - Telegram 官方定时消息。
- 不做自动连发链路、自动重试、自动补发、自动刷状态。
- 不把游戏群变成脚本日志输出场。

## 主要体验

- 主消息流默认是「重点」：自己的发送、被 @、会长/情报源、关键词事件、风险和可操作副本；普通玩家聊天保留在世界流，可在设置里手动放进重点。
- 点命令和普通天尊回复进入「归档」，仍可按天导出，不占实时视野。
- Telegram 原文始终保留，按时间分组、按频道过滤，像网游聊天窗口一样滚动浏览。
- 解析器（parser）只做增强：在原文下方追加轻量的标题、标签、动作数量提示，不替代原文。
- 风险类消息（举报、禁言、虚弱等）使用温和警告色提示，不抢占整屏。
- 右侧详情面板始终保留 Telegram 原文，并附上结构化字段和动作草稿。
- 动作草稿区直接展示待发送的命令文本，提供「复制命令」「确认发送」「入草稿箱」按钮，不做内容触发自动发送。
- 官方定时以「命令 + CD/间隔 + 次数」为核心，常见玩法只是快捷模板；单个身份最多排未来 7 天且不超过 100 条官方定时。
- UI 默认使用简体中文；发送给游戏 bot 的命令保持游戏原始格式。

## 数据流

```text
Telegram updates
  -> inbox 原始消息箱（SQLite）
  -> chat UI（频道过滤 + 原文优先 + 轻量增强）
  -> 可选 parser 增强（结构化字段 + 动作草稿）
  -> 用户复制命令 / 入队草稿 / 官方定时
```

发送方向只允许：

```text
Web 动作草稿
  -> outbox draft（人工确认）
  -> 普通发送 或 Telegram 官方定时
  -> send log
```

## 目录

- `docs/product-plan.md`：产品定位、MVP、功能边界。
- `docs/architecture.md`：技术架构、模块拆分和不做清单。
- `docs/rust-aligned-plan.md`：参考 Rust 主线后的分层施工计划。
- `backend/`：HTTP 服务、消息箱、Telegram 接入、parser、outbox。
- `web/`：原生 JS / CSS 聊天客户端 UI（不引入大型前端框架）。

## 本地启动

当前基座可直接启动。Telegram 登录、读取群和监听需要安装项目依赖里的 Telethon。

### 安装依赖

**推荐方式 (使用锁定版本，确保环境一致性)**:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**或使用 pyproject.toml (允许小版本更新，适合开发环境)**:

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
```

> **注意**: `requirements.txt` 锁定了精确版本，推荐生产环境使用。`pyproject.toml` 允许小版本更新，适合开发调试。

### 启动服务

```bash
.venv/bin/python backend/app.py --host 127.0.0.1 --port 8787
```

打开：

```text
http://127.0.0.1:8787
```

## 安全说明

- 配置接口不会明文返回 `api_hash` 和代理密码；已保存时只显示「已保存，留空不变」。
- 默认只建议绑定 `127.0.0.1` 本地使用；Docker Compose 也默认只发布到 `127.0.0.1:8787`。如果要通过反代、隧道或公网访问，请在 Cloudflare Access、反代认证或网络层控制访问。
- Mini Web 不再内置认证，页面不会弹出额外输入框，也不会向 API 发送额外认证头。

## 常用 API

只读：

- `GET /api/health`
- `GET /api/channels`
- `GET /api/messages?channel=all`
- `GET /api/state-patches?scope=identity_profile`
- `GET /api/outbox`
- `GET /api/outbox/drafts?status=draft`
- `GET /api/resource-stats?period=day&source_type=all`
- `GET /api/schedule`
- `GET /api/schedule/presets`
- `GET /api/schedule/sync?send_as_id=123`
- `GET /api/accounts/send-as-peers?local_id=xxx&target_chat=xxx`：按账号 session 调 `channels.GetSendAs` 拉可用身份列表。

写入（均需人工触发，不会被 parser 自动调用）：

- `POST /api/outbox/plan`：仅生成发送计划，便于复制或入队，不会发送。
- `POST /api/outbox/drafts`：把动作入队到 outbox 草稿，等待人工确认。
- `POST /api/outbox/drafts/delete`：删除草稿。
- `POST /api/schedule/preview`：预览官方定时排班，不写入 Telegram。
- `POST /api/schedule/create`：人工确认后创建 Telegram 官方定时消息。
- `POST /api/schedule/cancel`：取消还未排到 Telegram 的本地批次。
- `POST /api/schedule/delete`：软删本地批次，并尝试删除已排到 Telegram 的定时消息。
- `POST /api/accounts/resolve-entity`：用账号 session 调 `get_entity` 解析 send_as_id 的 username/title，给身份表单做 hydrate。

## 验证

```bash
node --check web/static/app.js
.venv/bin/python -m pytest -q
```
