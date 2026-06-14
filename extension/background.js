/**
 * KickIRL — Background Service Worker
 * 
 * Gerencia o estado de tracking e se comunica com o offscreen document
 * que mantém o GPS ativo.
 */

const OFFSCREEN_URL = 'offscreen.html';
let isTracking = false;

// ─── OFFSCREEN DOCUMENT ────────────────────────────────────────────────────
// O service worker não tem acesso a navigator.geolocation.
// Usamos um offscreen document para manter o GPS rodando.

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['GEOLOCATION'],
      justification: 'GPS tracking para streaming ao vivo',
    });
    // Give it a tiny delay to initialize
    await new Promise(r => setTimeout(r, 200));
  }
}

async function closeOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    await chrome.offscreen.closeDocument();
  }
}

// ─── MENSAGENS ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_TRACKING') {
    startTracking(msg.config).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'STOP_TRACKING') {
    stopTracking().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ isTracking });
    return;
  }

  // Mensagens do offscreen document (posição atualizada)
  if (msg.type === 'POSITION_UPDATE') {
    handlePosition(msg.position);
    return;
  }

  if (msg.type === 'GPS_ERROR') {
    console.error('[bg] GPS error:', msg.error);
    updateBadge('ERR', '#ef4444');
    return;
  }
});

// ─── TRACKING ──────────────────────────────────────────────────────────────

async function startTracking(config) {
  if (isTracking) return;
  isTracking = true;

  // Salva config no storage
  await chrome.storage.local.set({ trackingConfig: config, isTracking: true });

  // Cria offscreen document para GPS
  await ensureOffscreen();

  // Manda comando de start para o offscreen
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_START' });

  updateBadge('LIVE', '#53FC18');
  console.log('[bg] tracking started');
}

async function stopTracking() {
  isTracking = false;
  await chrome.storage.local.set({ isTracking: false });

  // Para o GPS e fecha o offscreen
  try {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  } catch {}
  
  setTimeout(closeOffscreen, 500);

  // Avisa o servidor
  const data = await chrome.storage.local.get(['trackingConfig']);
  if (data.trackingConfig) {
    const { serverUrl, pushKey } = data.trackingConfig;
    try {
      await fetch(`${serverUrl}/api/stop?key=${pushKey}`, { method: 'POST' });
    } catch {}
  }

  updateBadge('', '');
  console.log('[bg] tracking stopped');
}

// ─── ENVIO DE POSIÇÃO ──────────────────────────────────────────────────────

async function handlePosition(pos) {
  const data = await chrome.storage.local.get(['trackingConfig', 'pushCount']);
  if (!data.trackingConfig) return;

  const { serverUrl, pushKey } = data.trackingConfig;
  const count = (data.pushCount || 0) + 1;
  await chrome.storage.local.set({ pushCount: count, lastPosition: pos });

  try {
    const r = await fetch(`${serverUrl}/api/push?key=${pushKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: pos.lat,
        lon: pos.lon,
        accuracy: pos.accuracy,
        speed: pos.speed,
        heading: pos.heading,
      }),
    });
    const result = await r.json();

    if (result.status === 'safe_zone') {
      updateBadge('🛡️', '#f59e0b');
    } else {
      updateBadge('LIVE', '#53FC18');
    }

    await chrome.storage.local.set({ lastPush: Date.now(), pushError: null });
  } catch (err) {
    await chrome.storage.local.set({ pushError: err.message });
    updateBadge('ERR', '#ef4444');
  }
}

// ─── BADGE ─────────────────────────────────────────────────────────────────

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ─── KEEPALIVE ─────────────────────────────────────────────────────────────
// Alarms para manter o service worker ativo durante tracking

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    const data = await chrome.storage.local.get(['isTracking']);
    if (data.isTracking) {
      await ensureOffscreen();
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_START' });
    }
  }
});

// Ao iniciar, verifica se estava trackando
chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.local.get(['isTracking', 'trackingConfig']);
  if (data.isTracking && data.trackingConfig) {
    await startTracking(data.trackingConfig);
    chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  }
});

// Ao instalar
chrome.runtime.onInstalled.addListener(() => {
  updateBadge('', '');
});
