-- 匿名聊天室 TiDB 表结构
-- ⚠️ TiDB Cloud SQL Editor 默认只执行光标所在的语句
--    每条 SQL 都要把光标放进去单独点 "Execute" / "Run"

-- ─── 第 1 条：建库（独立执行）────────────────────
CREATE DATABASE IF NOT EXISTS chat;

-- ─── 第 2 条：消息表（独立执行）──────────────────
CREATE TABLE IF NOT EXISTS chat.chat_messages (
  id        BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room      VARCHAR(32)  NOT NULL,
  nick      VARCHAR(32)  NOT NULL,
  color     CHAR(7)      NOT NULL,
  type      VARCHAR(8)   NOT NULL,
  text      VARCHAR(500),
  image_id  CHAR(26),
  ts        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_msg_room (room, id DESC)
);

-- ─── 第 3 条：图片表（独立执行）──────────────────
CREATE TABLE IF NOT EXISTS chat.chat_images (
  id        CHAR(26)     NOT NULL PRIMARY KEY,
  room      VARCHAR(32)  NOT NULL,
  mime      VARCHAR(32)  NOT NULL,
  size      INT          NOT NULL,
  data      LONGBLOB     NOT NULL,
  INDEX idx_img_room (room)
);

-- ─── 第 4 条：消息表加 icon 字段（独立执行，已建表后追加）──
ALTER TABLE chat.chat_messages ADD COLUMN IF NOT EXISTS icon VARCHAR(16) DEFAULT NULL;

-- ─── 第 4.5 条：移除 icon 字段（不需要时执行）──
ALTER TABLE chat.chat_messages DROP COLUMN IF EXISTS icon;

-- ─── 第 5 条：验证（独立执行）────────────────────
SHOW TABLES IN chat;
