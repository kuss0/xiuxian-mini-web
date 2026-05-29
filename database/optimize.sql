-- 数据库性能优化脚本
-- 日期: 2026-05-29

-- 1. 添加复合索引

-- 优化 raw_messages 的频道 + 日期查询
CREATE INDEX IF NOT EXISTS idx_raw_messages_source_date
ON raw_messages(source, date DESC);

-- 优化 parsed_cards 的频道查询
CREATE INDEX IF NOT EXISTS idx_parsed_cards_channel_id
ON parsed_cards(primary_channel, id DESC);

-- 优化 state_patches 的身份 + 序列查询
CREATE INDEX IF NOT EXISTS idx_state_patches_identity_seq
ON state_patches(identity_id, seq DESC);

-- 优化 resource_events 查询
CREATE INDEX IF NOT EXISTS idx_resource_events_identity_period
ON resource_events(identity_id, period_id DESC);

-- 优化 inventory_items 查询
CREATE INDEX IF NOT EXISTS idx_inventory_items_identity_item
ON inventory_items(identity_id, item_key);

-- 优化 send_logs 查询
CREATE INDEX IF NOT EXISTS idx_send_logs_identity_time
ON send_logs(identity_id, sent_at DESC);

-- 2. 分析表统计信息
ANALYZE;

-- 3. 启用 WAL 模式 (Write-Ahead Logging)
PRAGMA journal_mode=WAL;

-- 4. 优化缓存大小 (64MB)
PRAGMA cache_size=-64000;

-- 5. 启用内存映射 (256MB)
PRAGMA mmap_size=268435456;

-- 6. 优化同步模式
PRAGMA synchronous=NORMAL;

-- 7. 启用自动 VACUUM
PRAGMA auto_vacuum=INCREMENTAL;

-- 8. 设置临时存储为内存
PRAGMA temp_store=MEMORY;

-- 9. 优化页面大小
-- PRAGMA page_size=4096;

-- 10. 显示优化结果
SELECT 'Database optimization completed' as status;
