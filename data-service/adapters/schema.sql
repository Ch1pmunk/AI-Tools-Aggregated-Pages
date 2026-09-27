-- ===========================================================================
-- MySQL 数据源建表脚本（配合 adapters/mysql.js 使用）
--
--   执行：mysql -u root -p ai_tools < data-service/adapters/schema.sql
--
-- 字符集必须是 utf8mb4：icon 字段存的是 emoji，老的三字节 utf8 会把它存成问号。
-- 分类用关联表而不是 JSON 列，因为按分类分组统计要能走索引。
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tools (
  id          VARCHAR(64)   NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  description TEXT,
  icon        VARCHAR(16),
  url         VARCHAR(2048) NOT NULL DEFAULT '',
  enabled     TINYINT(1)    NOT NULL DEFAULT 1,
  likes       INT           NOT NULL DEFAULT 0,      -- 点赞数，首页热门按它降序
  sort_order  INT           NOT NULL DEFAULT 1000,   -- 对应记录里的 order 字段
  PRIMARY KEY (id),
  KEY idx_enabled_sort (enabled, sort_order),
  KEY idx_hot (enabled, likes)                       -- 首页热门那条查询走它
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS tool_tags (
  tool_id VARCHAR(64) NOT NULL,
  tag     VARCHAR(64) NOT NULL,
  PRIMARY KEY (tool_id, tag),        -- 同一个工具的同一个标签只能有一条
  KEY idx_tag (tag),                 -- 按标签筛选与分组统计走它
  CONSTRAINT fk_tool_tags_tool FOREIGN KEY (tool_id)
    REFERENCES tools (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
