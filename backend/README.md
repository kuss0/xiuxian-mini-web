# Backend

后端基座目录。

计划职责：

- Telegram 登录和会话管理。
- 群消息读取。
- 消息分类和解析。
- JSON API。
- 人工确认发送。
- Telegram 官方定时消息创建、查询、删除。

第一阶段不要接入自动挂机调度。

## 启动

```bash
python3 backend/app.py --host 127.0.0.1 --port 8787
```

当前实现只提供样例数据和 API 边界，后续再接 Telethon、SQLite、解析器。
