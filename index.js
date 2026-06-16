'use strict';

// ════════════════════════════════════════════════════════════
//   匿名聊天室 · Cloudflare Workers + TiDB（单文件版）
//   风格沿用 c.js：OPT 配置块、tidbQuery HTTP Data API、
//   UNHEX/hex BLOB 约定、无 npm 依赖、if/else 路由链。
// ════════════════════════════════════════════════════════════

const OPT = {
  siteName: "匿名聊天室",
  themeURL: "https://raw.githubusercontent.com/<你的用户名>/<theme-repo>/main/",
  themeCacheTtl: 600,
  defaultRoom: "lobby",
  maxNickLen: 16,
  maxMessageLen: 500,
  maxImageBytes: 1572864,        // 1.5MB
  historyLimit: 200,
  rateMsgPerMin: 10,
  rateImgPerMin: 3,
  cleanupBatch: 20,
  imgCacheSec: 86400,
  roomListSize: 50,
  roomNameRe: /^[a-z0-9_-]{1,32}$/,
  allowedImageMime: ["image/jpeg", "image/png", "image/webp", "image/gif"]
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// ────────────────────────────────────────────────────────────
//  TiDB Cloud Serverless HTTP Data API（沿用 c.js）
// ────────────────────────────────────────────────────────────
async function tidbQuery(env, sql, args) {
  const TIDB_URL = env.TIDB_DATABASE_URL;
  if (!TIDB_URL) throw new Error('TiDB未配置');
  const urlObj = new URL(TIDB_URL.replace('mysql://', 'http://').replace(/\?ssl=.*$/, ''));
  const host = urlObj.hostname;
  const username = decodeURIComponent(urlObj.username);
  const password = decodeURIComponent(urlObj.password);
  const database = decodeURIComponent(urlObj.pathname.slice(1)) || 'test';

  let finalSql = sql;
  if (args && args.length > 0) {
    args.forEach(arg => {
      const val = typeof arg === 'string'
        ? "'" + arg.replace(/['\\]/g, m => '\\' + m) + "'"
        : String(arg);
      finalSql = finalSql.replace('?', val);
    });
  }

  const endpoint = 'https://http-' + host + '/v1beta/sql';
  const auth = btoa(username + ':' + password);
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + auth,
      'TiDB-Database': database
    },
    body: JSON.stringify({ query: finalSql })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: resp.statusText }));
    throw new Error('TiDB错误: ' + (err.message || resp.status));
  }
  const data = await resp.json();
  if (data.types && data.rows) {
    const fields = data.types.map(t => t.name);
    data.rows = data.rows.map(row => {
      const obj = {};
      fields.forEach((f, i) => { obj[f] = row[i]; });
      return obj;
    });
  }
  return data;
}

// ────────────────────────────────────────────────────────────
//  小工具
// ────────────────────────────────────────────────────────────
function jsonBody(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function genId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return (ts + rand).slice(0, 26);
}

function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 65, 55);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const NICK_ADJ = ["安静","快乐","勇敢","害羞","聪明","调皮","神秘","闪电","柔软","明亮","遥远","蓝色","金色","森林","海洋","银河","月光","火焰","微风","星辰"];
const NICK_NOUN = ["的猫","的狐","的熊","的兔","的鲸","的鹰","的鹿","的狼","的鸭","的鱼","的狮","的羊","的象","的虎","的雀","的蜂","的猫头鹰","的海豚","的水母","的考拉"];
function defaultNick() {
  const a = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
  const n = NICK_NOUN[Math.floor(Math.random() * NICK_NOUN.length)];
  return a + n + Math.floor(Math.random() * 90 + 10);
}

function sanitizeNick(raw) {
  if (typeof raw !== 'string') return defaultNick();
  const s = raw.trim().slice(0, OPT.maxNickLen);
  if (!s) return defaultNick();
  // 去掉 HTML/控制字符，避免注入
  return s.replace(/[<>&"'`\x00-\x1f]/g, '');
}

function validRoom(name) {
  return typeof name === 'string' && OPT.roomNameRe.test(name);
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ────────────────────────────────────────────────────────────
//  限流（KV 计数，按分钟桶）
// ────────────────────────────────────────────────────────────
async function rateLimit(env, ip, action, limit) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `RL_${action}_${ip}_${minute}`;
  const cur = parseInt(await env.ROOM_INDEX.get(key) || "0", 10);
  if (cur >= limit) return false;
  await env.ROOM_INDEX.put(key, String(cur + 1), { expirationTtl: 70 });
  return true;
}

// ────────────────────────────────────────────────────────────
//  消息持久化
// ────────────────────────────────────────────────────────────
async function insertMessage(env, m) {
  await tidbQuery(env,
    `INSERT INTO chat_messages (room, nick, color, type, text, image_id) VALUES (?, ?, ?, ?, ?, ?)`,
    [m.room, m.nick, m.color, m.type, m.text || null, m.imageId || null]
  );
}

async function getHistory(env, room) {
  const r = await tidbQuery(env,
    `SELECT id, nick, color, type, text, image_id, UNIX_TIMESTAMP(ts) AS ts
     FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?`,
    [room, String(OPT.historyLimit)]
  );
  const rows = r.rows || [];
  rows.reverse();
  return rows.map(row => ({
    id: String(row.id),
    nick: row.nick,
    color: row.color,
    type: row.type,
    text: row.text || "",
    imageId: row.image_id || "",
    ts: Number(row.ts) * 1000
  }));
}

// 溢出清理：删掉 200 条之外的消息，并联动删除对应图片
async function cleanupRoom(env, room) {
  // 找到当前房间第 200 条最新的 id
  const r = await tidbQuery(env,
    `SELECT id FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT 1 OFFSET ?`,
    [room, String(OPT.historyLimit)]
  );
  if (!r.rows || r.rows.length === 0) return;
  const thresholdId = String(r.rows[0].id);

  // 取出待删消息中的 image_id
  const dr = await tidbQuery(env,
    `SELECT image_id FROM chat_messages WHERE room=? AND id <= ? AND image_id IS NOT NULL`,
    [room, thresholdId]
  );
  const imgIds = (dr.rows || []).map(x => x.image_id).filter(Boolean);

  // 删图片
  if (imgIds.length > 0) {
    const inList = imgIds.map(i => "'" + String(i).replace(/['\\]/g, m => '\\' + m) + "'").join(",");
    await tidbQuery(env, `DELETE FROM chat_images WHERE id IN (${inList})`, []);
  }
  // 删消息
  await tidbQuery(env,
    `DELETE FROM chat_messages WHERE room=? AND id <= ?`,
    [room, thresholdId]
  );
}

// ────────────────────────────────────────────────────────────
//  图片持久化
// ────────────────────────────────────────────────────────────
const HEX_CHARS = "0123456789abcdef";
function bytesToHex(uint8) {
  // 分块拼接，避免大数组的 .map/join 触发 GC 与 CPU 爆表
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    let s = '';
    const end = Math.min(i + CHUNK, uint8.length);
    for (let j = i; j < end; j++) {
      const b = uint8[j];
      s += HEX_CHARS[(b >> 4) & 0xF] + HEX_CHARS[b & 0xF];
    }
    out += s;
  }
  return out;
}
async function insertImage(env, id, room, mime, size, uint8) {
  // bytes → hex，TiDB 端 UNHEX 还原成 BLOB
  const hexStr = bytesToHex(uint8);
  await tidbQuery(env,
    `INSERT INTO chat_images (id, room, mime, size, data) VALUES (?, ?, ?, ?, UNHEX(?))`,
    [id, room, mime, String(size), hexStr]
  );
}

async function getImage(env, id) {
  const r = await tidbQuery(env,
    `SELECT mime, data FROM chat_images WHERE id=?`,
    [id]
  );
  if (!r.rows || r.rows.length === 0) return null;
  const row = r.rows[0];
  // data 是 hex string → bytes
  const hex = row.data;
  const bytes = new Uint8Array(hex.length / 2);
  for (let j = 0; j < hex.length; j += 2) {
    bytes[j / 2] = parseInt(hex.substr(j, 2), 16);
  }
  return { mime: row.mime, bytes };
}

// ────────────────────────────────────────────────────────────
//  房间清单（KV）
// ────────────────────────────────────────────────────────────
async function touchRoom(env, name) {
  const raw = await env.ROOM_INDEX.get("ROOMS_INDEX");
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
  list = list.filter(r => r.name !== name);
  list.unshift({ name, lastSeen: Date.now() });
  list = list.slice(0, OPT.roomListSize);
  await env.ROOM_INDEX.put("ROOMS_INDEX", JSON.stringify(list));
}

async function listRooms(env) {
  const raw = await env.ROOM_INDEX.get("ROOMS_INDEX");
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ────────────────────────────────────────────────────────────
//  主题（远程 HTML）
// ────────────────────────────────────────────────────────────
async function serveTheme(path) {
  const resp = await fetch(OPT.themeURL + path, {
    cf: { cacheTtl: OPT.themeCacheTtl }
  });
  if (!resp.ok) return new Response("theme not found: " + path, { status: 502 });
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${OPT.themeCacheTtl}`
    }
  });
}

// ────────────────────────────────────────────────────────────
//  路由处理函数
// ────────────────────────────────────────────────────────────
async function handleUpload(request, env, ip) {
  try {
    if (!await rateLimit(env, ip, "img", OPT.rateImgPerMin)) {
      return jsonBody({ ok: 0, msg: "图片上传过快，请稍后再试" }, 429);
    }
    const form = await request.formData();
    const file = form.get("file");
    const room = form.get("room") || OPT.defaultRoom;
    if (!file) throw new Error("未选择文件");
    if (!validRoom(room)) throw new Error("房间名非法");
    if (!OPT.allowedImageMime.includes(file.type)) throw new Error("仅支持 jpeg/png/webp/gif");
    if (file.size > OPT.maxImageBytes * 1.2) throw new Error("图片过大（" + Math.round(file.size/1024) + "KB）");

    const ab = await file.arrayBuffer();
    const uint8 = new Uint8Array(ab);
    const id = genId();
    await insertImage(env, id, room, file.type, uint8.length, uint8);
    await touchRoom(env, room);
    return jsonBody({ ok: 1, id, url: "/img/" + id });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 400);
  }
}

async function serveImage(env, id) {
  try {
    const cached = await caches.default.match("https://img-cache/" + id);
    if (cached) return cached;
    const img = await getImage(env, id);
    if (!img) return new Response("Not Found", { status: 404 });
    const headers = new Headers({
      "Content-Type": img.mime,
      "Cache-Control": `public, max-age=${OPT.imgCacheSec}, immutable`,
      "Access-Control-Allow-Origin": "*"
    });
    const resp = new Response(img.bytes, { status: 200, headers });
    ctx_try_cache(id, resp.clone());
    return resp;
  } catch (err) {
    return new Response("Error", { status: 500 });
  }
}

// 把图片响应放进 edge cache（不阻塞主流程）
function ctx_try_cache(id, resp) {
  try {
    const key = new Request("https://img-cache/" + id);
    // 用 waitUntil 安全：在 caches API 内部异步执行
    caches.default.put(key, resp).catch(() => {});
  } catch {}
}

async function handleCreateRoom(env, body) {
  try {
    const name = (body.name || "").toLowerCase();
    if (!validRoom(name)) throw new Error("房间名仅允许 1-32 位小写字母数字 _ -");
    await touchRoom(env, name);
    return jsonBody({ ok: 1 });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 400);
  }
}

async function handleWsUpgrade(request, env, path) {
  // path 形如 /ws/<room>
  const m = path.match(/^\/ws\/([^\/]+)$/);
  if (!m) return new Response("Bad Request", { status: 400 });
  const room = decodeURIComponent(m[1]);
  if (!validRoom(room)) return new Response("Invalid room", { status: 400 });

  const id = env.ROOMS.idFromName(room);
  const stub = env.ROOMS.get(id);

  // 把客户端 IP 通过 header 透传给 DO
  const ip = request.headers.get("CF-Connecting-IP") || "0";
  const upstream = new Request(request, {
    headers: new Headers(request.headers)
  });
  upstream.headers.set("X-Client-IP", ip);
  upstream.headers.set("X-Room", room);
  return stub.fetch(upstream);
}

// ────────────────────────────────────────────────────────────
//  Durable Object: RoomDO（仅做 WS 广播 + 落库）
// ────────────────────────────────────────────────────────────
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._room = null;
    this._counter = 0;
  }

  async fetch(request) {
    this._room = request.headers.get("X-Room") || OPT.defaultRoom;
    const ip = request.headers.get("X-Client-IP") || "0";

    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WS", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 把元数据塞进 server 上下文（hibernation 时可读）
    server._ip = ip;
    server._nick = defaultNick();

    this.state.acceptWebSocket(server);

    // 推送历史 + 在线数
    try {
      const history = await getHistory(this.env, this._room);
      server.send(JSON.stringify({ type: "history", msgs: history }));
    } catch (e) {
      server.send(JSON.stringify({ type: "error", msg: "历史加载失败" }));
    }
    this._broadcastOnline();

    await touchRoom(this.env, this._room);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    let m;
    try { m = JSON.parse(msg); } catch {
      ws.send(JSON.stringify({ type: "error", msg: "消息格式错误" }));
      return;
    }

    // 用户自设昵称（默认沿用）
    const nick = sanitizeNick(m.nick || ws._nick);
    ws._nick = nick;
    const color = hashColor(nick + "|" + ws._ip);

    if (m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      return;
    }

    if (!await rateLimit(this.env, ws._ip, "msg", OPT.rateMsgPerMin)) {
      ws.send(JSON.stringify({ type: "error", msg: "发得太快啦，休息一下" }));
      return;
    }

    if (m.type === "text") {
      const text = String(m.text || "").slice(0, OPT.maxMessageLen).trim();
      if (!text) return;
      const enriched = {
        type: "text",
        room: this._room,
        nick, color,
        text,
        ts: Date.now()
      };
      try {
        await insertMessage(this.env, enriched);
        this._counter++;
        if (this._counter % OPT.cleanupBatch === 0) {
          // 异步清理，不阻塞广播
          this._maybeCleanup();
        }
        await touchRoom(this.env, this._room);
        this._broadcast(enriched);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", msg: "发送失败" }));
      }
      return;
    }

    if (m.type === "image") {
      const imageId = String(m.imageId || "").slice(0, 26);
      if (!/^[A-Za-z0-9]{1,26}$/.test(imageId)) return;
      const enriched = {
        type: "image",
        room: this._room,
        nick, color,
        imageId,
        ts: Date.now()
      };
      try {
        await insertMessage(this.env, enriched);
        this._counter++;
        this._broadcast(enriched);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", msg: "图片发送失败" }));
      }
      return;
    }
  }

  async webSocketClose(ws, code, reason) {
    this._broadcastOnline();
  }

  async webSocketError(ws, err) {
    console.error("WS error:", err);
    try { ws.close(1011, "server error"); } catch {}
  }

  _broadcast(obj) {
    const data = typeof obj === "string" ? obj : JSON.stringify(obj);
    const peers = this.state.getWebSockets();
    for (const ws of peers) {
      try { ws.send(data); } catch {}
    }
  }

  _broadcastOnline() {
    const n = this.state.getWebSockets().length;
    this._broadcast({ type: "online", n });
  }

  async _maybeCleanup() {
    try { await cleanupRoom(this.env, this._room); } catch (e) {
      console.error("cleanup failed:", e);
    }
  }
}

// ────────────────────────────────────────────────────────────
//  Worker 入口（module 格式，沿用 c.js 的 if/else 链）
// ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      return await serveTheme("index.html");
    }

    // 房间页：直接返回 SPA HTML，房间名由前端解析
    if (method === "GET" && path.startsWith("/r/")) {
      return await serveTheme("index.html");
    }

    if (method === "GET" && path === "/rooms") {
      return jsonBody({ ok: 1, rooms: await listRooms(env) });
    }

    if (method === "POST" && path === "/api/room/create") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      return await handleCreateRoom(env, body);
    }

    if (method === "POST" && path === "/api/upload") {
      const ip = request.headers.get("CF-Connecting-IP") || "0";
      return await handleUpload(request, env, ip);
    }

    if (method === "GET" && path.startsWith("/img/")) {
      const id = path.slice(5);
      return await serveImage(env, id);
    }

    // WebSocket 升级
    if (method === "GET" && request.headers.get("Upgrade") === "websocket") {
      return await handleWsUpgrade(request, env, path);
    }

    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
