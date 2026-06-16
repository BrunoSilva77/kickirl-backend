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
const https = require('https');

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
    let data = [];
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      data = JSON.parse(raw);
    }
    
    // Seed padrão para o Render (ephemeral disk fallback)
    if (data.length === 0) {
      data = [
        {
          username: 'gabepeixe',
          displayName: 'gabepeixe',
          category: 'IRL Streaming',
          rtirlKey: 'te0k0n9vf1f3tqeu',
          pushKey: '4aaab0eb2d7f473e9f49a40b0e9da3d5',
          pullKey: '515456063e7b40f5be9178008eb484d4'
        },
        {
          username: 'loud_coringa',
          displayName: 'loud_coringa',
          category: 'IRL Streaming',
          pushKey: '0478056b5f08430a8005afd290dffaba',
          pullKey: 'b9a1d524b273431bae8042d788a9376d'
        },
        {
          username: 'loud_caiox',
          displayName: 'loud_caiox',
          category: 'IRL Streaming',
          pushKey: '172e58fc96ef43eb8a7b897422a508f9',
          pullKey: 'd6f56d7ac73b4c2b83522e111eb29467'
        },
        {
          username: 'brabox',
          displayName: 'brabox',
          category: 'IRL Streaming',
          pushKey: '7bc3827ec31843b0ab12f172e58fc96e',
          pullKey: 'e7b484d4515456063e7b40f5be917800'
        }
      ];
    }

    for (const s of data) {
      s.viewers = new Set();
      s.isLive = false; // começa offline após reinício
      s.trail = s.trail || [];
      s.platform = s.platform || 'kick';
      s.channelId = s.channelId || s.username;
      s.offlineAt = s.location ? s.location.updatedAt : null;
      streamers.set(s.username, s);
      pushKeys.set(s.pushKey, s.username);
      pullKeys.set(s.pullKey, s.username);
    }
    console.log(`[data] carregados ${streamers.size} streamers.`);
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
      rtirlKey: s.rtirlKey,
      platform: s.platform || 'kick',
      channelId: s.channelId || s.username,
      trail: s.trail || [],
      location: s.location || null,
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
      platform: 'kick',
      channelId: key,
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

function snapToRoads(lat, lon) {
  return new Promise((resolve) => {
    const url = `http://router.project-osrm.org/nearest/v1/driving/${lon},${lat}?number=1`;
    const client = url.startsWith('https') ? https : http;
    
    const req = client.get(url, { headers: { 'User-Agent': 'KickIRL-Server-App' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ lat, lon });
      }
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          if (parsed.code === 'Ok' && parsed.waypoints && parsed.waypoints[0]) {
            const [snappedLon, snappedLat] = parsed.waypoints[0].location;
            resolve({
              lat: parseFloat(snappedLat),
              lon: parseFloat(snappedLon)
            });
          } else {
            resolve({ lat, lon });
          }
        } catch (e) {
          resolve({ lat, lon });
        }
      });
    });

    req.on('error', () => {
      resolve({ lat, lon });
    });
    
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ lat, lon });
    });
  });
}

function getOSRMRoute(lat1, lon1, lat2, lon2) {
  return new Promise((resolve) => {
    const dist = haversine(lat1, lon1, lat2, lon2);
    if (dist < 5 || dist > 20000) { // menos de 5m ou mais de 20km
      return resolve([]);
    }

    const url = `http://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`;
    const client = url.startsWith('https') ? https : http;
    
    const req = client.get(url, { headers: { 'User-Agent': 'KickIRL-Server-App' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve([]);
      }
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          if (parsed.code === 'Ok' && parsed.routes && parsed.routes[0] && parsed.routes[0].geometry) {
            const coords = parsed.routes[0].geometry.coordinates.map(pt => ({
              lat: parseFloat(pt[1]),
              lon: parseFloat(pt[0])
            }));
            resolve(coords);
          } else {
            resolve([]);
          }
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => {
      resolve([]);
    });
    
    req.setTimeout(2000, () => {
      req.destroy();
      resolve([]);
    });
  });
}

async function processLocationUpdate(s, rawLat, rawLon, accuracy, speed, heading, updatedAt) {
  const parsedLat = parseFloat(rawLat);
  const parsedLon = parseFloat(rawLon);
  const parsedSpeed = speed != null ? parseFloat(speed) : null;
  const parsedAccuracy = accuracy != null ? parseFloat(accuracy) : null;
  const parsedHeading = heading != null ? parseFloat(heading) : null;
  const ts = updatedAt || Date.now();

  // Limpeza de trajeto inteligente (se estiver sem atualizar há mais de 6 horas)
  if (s.location && s.location.updatedAt && (ts - s.location.updatedAt > 6 * 3600 * 1000)) {
    s.trail = [];
  }

  // Safe zone
  if (inSafeZone(s, parsedLat, parsedLon)) {
    s.isLive = true;
    if (s.location) {
      s.location.updatedAt = ts;
    } else {
      s.location = {
        lat: 0,
        lon: 0,
        rawLat: parsedLat,
        rawLon: parsedLon,
        accuracy: 0,
        speed: 0,
        heading: 0,
        updatedAt: ts
      };
    }
    const safePayload = { type: 'safe_zone', username: s.username };
    broadcastToStreamerViewers(s, safePayload);
    broadcastToGlobalViewers(safePayload);
    return { status: 'safe_zone', isStationary: false };
  }

  let snapped = { lat: parsedLat, lon: parsedLon };
  let isStationary = false;

  if (s.location) {
    const prevRawLat = s.location.rawLat || s.location.lat;
    const prevRawLon = s.location.rawLon || s.location.lon;
    const dist = haversine(parsedLat, parsedLon, prevRawLat, prevRawLon);

    // Se a distância percorrida for menor que 12 metros E a velocidade for muito baixa (< 0.5 m/s ou nula)
    if (dist < 12 && (parsedSpeed === null || parsedSpeed < 0.5)) {
      isStationary = true;
      snapped = { lat: s.location.lat, lon: s.location.lon };
    }
  }

  if (!isStationary) {
    snapped = await snapToRoads(parsedLat, parsedLon);
  }

  const location = {
    lat: snapped.lat,
    lon: snapped.lon,
    rawLat: parsedLat,
    rawLon: parsedLon,
    accuracy: parsedAccuracy,
    speed: parsedSpeed,
    heading: parsedHeading,
    updatedAt: ts,
  };

  const prevLocation = s.location;
  const wasOffline = !s.isLive;
  s.location = location;
  s.isLive = true;
  s.offlineAt = null; // reset offline timer

  if (!isStationary) {
    if (!s.trail) s.trail = [];
    if (prevLocation && prevLocation.lat !== 0 && prevLocation.lon !== 0) {
      const routeCoords = await getOSRMRoute(prevLocation.lat, prevLocation.lon, snapped.lat, snapped.lon);
      if (routeCoords && routeCoords.length > 0) {
        for (const pt of routeCoords) {
          s.trail.push({ lat: pt.lat, lon: pt.lon, ts: location.updatedAt });
        }
      } else {
        s.trail.push({ lat: location.lat, lon: location.lon, ts: location.updatedAt });
      }
    } else {
      s.trail.push({ lat: location.lat, lon: location.lon, ts: location.updatedAt });
    }
    if (s.trail.length > 1000) s.trail = s.trail.slice(-1000);
  }

  debouncedSave();

  const payload = {
    type: 'location',
    username: s.username,
    displayName: s.displayName,
    category: s.category,
    ...location,
    trail: s.trail.slice(-500),
    viewerCount: s.viewers.size,
  };

  broadcastToStreamerViewers(s, payload);
  broadcastToGlobalViewers(payload);

  if (wasOffline) {
    broadcastToGlobalViewers({
      type: 'streamer_online',
      ...publicStreamer(s),
    });
    console.log(`[location] ${s.username} online.`);
  }

  return { status: 'ok', isStationary };
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
    trail: s.trail.slice(-500),
    viewerCount: s.viewers.size,
    platform: s.platform || 'kick',
    channelId: s.channelId || s.username,
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
app.post('/api/push', async (req, res) => {
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

  const result = await processLocationUpdate(streamer, parsedLat, parsedLon, accuracy, speed, heading, Date.now());
  res.json({ status: result.status, viewerCount: streamer.viewers.size + globalViewers.size });
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
  streamer.offlineAt = Date.now();
  // Mantemos a última localização e o trail para visualização mesmo offline

  const payload = { type: 'offline', username };
  broadcastToStreamerViewers(streamer, payload);
  broadcastToGlobalViewers(payload);
  debouncedSave();

  console.log(`[api] ${username} encerrou a transmissão de GPS.`);
  res.json({ status: 'offline' });
});

// POST /api/get-apk
app.post('/api/get-apk', (req, res) => {
  const { password } = req.body;
  // A senha DEVE ser configurada no painel do Render nas Variáveis de Ambiente
  const masterPassword = process.env.STREAMER_PASSWORD;

  if (masterPassword && password === masterPassword) {
    res.json({ url: 'https://expo.dev/artifacts/eas/-dukEXDoBcZJD94hzlJN-xAIaASm_GEVoAOV4xrFheE.apk' });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
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
    trail: streamer.trail.slice(-500),
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
  const list = [];
  for (const [, s] of streamers) {
    if (s.location) list.push(publicStreamer(s));
  }
  res.json(list);
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

    // Send current state of all streamers that have a location
    const list = [];
    for (const [, s] of streamers) {
      if (s.location) list.push(publicStreamer(s));
    }
    ws.send(JSON.stringify({ type: 'init', streamers: list }));

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
// ─── KICK LIVE CHECK ───────────────────────────────────────────────────────

function checkKickLive(username) {
  return new Promise((resolve) => {
    const url = `https://kick.com/api/v2/channels/${username}`;
    https.get(url, { headers: { 'User-Agent': 'KickIRL-Server-App' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null); // Não conseguiu verificar, retorna null (inconclusivo)
      }
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          resolve(parsed.livestream != null); // true se estiver ao vivo
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => {
      resolve(null);
    });
  });
}

// ─── RTIRL POLLING ─────────────────────────────────────────────────────────

function getRTIRLLocation(rtirlKey) {
  return new Promise((resolve, reject) => {
    const url = `https://rtirl.com/api/pull?key=${rtirlKey}`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Status: ${res.statusCode}`));
      }
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(rawData);
          resolve(parsedData);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (e) => {
      reject(e);
    });
  });
}

const RTIRL_INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutos (antes era 10min)

setInterval(async () => {
  for (const [, s] of streamers) {
    if (s.rtirlKey) {
      try {
        const data = await getRTIRLLocation(s.rtirlKey);
        if (data && data.location && data.location.latitude != null && data.location.longitude != null) {
          const parsedLat = parseFloat(data.location.latitude);
          const parsedLon = parseFloat(data.location.longitude);
          const updatedAt = data.updatedAt || Date.now();

          // 1. Verificar inatividade genuína antiga
          const now = Date.now();
          const absAge = Math.abs(now - updatedAt);
          
          if (absAge > RTIRL_INACTIVITY_TIMEOUT) {
            if (s.isLive) {
              // Antes de marcar offline, verificar se a live do Kick está realmente off
              const kickLive = await checkKickLive(s.channelId || s.username);
              if (kickLive === true) {
                // A live está on! GPS parou mas a live continua. Manter como online.
                console.log(`[rtirl] ${s.username} GPS parado há ${Math.round(absAge/1000)}s, mas live Kick está ON. Mantendo online.`);
                continue;
              }
              
              s.isLive = false;
              s.offlineAt = now;
              const payload = { type: 'offline', username: s.username };
              broadcastToStreamerViewers(s, payload);
              broadcastToGlobalViewers(payload);
              console.log(`[rtirl] ${s.username} marcado offline (dados da api com ${Math.round(absAge/1000)}s de atraso)`);
            }
            continue;
          }

          // 2. Inicializar ou atualizar timestamps locais de controle
          if (s.lastRtirlUpdate !== updatedAt) {
            s.lastRtirlUpdate = updatedAt;
            s.lastRtirlUpdateAt = now;
          }

          // 3. Verificar inatividade local (se o timestamp do RTIRL não muda)
          const localInactiveAge = now - (s.lastRtirlUpdateAt || now);
          if (localInactiveAge > RTIRL_INACTIVITY_TIMEOUT) {
            if (s.isLive) {
              // Verificar Kick antes de marcar offline
              const kickLive = await checkKickLive(s.channelId || s.username);
              if (kickLive === true) {
                console.log(`[rtirl] ${s.username} GPS sem atualizar há ${Math.round(localInactiveAge/1000)}s, mas live Kick está ON.`);
                continue;
              }
              
              s.isLive = false;
              s.offlineAt = now;
              const payload = { type: 'offline', username: s.username };
              broadcastToStreamerViewers(s, payload);
              broadcastToGlobalViewers(payload);
              console.log(`[rtirl] ${s.username} marcado offline por inatividade local de ${Math.round(localInactiveAge/60000)}min`);
            }
            continue;
          }

          // Se for a mesma timestamp que já processamos e já estamos online, evitamos re-broadcast desnecessário
          if (s.location && s.location.updatedAt === updatedAt && s.isLive) {
            continue;
          }

          await processLocationUpdate(
            s,
            parsedLat,
            parsedLon,
            data.accuracy,
            data.speed,
            data.heading,
            updatedAt
          );
        }
      } catch (err) {
        console.error(`[rtirl] erro ao consultar ${s.username}:`, err.message);
      }
    }
  }
}, 3000);

// ─── CLEANUP ───────────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [, s] of streamers) {
    if (s.isLive) {
      if (s.rtirlKey) {
        // Para streamers RTIRL, usamos o controle de inatividade local
        const localInactiveAge = now - (s.lastRtirlUpdateAt || now);
        if (localInactiveAge > RTIRL_INACTIVITY_TIMEOUT) {
          // Verificar Kick antes de marcar offline
          const kickLive = await checkKickLive(s.channelId || s.username);
          if (kickLive === true) {
            // Live ainda está on, manter online
            continue;
          }
          s.isLive = false;
          s.offlineAt = now;
          const payload = { type: 'offline', username: s.username };
          broadcastToStreamerViewers(s, payload);
          broadcastToGlobalViewers(payload);
          console.log(`[cleanup-rtirl] ${s.username} marcado offline (sem atualizações há ${Math.round(localInactiveAge/60000)}min)`);
        }
      } else if (s.location && (now - s.location.updatedAt) > RTIRL_INACTIVITY_TIMEOUT) {
        // Para streamers de push manual, a timestamp é local
        s.isLive = false;
        s.offlineAt = now;
        const payload = { type: 'offline', username: s.username };
        broadcastToStreamerViewers(s, payload);
        broadcastToGlobalViewers(payload);
        console.log(`[cleanup-push] ${s.username} marcado offline (sem push há ${Math.round((now - s.location.updatedAt)/60000)}min)`);
      }
    } else {
      // Se estiver offline por mais de 5 minutos, remove a localização e o marcador do mapa
      if (s.location && s.offlineAt && (now - s.offlineAt) > 5 * 60 * 1000) {
        s.location = null;
        s.trail = [];
        s.offlineAt = null;
        broadcastToGlobalViewers({ type: 'remove', username: s.username });
        debouncedSave();
        console.log(`[cleanup-remove] ${s.username} removido do mapa por estar offline há mais de 5min`);
      }
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
