# 匿名聊天室 · Cloudflare Workers + TiDB（单文件版）

零依赖、零构建。一个 `index.js` 跑起完整聊天室（含多房间、WebSocket 实时、图片发送）。

## 架构

- **入口**：Cloudflare Workers（module 格式，单 `index.js`）
- **实时**：Durable Objects（hibernation WebSocket，零额外成本）
- **存储**：TiDB Cloud Serverless（HTTP Data API，沿用 c.js 风格）
- **前端**：远程 HTML（GitHub Raw），`OPT.themeURL` 拉取
- **限流/房间清单**：Workers KV

## 部署清单

### 1. TiDB 建表
在 TiDB Cloud 控制台的 SQL Editor 执行 `schema.sql`。

### 2. 创建 GitHub 主题仓库
新建一个公开仓库（如 `anon-chat-theme`），把 `theme/index.html` 推到 main 分支根目录。然后修改 `index.js` 顶部：
```js
themeURL: "https://raw.githubusercontent.com/<你的用户名>/anon-chat-theme/main/"
```

### 3. 创建 KV namespace
```bash
wrangler kv namespace create ROOM_INDEX
```
把返回的 `id` 填入 `wrangler.toml`。

### 4. 注入 TiDB 凭据
```bash
# 本地：复制 .env.example 为 .env 并填值（Wrangler 自 2025-08-08 起原生支持 .env）
cp .env.example .env

# 线上：用 secret 注入（推荐）
wrangler secret put TIDB_DATABASE_URL
# 粘贴：mysql://<user>:<pass>@gateway01.<region>.prod.aws.tidbcloud.com:4000/<db>?ssl={"rejectUnauthorized":true}
#
# 或在 Cloudflare Dashboard：Workers & Pages → 你的 Worker → Settings → Variables and Secrets → Add
```

### 5. 本地调试 / 部署
```bash
wrangler dev      # 本地
wrangler deploy   # 部署
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 聊天 SPA（默认 `#lobby`） |
| GET | `/r/<room>` | 进入指定房间 |
| GET | `/rooms` | 活跃房间列表 |
| POST | `/api/room/create` | 创建房间 `{name}` |
| POST | `/api/upload` | 上传图片（multipart）→ `{ok, id, url}` |
| GET | `/img/<id>` | 获取图片（强缓存） |
| WS  | `/ws/<room>` | 实时连接 |

## 功能

- ✅ 多房间（URL 分享）
- ✅ WebSocket 实时双向
- ✅ 用户自设昵称（localStorage 记忆）
- ✅ 自动颜色（基于昵称 hash）
- ✅ 图片发送（Canvas 压缩到 1.5MB 内）
- ✅ 最近 200 条消息历史（滚动清理，图片跟随消息删除）
- ✅ IP 限流（消息 10/分钟，图片 3/分钟）
- ✅ 在线人数广播
- ✅ 心跳保活
- ✅ 移动端响应式

## 免费额度自检

| 资源 | 用量 | 免费上限 |
|------|------|---------|
| Workers 请求 | ~5万/天 | 10万/天 |
| DO | 与 WS 量级相同 | 含 |
| TiDB row | 图片滚动 ~1GB | 5 GiB |
| TiDB RU | ~10万/天 | 50M/月 |
| KV | 房间清单+限流计数 | 10万读/天 |
