'use strict';

// ════════════════════════════════════════════════════════════
//   flarechat · Cloudflare Workers + TiDB（单文件 · 纯 HTTP 轮询版）
//   无 Durable Objects，无 npm 依赖，可在 Dashboard 直接粘贴部署。
//   风格沿用 c.js：OPT 块、tidbQuery HTTP Data API、if/else 路由链。
// ════════════════════════════════════════════════════════════

const OPT = {
  siteName: "flarechat",
  themeURL: "https://raw.githubusercontent.com/sam3maker/flarechat/main/theme/",
  faviconURL: "",                 // 留空 → 默认 💬 emoji SVG；填 URL → 透传该 favicon
  themeCacheTtl: 600,
  defaultRoom: "lobby",
  maxNickLen: 16,
  maxMessageLen: 500,
  maxImageBytes: 1572864,        // 1.5MB
  historyLimit: 200,
  rateMsgPerMin: 10,
  rateImgPerMin: 3,
  cleanupChance: 0.05,
  imgCacheSec: 86400,
  roomListSize: 50,
  heartbeatTtl: 60,
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
  return hslToHex(hue, 75, 65);   // 高饱和度+亮度，避免接近黑色，深色背景下清晰可见
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
  return s.replace(/[<>&"'`\x00-\x1f]/g, '');
}

function validRoom(name) {
  return typeof name === 'string' && OPT.roomNameRe.test(name);
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

async function getRecent(env, room) {
  const r = await tidbQuery(env,
    `SELECT id, nick, color, type, text, image_id, UNIX_TIMESTAMP(ts) AS ts
     FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?`,
    [room, OPT.historyLimit]
  );
  const rows = (r.rows || []).slice().reverse();
  return rows.map(rowToMsg);
}

async function getSince(env, room, sinceId) {
  const r = await tidbQuery(env,
    `SELECT id, nick, color, type, text, image_id, UNIX_TIMESTAMP(ts) AS ts
     FROM chat_messages WHERE room=? AND id > ? ORDER BY id ASC LIMIT 100`,
    [room, sinceId]
  );
  return (r.rows || []).map(rowToMsg);
}

function rowToMsg(row) {
  return {
    id: String(row.id),
    nick: row.nick,
    color: row.color,
    type: row.type,
    text: row.text || "",
    imageId: row.image_id || "",
    ts: Number(row.ts) * 1000,
    recalled: row.type === "recalled"
  };
}

// 溢出清理：删掉 200 条之外的消息，并联动删除对应图片
async function cleanupRoom(env, room) {
  const r = await tidbQuery(env,
    `SELECT id FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT 1 OFFSET ?`,
    [room, OPT.historyLimit]
  );
  if (!r.rows || r.rows.length === 0) return;
  const thresholdId = String(r.rows[0].id);

  const dr = await tidbQuery(env,
    `SELECT image_id FROM chat_messages WHERE room=? AND id <= ? AND image_id IS NOT NULL`,
    [room, thresholdId]
  );
  const imgIds = (dr.rows || []).map(x => x.image_id).filter(Boolean);

  if (imgIds.length > 0) {
    const inList = imgIds.map(i => "'" + String(i).replace(/['\\]/g, m => '\\' + m) + "'").join(",");
    await tidbQuery(env, `DELETE FROM chat_images WHERE id IN (${inList})`, []);
  }
  await tidbQuery(env,
    `DELETE FROM chat_messages WHERE room=? AND id <= ?`,
    [room, thresholdId]
  );
}

// ────────────────────────────────────────────────────────────
//  图片持久化（UNHEX/hex 约定）
// ────────────────────────────────────────────────────────────
const HEX_CHARS = "0123456789abcdef";
function bytesToHex(uint8) {
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
  const hex = row.data;
  const bytes = new Uint8Array(hex.length / 2);
  for (let j = 0; j < hex.length; j += 2) {
    bytes[j / 2] = parseInt(hex.substr(j, 2), 16);
  }
  return { mime: row.mime, bytes };
}

// ────────────────────────────────────────────────────────────
//  房间清单 + 心跳（KV）
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

async function heartbeat(env, room, clientId) {
  const key = `HB_${room}_${clientId}`;
  await env.ROOM_INDEX.put(key, "1", { expirationTtl: OPT.heartbeatTtl });
}

async function countOnline(env, room) {
  const prefix = `HB_${room}_`;
  let count = 0, cursor;
  do {
    const r = await env.ROOM_INDEX.list({ prefix, cursor });
    count += r.keys.length;
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return count;
}

// ────────────────────────────────────────────────────────────
//  主题（远程 HTML，强制 Content-Type）
// ────────────────────────────────────────────────────────────
async function serveTheme(path) {
  const resp = await fetch(OPT.themeURL + path, {
    cf: { cacheTtl: OPT.themeCacheTtl }
  });
  if (!resp.ok) return new Response("theme not found: " + path, { status: 502 });

  let ct;
  if (path.endsWith(".html")) ct = "text/html; charset=utf-8";
  else if (path.endsWith(".css")) ct = "text/css; charset=utf-8";
  else if (path.endsWith(".js"))  ct = "application/javascript; charset=utf-8";
  else if (path.endsWith(".json")) ct = "application/json; charset=utf-8";
  else if (path.endsWith(".svg")) ct = "image/svg+xml";
  else ct = resp.headers.get("Content-Type") || "text/html; charset=utf-8";

  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": ct,
      "Cache-Control": `public, max-age=${OPT.themeCacheTtl}`
    }
  });
}

// favicon：OPT.faviconURL 控制（部署者专属，前端不暴露修改入口）
async function serveFavicon() {
  const url = OPT.faviconURL;
  if (!url || url === "emoji") {
    // 默认：emoji 💬 SVG
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">💬</text></svg>';
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400"
      }
    });
  }
  try {
    const resp = await fetch(url, { cf: { cacheTtl: 86400 } });
    if (!resp.ok) return new Response("favicon fetch failed", { status: 502 });
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "image/x-icon",
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch (err) {
    return new Response("favicon error", { status: 500 });
  }
}

// ────────────────────────────────────────────────────────────
//  路由处理
// ────────────────────────────────────────────────────────────
async function handleMessages(env, url) {
  try {
    const room = url.searchParams.get("room") || OPT.defaultRoom;
    if (!validRoom(room)) return jsonBody({ ok: 0, msg: "房间名非法" }, 400);
    const sinceId = parseInt(url.searchParams.get("since") || "0", 10);
    const msgs = sinceId > 0
      ? await getSince(env, room, sinceId)
      : await getRecent(env, room);
    return jsonBody({ ok: 1, msgs });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 500);
  }
}

async function handleSend(env, ip, body) {
  try {
    if (!await rateLimit(env, ip, "msg", OPT.rateMsgPerMin)) {
      return jsonBody({ ok: 0, msg: "发得太快啦，休息一下" }, 429);
    }
    const room = body.room || OPT.defaultRoom;
    if (!validRoom(room)) throw new Error("房间名非法");
    const nick = sanitizeNick(body.nick);
    const color = hashColor(nick + "|" + ip);

    let enriched;
    if (body.type === "text") {
      const text = String(body.text || "").slice(0, OPT.maxMessageLen).trim();
      if (!text) throw new Error("消息为空");
      enriched = { type: "text", room, nick, color, text };
    } else if (body.type === "image") {
      const imageId = String(body.imageId || "").slice(0, 26);
      if (!/^[A-Za-z0-9]{1,26}$/.test(imageId)) throw new Error("图片 id 非法");
      enriched = { type: "image", room, nick, color, imageId };
    } else {
      throw new Error("消息类型非法");
    }

    await insertMessage(env, enriched);
    await touchRoom(env, room);
    await heartbeat(env, room, ip);   // 发消息也续期在线状态

    if (Math.random() < OPT.cleanupChance) {
      try { await cleanupRoom(env, room); } catch (e) {}
    }

    // 取回刚插入的 id/ts
    const r = await tidbQuery(env,
      `SELECT id, UNIX_TIMESTAMP(ts) AS ts FROM chat_messages
       WHERE room=? AND nick=? AND type=? ORDER BY id DESC LIMIT 1`,
      [room, nick, enriched.type]
    );
    if (r.rows && r.rows.length > 0) {
      enriched.id = String(r.rows[0].id);
      enriched.ts = Number(r.rows[0].ts) * 1000;
    }
    return jsonBody({ ok: 1, msg: enriched });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 400);
  }
}

async function handleHeartbeat(env, url, body) {
  try {
    const room = url.searchParams.get("room") || body.room || OPT.defaultRoom;
    if (!validRoom(room)) return jsonBody({ ok: 0, msg: "房间名非法" }, 400);
    const clientId = String(body.clientId || genId()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "anon";
    await heartbeat(env, room, clientId);
    return jsonBody({ ok: 1 });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 400);
  }
}

// 撤回消息（软删除：仅本人 + 5 分钟内）
async function handleRecall(env, ip, body) {
  try {
    const id = String(body.id || "").replace(/[^0-9]/g, "");
    if (!id) throw new Error("缺少消息 id");
    const nick = sanitizeNick(body.nick);

    const r = await tidbQuery(env,
      `SELECT nick, type, image_id, UNIX_TIMESTAMP(ts) AS ts
       FROM chat_messages WHERE id=?`,
      [id]
    );
    if (!r.rows || r.rows.length === 0) throw new Error("消息不存在");
    const row = r.rows[0];
    if (row.type === "recalled") throw new Error("消息已被撤回");
    if (row.nick !== nick) throw new Error("只能撤回自己的消息");
    const ageSec = Math.floor(Date.now() / 1000) - Number(row.ts);
    if (ageSec > 300) throw new Error("超过 5 分钟，不能撤回");

    await tidbQuery(env,
      `UPDATE chat_messages SET type='recalled', text='消息已撤回', image_id=NULL WHERE id=?`,
      [id]
    );

    if (row.type === "image" && row.image_id) {
      try {
        await tidbQuery(env,
          `DELETE FROM chat_images WHERE id=?`,
          [String(row.image_id)]
        );
      } catch (e) {}
    }
    return jsonBody({ ok: 1 });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 400);
  }
}

async function handleOnline(env, url) {
  try {
    const room = url.searchParams.get("room") || OPT.defaultRoom;
    if (!validRoom(room)) return jsonBody({ ok: 0, msg: "房间名非法" }, 400);
    const n = await countOnline(env, room);
    return jsonBody({ ok: 1, n });
  } catch (err) {
    return jsonBody({ ok: 0, msg: err.message }, 500);
  }
}

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
    const cached = await caches.default.match("https://img-cache.invalid/" + id);
    if (cached) return cached;
    const img = await getImage(env, id);
    if (!img) return new Response("Not Found", { status: 404 });
    const headers = new Headers({
      "Content-Type": img.mime,
      "Cache-Control": `public, max-age=${OPT.imgCacheSec}, immutable`,
      "Access-Control-Allow-Origin": "*"
    });
    const resp = new Response(img.bytes, { status: 200, headers });
    try {
      const key = new Request("https://img-cache.invalid/" + id);
      caches.default.put(key, resp.clone()).catch(() => {});
    } catch {}
    return resp;
  } catch (err) {
    return new Response("Error", { status: 500 });
  }
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

// ────────────────────────────────────────────────────────────
//  Worker 入口（module 格式，沿用 c.js 的 if/else 链）
// ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const ip = request.headers.get("CF-Connecting-IP") || "0";

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }

    if (method === "GET" && (path === "/favicon.ico" || path === "/favicon.png")) {
      return await serveFavicon();
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      return await serveTheme("index.html");
    }
    if (method === "GET" && path.startsWith("/r/")) {
      return await serveTheme("index.html");
    }

    if (method === "GET" && path === "/rooms") {
      // 出于房间隐私考虑，不公开活跃房间列表
      return jsonBody({ ok: 1, rooms: [] });
    }

    if (method === "GET" && path === "/api/messages") {
      return await handleMessages(env, url);
    }
    if (method === "GET" && path === "/api/online") {
      return await handleOnline(env, url);
    }

    if (method === "POST" && path === "/api/send") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      return await handleSend(env, ip, body);
    }
    if (method === "POST" && path === "/api/heartbeat") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      return await handleHeartbeat(env, url, body);
    }
    if (method === "POST" && path === "/api/recall") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      return await handleRecall(env, ip, body);
    }
    if (method === "POST" && path === "/api/room/create") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      return await handleCreateRoom(env, body);
    }
    if (method === "POST" && path === "/api/upload") {
      return await handleUpload(request, env, ip);
    }

    if (method === "GET" && path.startsWith("/img/")) {
      const id = path.slice(5).replace(/[^A-Za-z0-9]/g, "");
      return await serveImage(env, id);
    }

    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
