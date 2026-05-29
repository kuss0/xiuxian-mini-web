# Docker 部署指南

## 🚀 快速开始

### 1. 构建镜像

```bash
cd /root/xiuxian-mini-web
docker-compose build
```

### 2. 启动服务

```bash
docker-compose up -d
```

### 3. 查看日志

```bash
docker-compose logs -f web
```

### 4. 验证服务

```bash
curl http://localhost:8787/api/health
```

---

## 📋 环境配置

### 创建 .env 文件

```bash
cp .env.example .env
nano .env
```

### 配置说明

```env
# 访问令牌（必须）
MINIWEB_ACCESS_TOKEN=your-secret-token-here

# 速率限制
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_SEC=60
```

---

## 🔧 常用命令

### 启动服务
```bash
docker-compose up -d
```

### 停止服务
```bash
docker-compose down
```

### 重启服务
```bash
docker-compose restart
```

### 查看状态
```bash
docker-compose ps
```

### 查看日志
```bash
docker-compose logs -f
```

### 进入容器
```bash
docker-compose exec web bash
```

---

## 🔄 更新部署

```bash
# 1. 拉取最新代码
git pull

# 2. 重新构建
docker-compose build

# 3. 重启服务
docker-compose up -d
```

---

## 💾 备份和恢复

### 自动备份

备份服务会每天自动备份数据到 `./backups/` 目录。

### 手动备份

```bash
docker-compose exec web tar czf /app/data/backup.tar.gz /app/data/miniweb.db
docker cp xiuxian-web:/app/data/backup.tar.gz ./backups/
```

### 恢复备份

```bash
docker-compose down
tar xzf backups/backup.tar.gz -C ./data/
docker-compose up -d
```

---

## 🎯 多环境部署

### 开发环境

```bash
docker-compose -f docker-compose.dev.yml up
```

### 生产环境

```bash
docker-compose -f docker-compose.prod.yml up -d
```

---

## 🔍 故障排查

### 查看容器状态
```bash
docker-compose ps
```

### 查看详细日志
```bash
docker-compose logs --tail=100 web
```

### 检查健康状态
```bash
docker inspect xiuxian-web | grep -A 10 Health
```

### 重新构建
```bash
docker-compose build --no-cache
docker-compose up -d
```
