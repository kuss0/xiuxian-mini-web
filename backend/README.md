# Backend

修仙 Mini Web 的后端。

## 当前实现

- 无 FastAPI / Flask,基于 stdlib `http.server.ThreadingHTTPServer` 手写路由,主入口在 `backend/app.py`。
- 业务收口在 `backend/server.py::MiniWebServer`,持有 store / outbox / 登录 / 监听管理。
- SQLite 持久化在 `backend/repo/sqlite_store.py`,默认数据库 `data/miniweb.db`。
- Telegram 接入用 Telethon 用户登录,长连事件订阅(非 polling、非 webhook),实现见 `backend/tg/`。
- 消息只读监听,新消息落 `raw_messages`,parser 注册表生成 `parsed_cards` 和 `state_patches`。
- 出口分两类:outbox 草稿 / 用户点击后的快捷发送。parser 和 processor 不允许直接发送。
- `POST /api/skills/send` 会在用户点击「确认发送」后走 `backend/outbox/send.py` 调 Telethon `send_message`;这属于手动触发出口,不是内容触发自动发送。

## 启动

```bash
python3 backend/app.py --host 127.0.0.1 --port 8787
```

## 模块边界

- `tg/` 只接入 Telegram(登录、读取群、抽取 sender 显示名、`channels.GetSendAs` 拉可用身份),不理解修仙玩法。
- `inbox` / `repo/sqlite_store.py` 是消息事实来源,所有 parser 读这里。
- `domain/models.py` 定义 `RawMessageEvent / ParsedCard / ActionSuggestion / StatePatch / OutboxDraft`。
- `parsers/` 一个玩法一个文件,只解析,不做 I/O,不发消息。
- `processors/message_pipeline.py` 集中调 parser、生成卡片和动作建议,并追加重点/会长/归档过滤频道。
- `outbox/planner.py` 算发送计划,标记 `manual_confirm_required: True`。
- `outbox/send.py` 是手动快捷发送出口;`skills/send.py` 只保留兼容导出,不能被 parser / processor 自动调用。
- `accounts / identities` 在 SQLite 里独立持久化,身份(send_as)和 Telegram 账号是多对一关系;identity_id == send_as peer ID,登录后会自动 upsert 一条 identity_id == account_id 的 self-identity。

## 不做

- 不接入自动挂机调度。
- 不做自动连发链路、自动重试、自动补发。
- 不根据消息内容自动调用 `/api/skills/send`。
- 不在游戏群输出工具日志。
- 不复用外部老脚本的 runtime 状态。
