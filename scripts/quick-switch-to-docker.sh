#!/bin/bash
# 快速切换到 Docker 脚本
# 使用方法: bash scripts/quick-switch-to-docker.sh

set -e

echo "========================================="
echo "  🚀 快速切换到 Docker"
echo "========================================="
echo ""

cd /root/xiuxian-mini-web

# 1. 停止旧服务
echo "1. 停止旧服务 (PID: 898381)..."
kill 898381 || true
sleep 2

# 2. 验证端口释放
echo "2. 验证端口释放..."
if lsof -i :8787 > /dev/null 2>&1; then
    echo "❌ 端口 8787 仍被占用"
    lsof -i :8787
    exit 1
else
    echo "✅ 端口 8787 已释放"
fi

# 3. 启动 Docker 服务
echo "3. 启动 Docker 服务..."
docker-compose up -d

# 4. 等待服务启动
echo "4. 等待服务启动..."
sleep 5

# 5. 验证服务
echo "5. 验证服务..."
if curl -s http://localhost:8787/api/health | grep -q '"ok":true'; then
    echo "✅ Docker 服务启动成功！"
else
    echo "❌ Docker 服务启动失败"
    echo "查看日志:"
    docker-compose logs --tail=50 web
    exit 1
fi

# 6. 显示状态
echo ""
echo "========================================="
echo "  ✅ 迁移完成！"
echo "========================================="
echo ""
echo "Docker 容器状态:"
docker-compose ps
echo ""
echo "服务健康检查:"
curl -s http://localhost:8787/api/health | jq .
echo ""
echo "常用命令:"
echo "  查看日志: docker-compose logs -f web"
echo "  停止服务: docker-compose down"
echo "  重启服务: docker-compose restart"
echo "  查看状态: docker-compose ps"
echo ""
echo "🎉 成功迁移到 Docker！"
echo ""
