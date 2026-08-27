const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ================= persistence =================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let users = {}; // usernameLowercase -> { username, salt, passwordHash, createdAt }
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { users = {}; }
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) { console.error('saveUsers failed', e); }
}

let roomMeta = {}; // CODE -> { displayName, createdBy, admins: [usernames] }
try { roomMeta = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')); } catch (e) { roomMeta = {}; }
function saveRooms() {
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomMeta, null, 2)); } catch (e) { console.error('saveRooms failed', e); }
}

// token -> usernameLowercase (in-memory; cleared on restart, users just log in again)
const sessions = new Map();

function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

// ================= tiny HTTP JSON helpers =================
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// ================= HTTP server (static files + auth API) =================
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'POST' && urlPath === '/api/signup') {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3-20 letters, numbers, or underscores.' });
    if (password.length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
    const key = username.toLowerCase();
    if (users[key]) return sendJson(res, 400, { error: 'That username is already taken.' });

    const salt = makeSalt();
    const passwordHash = hashPassword(password, salt);
    users[key] = { username, salt, passwordHash, createdAt: Date.now() };
    saveUsers();

    const token = makeToken();
    sessions.set(token, key);
    return sendJson(res, 200, { token, username });
  }

  if (req.method === 'POST' && urlPath === '/api/login') {
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = username.toLowerCase();
    const user = users[key];
    if (!user || hashPassword(password, user.salt) !== user.passwordHash) {
      return sendJson(res, 400, { error: 'Wrong username or password.' });
    }
    const token = makeToken();
    sessions.set(token, key);
    return sendJson(res, 200, { token, username: user.username });
  }

  if (req.method === 'POST' && urlPath === '/api/logout') {
    const body = await readJsonBody(req);
    sessions.delete(String(body.token || ''));
    return sendJson(res, 200, { ok: true });
  }

  // static files
  let reqPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ================= websocket relay =================
const wss = new WebSocket.Server({ server });

// room code -> { clients: Map<ws, {username}>, history: Array<message> }
const rooms = new Map();
let msgCounter = 1;
const MAX_HISTORY = 300;
const MAX_ROOM_CODE_LEN = 40;
const MAX_ROOM_NAME_LEN = 40;
const MAX_MESSAGE_LEN = 2000;

// spam controls
const RATE_WINDOW_MS = 4000;
const RATE_LIMIT = 5;       // more than this many messages within the window = blocked
const SHORT_MUTE_MS = 8000;
const LONG_MUTE_MS = 30000;
const STRIKES_FOR_LONG_MUTE = 3;

// basic profanity filter — blocked outright, not censored
const BANNED_WORDS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'piss',
  'cunt', 'faggot', 'nigger', 'nigga', 'slut', 'whore', 'retard'
];
const BANNED_WORDS_RE = new RegExp('\\b(' + BANNED_WORDS.join('|') + ')\\b', 'i');
function containsProfanity(text) { return BANNED_WORDS_RE.test(text); }

// ================= InstaAI =================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const AI_SYSTEM_PROMPT = 'You are InstaAI, a friendly, concise built-in assistant inside the InstaChat app. Keep replies helpful and conversational, and not overly long unless the user asks for detail.';
const AI_HISTORY_LIMIT = 40; // messages (user+assistant combined) kept per connection

async function getAIReply(ws, text) {
  ws.aiHistory = ws.aiHistory || [];
  ws.aiHistory.push({ role: 'user', content: text });
  if (ws.aiHistory.length > AI_HISTORY_LIMIT) ws.aiHistory = ws.aiHistory.slice(-AI_HISTORY_LIMIT);

  if (!ANTHROPIC_API_KEY) {
    return { text: "InstaAI isn't set up yet — ask whoever runs this server to add an ANTHROPIC_API_KEY environment variable.", error: true };
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 1024,
        system: AI_SYSTEM_PROMPT,
        messages: ws.aiHistory
      })
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error('Anthropic API error', resp.status, errBody);
      return { text: 'InstaAI had trouble responding just now — try again in a moment.', error: true };
    }
    const data = await resp.json();
    const replyText = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim() || '…';
    ws.aiHistory.push({ role: 'assistant', content: replyText });
    if (ws.aiHistory.length > AI_HISTORY_LIMIT) ws.aiHistory = ws.aiHistory.slice(-AI_HISTORY_LIMIT);
    return { text: replyText, error: false };
  } catch (e) {
    console.error('InstaAI call failed', e);
    return { text: 'InstaAI had trouble responding just now — try again in a moment.', error: true };
  }
}

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { clients: new Map(), history: [] });
  return rooms.get(code);
}
function presenceCount(code) {
  const room = rooms.get(code);
  return room ? room.clients.size : 0;
}
function broadcast(code, payload, exceptWs) {
  const room = rooms.get(code);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const client of room.clients.keys()) {
    if (client === exceptWs) continue;
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}
function broadcastPresence(code) {
  broadcast(code, { type: 'presence', room: code, count: presenceCount(code) });
}
function leaveRoom(ws, code) {
  const room = rooms.get(code);
  if (!room) return;
  const info = room.clients.get(ws);
  room.clients.delete(ws);
  ws.rooms.delete(code);
  if (info) broadcast(code, { type: 'system', room: code, text: info.username + ' left the chat.', ts: Date.now() });
  broadcastPresence(code);
  if (room.clients.size === 0 && room.history.length === 0) rooms.delete(code);
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.rooms = new Set();
  ws.isAlive = true;
  ws.username = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // ---- auth must happen before anything else ----
    if (msg.type === 'auth') {
      const key = sessions.get(String(msg.token || ''));
      const user = key ? users[key] : null;
      if (!user) { ws.send(JSON.stringify({ type: 'authError' })); return; }
      ws.username = user.username;
      ws.send(JSON.stringify({ type: 'welcome', id: ws.id, username: ws.username }));
      return;
    }
    if (!ws.username) return; // everything below requires auth

    if (msg.type === 'aiReset') {
      ws.aiHistory = [];
      return;
    }

    if (msg.type === 'aiMessage') {
      const text = String(msg.text || '').slice(0, MAX_MESSAGE_LEN);
      if (!text.trim()) return;
      const result = await getAIReply(ws, text);
      ws.send(JSON.stringify({ type: 'aiReply', text: result.text, ts: Date.now(), error: !!result.error }));
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.room || '').trim().toUpperCase().slice(0, MAX_ROOM_CODE_LEN);
      if (!code) return;
      const room = getRoom(code);
      room.clients.set(ws, { username: ws.username });
      ws.rooms.add(code);

      if (!roomMeta[code]) {
        // creating a brand-new room — the creator is automatically this room's admin
        const displayName = String(msg.displayName || '').trim().slice(0, MAX_ROOM_NAME_LEN) || code;
        roomMeta[code] = { displayName, createdBy: ws.username, admins: [ws.username] };
        saveRooms();
      } else if (!roomMeta[code].admins) {
        roomMeta[code].admins = [roomMeta[code].createdBy]; // backfill for rooms made before this feature
        saveRooms();
      }

      ws.send(JSON.stringify({ type: 'history', room: code, messages: room.history, roomInfo: roomMeta[code] }));
      broadcast(code, { type: 'system', room: code, text: ws.username + ' joined the chat.', ts: Date.now() }, ws);
      broadcastPresence(code);
      return;
    }

    if (msg.type === 'leave') {
      leaveRoom(ws, String(msg.room || '').trim().toUpperCase());
      return;
    }

    if (msg.type === 'rename') {
      const code = String(msg.room || '').trim().toUpperCase();
      const meta = roomMeta[code];
      if (!meta) return;
      const allowed = meta.admins && meta.admins.includes(ws.username);
      if (!allowed) { ws.send(JSON.stringify({ type: 'error', message: 'Only an admin of this chat can rename it.' })); return; }
      const newName = String(msg.name || '').trim().slice(0, MAX_ROOM_NAME_LEN);
      if (!newName) return;
      meta.displayName = newName;
      saveRooms();
      broadcast(code, { type: 'roomInfo', room: code, roomInfo: meta });
      return;
    }

    if (msg.type === 'roomMembers') {
      const code = String(msg.room || '').trim().toUpperCase();
      const room = rooms.get(code);
      const meta = roomMeta[code];
      if (!room || !meta) return;
      const seen = new Set();
      const members = [];
      for (const info of room.clients.values()) {
        if (seen.has(info.username)) continue;
        seen.add(info.username);
        members.push({ username: info.username, isAdmin: meta.admins.includes(info.username) });
      }
      ws.send(JSON.stringify({ type: 'roomMembers', room: code, members }));
      return;
    }

    if (msg.type === 'promoteInRoom') {
      const code = String(msg.room || '').trim().toUpperCase();
      const meta = roomMeta[code];
      if (!meta) return;
      const isRoomAdmin = meta.admins && meta.admins.includes(ws.username);
      if (!isRoomAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'Only an admin of this chat can promote others.' })); return; }
      const key = String(msg.username || '').trim().toLowerCase();
      const target = users[key];
      if (!target) return;
      if (!meta.admins.includes(target.username)) meta.admins.push(target.username);
      saveRooms();
      broadcast(code, { type: 'roomInfo', room: code, roomInfo: meta });
      return;
    }

    if (msg.type === 'deleteMessage') {
      const code = String(msg.room || '').trim().toUpperCase();
      const meta = roomMeta[code];
      const room = rooms.get(code);
      if (!room || !meta) return;
      const isRoomAdmin = meta.admins && meta.admins.includes(ws.username);
      if (!isRoomAdmin) return;
      const idx = room.history.findIndex(m => m.id === msg.id);
      if (idx !== -1) room.history.splice(idx, 1);
      broadcast(code, { type: 'messageDeleted', room: code, id: msg.id });
      return;
    }

    if (msg.type === 'message') {
      const code = String(msg.room || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room || !room.clients.has(ws)) return;
      const text = String(msg.text || '').slice(0, MAX_MESSAGE_LEN);
      if (!text.trim()) return;

      const now = Date.now();

      // profanity check — blocked outright, no strike/mute (avoids punishing accidental slips)
      if (containsProfanity(text)) {
        ws.send(JSON.stringify({ type: 'blocked', room: code, reason: 'profanity' }));
        return;
      }

      // muted from a previous spam strike?
      if (ws.mutedUntil && now < ws.mutedUntil) {
        ws.send(JSON.stringify({ type: 'blocked', room: code, reason: 'muted', until: ws.mutedUntil }));
        return;
      }

      // rate check: too many messages in a short window
      ws.msgTimestamps = (ws.msgTimestamps || []).filter(t => now - t < RATE_WINDOW_MS);
      ws.msgTimestamps.push(now);

      // duplicate check: same text sent 3 times in a row
      ws.recentTexts = ws.recentTexts || [];
      const isDuplicateSpam = ws.recentTexts.length >= 2 &&
        ws.recentTexts[ws.recentTexts.length - 1] === text &&
        ws.recentTexts[ws.recentTexts.length - 2] === text;
      const isRateSpam = ws.msgTimestamps.length > RATE_LIMIT;

      if (isRateSpam || isDuplicateSpam) {
        ws.spamStrikes = (ws.spamStrikes || 0) + 1;
        const muteMs = ws.spamStrikes >= STRIKES_FOR_LONG_MUTE ? LONG_MUTE_MS : SHORT_MUTE_MS;
        ws.mutedUntil = now + muteMs;
        ws.send(JSON.stringify({ type: 'blocked', room: code, reason: isDuplicateSpam ? 'duplicate' : 'rate', until: ws.mutedUntil }));
        return;
      }

      ws.recentTexts.push(text);
      if (ws.recentTexts.length > 5) ws.recentTexts.shift();

      const entry = { id: msgCounter++, from: ws.id, name: ws.username, text, ts: now };
      room.history.push(entry);
      if (room.history.length > MAX_HISTORY) room.history.shift();
      broadcast(code, Object.assign({ type: 'message', room: code }, entry));
      return;
    }
  });

  ws.on('close', () => {
    for (const code of Array.from(ws.rooms)) leaveRoom(ws, code);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log('InstaChat server listening on port ' + PORT);
});
