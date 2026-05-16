# Xiuxian Mini Web

> ⚠️ **施工中 / Work in Progress** ⚠️
>
> 本项目仍在快速迭代,接口、数据结构、UI 与目录结构随时可能变动。
> 当前阶段以个人玩家自用为主,**不建议生产环境部署**,也不保证向后兼容。
> 欢迎围观、提 issue,但请勿基于现状写下游脚本/集成。
>
> 进度速览:
> - ✅ 基础聊天 UI / 消息箱 / Telegram 接入 / 多账号多身份
> - ✅ 解析器框架 + 一批战报/状态卡(深度闭关、闭关成功、试炼古塔、战力评估、角色信息 等)
> - ✅ 官方定时(schedule) + 手动 outbox 草稿
> - 🚧 玩法状态机(识别冷却 / 闭关倒计时 / 抚摸法宝 等)— 框架就绪,历史 backfill 待补
> - 🚧 卡片视觉「页游化」— 新卡已套主题渐变,老卡待统一
> - 🛠 待办:身份自动发现(基于 telethon `out` 标志)、批量身份一次性定时

Telegram 修仙群聊的 Web 游戏化辅助界面。

游戏本体仍在 Telegram 群里：玩家聊天、发送指令、接收韩天尊回复。Mini Web 把高噪声的群聊流整理成像网游聊天频道一样的 Web 界面，让玩家更容易看懂消息、按频道筛选、复制或人工确认发送命令，并管理 Telegram 官方定时消息。

它不是旧挂机脚本的替代品，也不是控制台或仪表盘。第一屏直接是聊天界面，不是营销页。

## 核心边界

- 只做 Web 版，暂不做移动 App 接入。
- 只读 Telegram 群消息并按频道分类展示。
- 指令出口只允许两类：
  - 用户人工确认后发送。
  - Telegram 官方定时消息。
- 不做自动连发链路、自动重试、自动补发、自动刷状态。
- 不把游戏群变成脚本日志输出场。

## 主要体验

- 主消息流以 Telegram 原文为第一优先级，按时间分组、按频道过滤，像网游聊天窗口一样滚动浏览。
- 解析器（parser）只做增强：在原文下方追加轻量的标题、标签、动作数量提示，不替代原文。
- 风险类消息（举报、禁言、虚弱等）使用温和警告色提示，不抢占整屏。
- 右侧详情面板始终保留 Telegram 原文，并附上结构化字段和动作草稿。
- 动作草稿区直接展示待发送的命令文本，提供「复制命令」「确认入队」按钮，不做自动发送。
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

首次准备环境：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
```

启动服务：

```bash
.venv/bin/python backend/app.py --host 127.0.0.1 --port 8787
```

打开：

```text
http://127.0.0.1:8787
```

## 安全说明

- 配置接口不会明文返回 `api_hash` 和代理密码；已保存时只显示「已保存，留空不变」。
- 默认只建议绑定 `127.0.0.1` 本地使用。
- 如果要通过反代、隧道或公网访问，必须设置访问口令：

```bash
MINIWEB_ACCESS_TOKEN='换成你的长随机口令' .venv/bin/python backend/app.py --host 127.0.0.1 --port 8787
```

启用后，Web 页面会在首次 API 请求 401 时提示输入访问口令，并在本次浏览器会话内携带。

## 常用 API

只读：

- `GET /api/health`
- `GET /api/channels`
- `GET /api/messages?channel=all`
- `GET /api/state-patches?scope=identity_profile`
- `GET /api/outbox`
- `GET /api/outbox/drafts?status=draft`
- `GET /api/accounts/send-as-peers?local_id=xxx&target_chat=xxx`：按账号 session 调 `channels.GetSendAs` 拉可用身份列表。

写入（均需人工触发，不会被 parser 自动调用）：

- `POST /api/outbox/plan`：仅生成发送计划，便于复制或入队，不会发送。
- `POST /api/outbox/drafts`：把动作入队到 outbox 草稿，等待人工确认。
- `POST /api/outbox/drafts/delete`：删除草稿。
- `POST /api/accounts/resolve-entity`：用账号 session 调 `get_entity` 解析 send_as_id 的 username/title，给身份表单做 hydrate。

## 验证

```bash
node --check web/static/app.js
.venv/bin/python -m pytest -q
```