#!/bin/bash
# 迁移到 Docker 脚本
# 使用方法: bash scripts/migrate-to-docker.sh

set -e

echo "========================================="
echo "  🐳 迁移到 Docker"
echo "========================================="

cd /root/xiuxian-mini-web

# 1. 停止旧服务
echo "1. 停止旧服务..."
pkill -f "python.*app.py" || true
sleep 2

# 2. 创建 .env 文件
echo "2. 创建环境变量文件..."
cat > .env << 'EOF'
# Xiuxian Mini Web Environment Variables
MINIWEB_HOST=0.0.0.0
MINIWEB_PORT=8787
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_SEC=60
PYTHONUNBUFFERED=1
EOF

# 3. 创建必要的目录
echo "3. 创建目录..."
mkdir -p data logs backups

# 4. 构建 Docker 镜像
echo "4. 构建 Docker 镜像..."
docker-compose build

# 5. 启动 Docker 服务
echo "5. 启动 Docker 服务..."
docker-compose up -d

# 6. 等待服务启动
echo "6. 等待服务启动..."
sleep 5

# 7. 验证服务
echo "7. 验证服务..."
if curl -s http://localhost:8787/api/health | grep -q '"ok":true'; then
    echo "✅ 服务启动成功！"
else
    echo "❌ 服务启动失败，查看日志:"
    docker-compose logs web
    exit 1
fi

# 8. 显示状态
echo ""
echo "========================================="
echo "  ✅ 迁移完成！"
echo "========================================="
echo ""
echo "服务信息:"
docker-compose ps
echo ""
echo "访问地址: http://localhost:8787"
echo ""
echo "常用命令:"
echo "  查看日志: docker-compose logs -f web"
echo "  停止服务: docker-compose down"
echo "  重启服务: docker-compose restart"
echo ""
