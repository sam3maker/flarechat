# flarechat · Cloudflare Workers + TiDB（单文件版）

零依赖、零构建、**纯 Dashboard 粘贴部署**（无需 wrangler）。

## 架构（轮询版，无 Durable Objects）

- **入口**：Cloudflare Workers（module 格式，单 `index.js`）
- **存储**：TiDB Cloud Serverless（HTTP Data API，沿用 c.js 风格）
- **实时**：HTTP 轮询（每 2 秒拉新消息），不依赖 WebSocket / DO
- **前端**：远程 HTML（GitHub Raw），`OPT.themeURL` 拉取
- **限流/房间清单/在线人数**：Workers KV（一个 namespace 复用）

> 为什么不用 WebSocket？Dashboard 在线编辑器无法注册 Durable Object class，
> 而 WebSocket 实时广播必须依赖 DO。本方案放弃 WS 改用轮询，换取纯 Dashboard 部署能力。

## 部署步骤

### 1. TiDB 建表
TiDB Cloud 控制台 → SQL Editor，**逐条**执行 `schema.sql` 里的每条 SQL（光标停在语句上点 Execute）。

### 2. 主题仓库
GitHub 新建公开仓库（如 `flarechat`），把 `theme/index.html` 推到 `main/theme/` 目录下。
确认 `index.js` 顶部 `themeURL` 指向正确路径。

### 3. Cloudflare Dashboard 部署
1. **Workers & Pages** → **Create** → 创建一个新 Worker（比如叫 `flarechat`）
2. 进入 Worker 编辑器，**全选删除默认代码，粘贴 `index.js` 全部内容**
3. **Save and Deploy**

### 4. 绑定资源（Dashboard）
进入 `flarechat` → **Settings**：

- **Bindings** → **Add binding** → **KV namespace**：
  - Variable name: `ROOM_INDEX`
  - 选你创建的 KV namespace（如 `flarechat-kv`）

- **Variables and Secrets** → **Add**：
  - Type: **Secret** (或 Plaintext)
  - Name: `TIDB_DATABASE_URL`
  - Value: 你的 TiDB 连接串（`mysql://...`）

保存后**重新部署** Worker。

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 聊天 SPA（默认 `#lobby`） |
| GET | `/r/<room>` | 进入指定房间 |
| GET | `/rooms` | 活跃房间列表 |
| GET | `/api/messages?room=&since=<id>` | 拉历史/增量消息 |
| POST | `/api/send` | 发消息 `{room,type,text/imageId,nick}` |
| POST | `/api/upload` | 上传图片（multipart）→ `{ok,id,url}` |
| GET | `/img/<id>` | 获取图片（强缓存） |
| POST | `/api/heartbeat?room=` | 心跳 `{clientId}` |
| GET | `/api/online?room=` | 在线人数 `{n}` |
| POST | `/api/room/create` | 创建房间 `{name}` |

## 功能

- 多房间（URL 分享）
- 用户自设昵称（localStorage 记忆）
- 自动颜色（基于昵称 hash）
- 图片发送（Canvas 压缩到 1.5MB）
- 最近 200 条消息历史（滚动清理，图片跟随消息删除）
- IP 限流（消息 10/分钟，图片 3/分钟）
- 在线人数（KV 心跳聚合）
- 移动端响应式
