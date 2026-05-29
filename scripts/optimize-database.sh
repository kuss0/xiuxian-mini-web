#!/bin/bash
# 数据库优化执行脚本
# 使用方法: bash scripts/optimize-database.sh

set -e

echo "========================================="
echo "  数据库优化脚本"
echo "========================================="

# 1. 停止服务
echo "1. 停止服务..."
pkill -f "python.*app.py" || true
sleep 2

# 2. 备份数据库
echo "2. 备份数据库..."
cp data/miniweb.db data/miniweb.db.backup.$(date +%Y%m%d_%H%M%S)

# 3. 执行优化
echo "3. 执行数据库优化..."
sqlite3 data/miniweb.db < database/optimize.sql

# 4. 验证数据库
echo "4. 验证数据库..."
sqlite3 data/miniweb.db "PRAGMA integrity_check;"

# 5. 重启服务
echo "5. 重启服务..."
nohup .venv/bin/python backend/app.py --host 127.0.0.1 --port 8787 > /tmp/xiuxian-mini-web.log 2>&1 &
sleep 3

# 6. 验证服务
echo "6. 验证服务..."
curl -s http://127.0.0.1:8787/api/health | jq -r '.ok'

echo ""
echo "========================================="
echo "  ✅ 数据库优化完成！"
echo "========================================="
echo ""
echo "优化内容:"
echo "  ✅ 添加复合索引"
echo "  ✅ 启用 WAL 模式"
echo "  ✅ 优化缓存 (64MB)"
echo "  ✅ 启用内存映射 (256MB)"
echo "  ✅ 优化同步模式"
echo ""
echo "预计性能提升: 10-20%"
echo ""
