/**
 * KickIRL - Backend Server
 * 
 * Fluxo:
 *   1. Streamer registra via extensão Chrome → POST /api/register → recebe pushKey
 *   2. Extensão envia GPS via POST /api/push?key=<pushKey>
 *   3. Viewers conectam via WebSocket ws://host/live/all (recebem updates de TODOS os streamers)
 *   4. Overlay OBS faz GET /api/pull?key=<pullKey> (polling a cada 5s)
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── PERSISTÊNCIA EM ARQUIVO JSON ──────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'streamers.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      for (const s of data) {
        s.viewers = new Set();
        s.isLive = false; // começa offline após reinício
        streamers.set(s.username, s);
        pushKeys.set(s.pushKey, s.username);
        pullKeys.set(s.pullKey, s.username);
      }
      console.log(`[data] carregados ${data.length} streamers do disco`);
    }
  } catch (err) {
    console.error('[data] erro ao carregar:', err.message);
  }
}

function saveData() {
  ensureDataDir();
  try {
    const data = [...streamers.values()].map(s => ({
      username: s.username,
      displayName: s.displayName,
      category: s.category,
      pushKey: s.pushKey,
      pullKey: s.pullKey,
      safeZones: s.safeZones,
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[data] erro ao salvar:', err.message);
  }
}

// Salva a cada 30s e ao desligar
let saveTimeout = null;
function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveData, 5000);
}
process.on('SIGINT', () => { saveData(); process.exit(); });
process.on('SIGTERM', () => { saveData(); process.exit(); });

// ─── STORAGE ───────────────────────────────────────────────────────────────

const streamers = new Map();
const pushKeys = new Map();
const pullKeys = new Map();

// Set de viewers globais (WebSocket /live/all)
const globalViewers = new Set();

// ─── RATE LIMITING ─────────────────────────────────────────────────────────

const rateLimits = new Map(); // pushKey → { count, resetAt }
const RATE_LIMIT = 120; // max pushes per minute
const RATE_WINDOW = 60000;

function checkRateLimit(key) {
  const now = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimits.set(key, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function generateKey() {
  return uuidv4().replace(/-/g, '');
}

function getOrCreate(username) {
  const key = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!key || key.length < 2 || key.length > 30) return null;

  if (!streamers.has(key)) {
    const pushKey = generateKey();
    const pullKey = generateKey();
    const data = {
      username: key,
      displayName: username,
      category: 'IRL Streaming',
      pushKey,
      pullKey,
      location: null,
      safeZones: [],
      isLive: false,
      viewers: new Set(),
      trail: [],
    };
    streamers.set(key, data);
    pushKeys.set(pushKey, key);
    pullKeys.set(pullKey, key);
    console.log(`[register] novo streamer: ${key}`);
    debouncedSave();
  }
  return streamers.get(key);
}

function broadcastToStreamerViewers(streamer, payload) {
  const msg = JSON.stringify(payload);
  for (const ws of streamer.viewers) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastToGlobalViewers(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of globalViewers) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function inSafeZone(streamer, lat, lon) {
  for (const zone of streamer.safeZones) {
    const d = haversine(lat, lon, zone.lat, zone.lon);
    if (d <= zone.radius) return true;
  }
  return false;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function publicLocation(streamer) {
  if (!streamer.location) return null;
  const { lat, lon, accuracy, speed, heading, updatedAt } = streamer.location;
  return { lat, lon, accuracy, speed, heading, updatedAt };
}

function publicStreamer(s) {
  return {
    username: s.username,
    displayName: s.displayName,
    category: s.category,
    isLive: s.isLive,
    location: publicLocation(s),
    trail: s.trail.slice(-100),
    viewerCount: s.viewers.size,
  };
}

// ─── REST API ──────────────────────────────────────────────────────────────

// POST /api/register
app.post('/api/register', (req, res) => {
  const { username, displayName, category } = req.body;
  if (!username) return res.status(400).json({ error: 'username obrigatório' });

  const streamer = getOrCreate(username);
  if (!streamer) return res.status(400).json({ error: 'username inválido (2-30 chars, a-z, 0-9, _, -)' });
  if (displayName) streamer.displayName = displayName;
  if (category) streamer.category = category;
  debouncedSave();

  res.json({
    username: streamer.username,
    pushKey: streamer.pushKey,
    pullKey: streamer.pullKey,
    pullUrl: `/api/pull?key=${streamer.pullKey}`,
    wsUrl: `/live/${streamer.username}`,
  });
});

// POST /api/push?key=<pushKey>
app.post('/api/push', (req, res) => {
  const pushKey = req.query.key;
  if (!pushKey || !pushKeys.has(pushKey)) {
    return res.status(401).json({ error: 'pushKey inválida' });
  }

  if (!checkRateLimit(pushKey)) {
    return res.status(429).json({ error: 'rate limit excedido (max 120/min)' });
  }

  const username = pushKeys.get(pushKey);
  const streamer = streamers.get(username);
  const { lat, lon, accuracy, speed, heading } = req.body;

  if (lat == null || lon == null) {
    return res.status(400).json({ error: 'lat e lon obrigatórios' });
  }

  const parsedLat = parseFloat(lat);
  const parsedLon = parseFloat(lon);
  if (isNaN(parsedLat) || isNaN(parsedLon) || parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) {
    return res.status(400).json({ error: 'coordenadas inválidas' });
  }

  // Safe zone
  if (inSafeZone(streamer, parsedLat, parsedLon)) {
    streamer.isLive = true;
    if (streamer.location) streamer.location.updatedAt = Date.now();
    else streamer.location = { lat: 0, lon: 0, accuracy: 0, speed: 0, heading: 0, updatedAt: Date.now() };
    const safePayload = { type: 'safe_zone', username };
    broadcastToStreamerViewers(streamer, safePayload);
    broadcastToGlobalViewers(safePayload);
    return res.json({ status: 'safe_zone' });
  }



  const location = {
    lat: parsedLat,
    lon: parsedLon,
    accuracy: accuracy ? parseFloat(accuracy) : null,
    speed: speed ? parseFloat(speed) : null,
    heading: heading ? parseFloat(heading) : null,
    updatedAt: Date.now(),
  };

  const wasOffline = !streamer.isLive;
  streamer.location = location;
  streamer.isLive = true;

  // Trail: max 500 pontos
  streamer.trail.push({ lat: location.lat, lon: location.lon, ts: location.updatedAt });
  if (streamer.trail.length > 500) streamer.trail.shift();

  // Broadcast
  const payload = {
    type: 'location',
    username,
    displayName: streamer.displayName,
    category: streamer.category,
    ...location,
    viewerCount: streamer.viewers.size,
  };

  broadcastToStreamerViewers(streamer, payload);
  broadcastToGlobalViewers(payload);

  // Se acabou de ficar online, broadcast de "online" para global
  if (wasOffline) {
    broadcastToGlobalViewers({
      type: 'streamer_online',
      ...publicStreamer(streamer),
    });
  }

  res.json({ status: 'ok', viewerCount: streamer.viewers.size + globalViewers.size });
});

// POST /api/stop?key=<pushKey>
app.post('/api/stop', (req, res) => {
  const pushKey = req.query.key;
  if (!pushKey || !pushKeys.has(pushKey)) {
    return res.status(401).json({ error: 'pushKey inválida' });
  }

  const username = pushKeys.get(pushKey);
  const streamer = streamers.get(username);
  
  streamer.isLive = false;
  streamer.location = null;
  streamer.trail = []; // Optional: clear trail when offline

  const payload = { type: 'offline', username };
  broadcastToStreamerViewers(streamer, payload);
  broadcastToGlobalViewers(payload);
  debouncedSave();

  console.log(`[api] ${username} encerrou a transmissão de GPS.`);
  res.json({ status: 'offline' });
});

// GET /api/pull?key=<pullKey>
app.get('/api/pull', (req, res) => {
  const pullKey = req.query.key;
  if (!pullKey || !pullKeys.has(pullKey)) {
    return res.status(401).json({ error: 'pullKey inválida' });
  }
  const username = pullKeys.get(pullKey);
  const streamer = streamers.get(username);
  res.json({
    username,
    isLive: streamer.isLive,
    location: publicLocation(streamer),
    trail: streamer.trail.slice(-100),
    viewerCount: streamer.viewers.size,
  });
});

// GET /api/streamer/:username
app.get('/api/streamer/:username', (req, res) => {
  const key = req.params.username.toLowerCase();
  const streamer = streamers.get(key);
  if (!streamer) return res.status(404).json({ error: 'streamer não encontrado' });
  res.json(publicStreamer(streamer));
});

// GET /api/live
app.get('/api/live', (req, res) => {
  const live = [];
  for (const [, s] of streamers) {
    if (s.isLive) live.push(publicStreamer(s));
  }
  res.json(live);
});

// POST /api/safezone?key=<pushKey>
app.post('/api/safezone', (req, res) => {
  const pushKey = req.query.key;
  if (!pushKey || !pushKeys.has(pushKey)) {
    return res.status(401).json({ error: 'pushKey inválida' });
  }
  const username = pushKeys.get(pushKey);
  const streamer = streamers.get(username);
  const { lat, lon, radius = 200 } = req.body;
  if (lat == null || lon == null) return res.status(400).json({ error: 'lat e lon obrigatórios' });
  streamer.safeZones.push({ lat: parseFloat(lat), lon: parseFloat(lon), radius: parseFloat(radius) });
  debouncedSave();
  res.json({ status: 'ok', safeZones: streamer.safeZones });
});

// POST /api/stop?key=<pushKey>
app.post('/api/stop', (req, res) => {
  const pushKey = req.query.key;
  if (!pushKey || !pushKeys.has(pushKey)) return res.status(401).json({ error: 'pushKey inválida' });
  const username = pushKeys.get(pushKey);
  const streamer = streamers.get(username);
  streamer.isLive = false;
  const payload = { type: 'offline', username };
  broadcastToStreamerViewers(streamer, payload);
  broadcastToGlobalViewers(payload);
  console.log(`[stop] ${username} offline`);
  res.json({ status: 'ok' });
});

// GET /obs
app.get('/obs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'obs.html'));
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ─── HTTP + WEBSOCKET ──────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === '/live/all' || pathname.startsWith('/live/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, pathname);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req, pathname) => {
  if (pathname === '/live/all') {
    // Global viewer — receives all streamer updates
    globalViewers.add(ws);
    console.log(`[ws] global viewer conectou (total: ${globalViewers.size})`);

    // Send current state of all live streamers
    const liveList = [];
    for (const [, s] of streamers) {
      if (s.isLive) liveList.push(publicStreamer(s));
    }
    ws.send(JSON.stringify({ type: 'init', streamers: liveList }));

    ws.on('close', () => {
      globalViewers.delete(ws);
      console.log(`[ws] global viewer desconectou (total: ${globalViewers.size})`);
    });
    ws.on('error', () => globalViewers.delete(ws));
    return;
  }

  // Per-streamer viewer: /live/<username>
  const username = pathname.replace('/live/', '').toLowerCase();
  if (!streamers.has(username)) getOrCreate(username);
  const streamer = streamers.get(username);
  if (!streamer) { ws.close(); return; }
  
  streamer.viewers.add(ws);
  console.log(`[ws] viewer conectou em ${username} (total: ${streamer.viewers.size})`);

  ws.send(JSON.stringify({
    type: 'init',
    ...publicStreamer(streamer),
  }));

  broadcastToStreamerViewers(streamer, { type: 'viewer_count', viewerCount: streamer.viewers.size });

  ws.on('close', () => {
    streamer.viewers.delete(ws);
    broadcastToStreamerViewers(streamer, { type: 'viewer_count', viewerCount: streamer.viewers.size });
  });
  ws.on('error', () => streamer.viewers.delete(ws));
});

// ─── CLEANUP ───────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [, s] of streamers) {
    if (s.isLive && s.location && (now - s.location.updatedAt) > 60000) {
      s.isLive = false;
      const payload = { type: 'offline', username: s.username };
      broadcastToStreamerViewers(s, payload);
      broadcastToGlobalViewers(payload);
      console.log(`[cleanup] ${s.username} marcado offline (sem push há 60s)`);
    }
  }
}, 10000);

// ─── LOAD DATA & START ─────────────────────────────────────────────────────
loadData();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟢 KickIRL Server rodando em http://localhost:${PORT}\n`);
  console.log('Endpoints:');
  console.log(`  POST /api/register        → registrar streamer`);
  console.log(`  POST /api/push?key=...    → enviar localização`);
  console.log(`  GET  /api/pull?key=...    → polling (OBS overlay)`);
  console.log(`  GET  /api/live            → streamers ao vivo`);
  console.log(`  GET  /api/streamer/:user  → info de um streamer`);
  console.log(`  GET  /obs?key=...         → overlay OBS`);
  console.log(`  WS   /live/all            → viewer global (todos os streamers)`);
  console.log(`  WS   /live/:username      → viewer individual\n`);
});
