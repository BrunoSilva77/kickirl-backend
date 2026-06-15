/**
 * KickIRL — Popup Logic
 */

const $ = id => document.getElementById(id);

let config = null;
const SERVER_URL = 'https://kickirl-backend.onrender.com';

// ─── INIT ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved config
  const data = await chrome.storage.local.get(['serverUrl', 'username', 'displayName', 'category', 'pushKey', 'pullKey', 'isTracking', 'pushCount', 'lastPosition']);

  if (data.pushKey) {
    // Already registered — show tracking view
    config = {
      serverUrl: data.serverUrl,
      username: data.username,
      displayName: data.displayName,
      category: data.category,
      pushKey: data.pushKey,
      pullKey: data.pullKey,
    };
    showTrackingView(data);
  } else {
    if (data.username) $('f-user').value = data.username;
    if (data.username) $('f-user').value = data.username;
  }

  // Periodic update
  setInterval(updateLiveData, 2000);
});

// ─── REGISTER ──────────────────────────────────────────────────────────────

$('btn-register').addEventListener('click', async () => {
  const serverUrl = SERVER_URL;
  const username = $('f-user').value.trim();
  const displayName = $('f-display').value.trim() || username;
  const category = $('f-cat').value.trim() || 'IRL Streaming';

  if (!username) { $('setup-status').textContent = '⚠️ Username é obrigatório'; return; }

  $('btn-register').textContent = 'Conectando…';
  $('btn-register').disabled = true;

  try {
    const r = await fetch(`${serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName, category }),
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    config = {
      serverUrl,
      username: d.username,
      displayName,
      category,
      pushKey: d.pushKey,
      pullKey: d.pullKey,
    };

    await chrome.storage.local.set({
      serverUrl,
      username: d.username,
      displayName,
      category,
      pushKey: d.pushKey,
      pullKey: d.pullKey,
      pushCount: 0,
    });

    showTrackingView({ pushCount: 0 });
  } catch (err) {
    $('setup-status').textContent = `❌ Erro: ${err.message}`;
    $('btn-register').textContent = '✅ Registrar e Conectar';
    $('btn-register').disabled = false;
  }
});

// ─── TRACKING VIEW ─────────────────────────────────────────────────────────

function showTrackingView(data) {
  $('view-setup').style.display = 'none';
  $('view-track').style.display = 'flex';

  const initials = (config.displayName || config.username).slice(0, 2).toUpperCase();
  $('t-avatar').textContent = initials;
  $('t-username').textContent = `@${config.username}`;
  $('t-category').textContent = config.category;

  // Check current tracking status
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response && response.isTracking) {
      setTrackingUI(true);
    }
  });

  updateLiveData();
}

// ─── TRACK BUTTON ──────────────────────────────────────────────────────────

$('btn-track').addEventListener('click', async () => {
  const btn = $('btn-track');

  // Check current status
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, async (response) => {
    if (response && response.isTracking) {
      // Stop
      chrome.runtime.sendMessage({ type: 'STOP_TRACKING' }, () => {
        setTrackingUI(false);
      });
    } else {
      // Start
      chrome.runtime.sendMessage({
        type: 'START_TRACKING',
        config: {
          serverUrl: config.serverUrl,
          pushKey: config.pushKey,
        },
      }, () => {
        setTrackingUI(true);
      });

      // Set keepalive alarm
      chrome.alarms.create('keepalive', { periodInMinutes: 1 });
    }
  });
});

function setTrackingUI(tracking) {
  const btn = $('btn-track');
  const dot = $('t-dot');
  const statusTitle = $('t-status');
  const statusDesc = $('t-desc');

  if (tracking) {
    btn.className = 'btn-primary stop';
    btn.innerHTML = '⏹ Parar Rastreamento';
    dot.className = 'status-dot live';
    statusTitle.textContent = '🔴 Transmitindo';
    statusDesc.textContent = 'GPS ativo — localização sendo enviada';
    $('data-grid').style.display = 'grid';
    $('links-section').style.display = 'flex';

    // Set links
    const viewerUrl = `${config.serverUrl}/#live/${config.username}`;
    const obsUrl = `${config.serverUrl}/obs?key=${config.pullKey}`;
    $('link-viewer').querySelector('span').textContent = viewerUrl;
    $('link-obs').querySelector('span').textContent = obsUrl;
  } else {
    btn.className = 'btn-primary';
    btn.innerHTML = '📡 Iniciar Rastreamento';
    dot.className = 'status-dot';
    statusTitle.textContent = 'Offline';
    statusDesc.textContent = 'Pronto para transmitir';
  }
}

// ─── LIVE DATA UPDATE ──────────────────────────────────────────────────────

async function updateLiveData() {
  const data = await chrome.storage.local.get(['pushCount', 'lastPosition', 'lastPush', 'pushError', 'isTracking']);

  if (data.pushCount != null) {
    $('t-count').textContent = data.pushCount;
  }

  if (data.lastPosition) {
    $('t-lat').textContent = data.lastPosition.lat.toFixed(6);
    $('t-lon').textContent = data.lastPosition.lon.toFixed(6);
    $('t-acc').textContent = data.lastPosition.accuracy ? `${Math.round(data.lastPosition.accuracy)}m` : '—';
  }

  if (data.pushError) {
    $('t-error').textContent = `⚠️ ${data.pushError}`;
  } else {
    $('t-error').textContent = '';
  }

  // Sync tracking state
  if (data.isTracking) {
    setTrackingUI(true);
  }
}

// ─── COPY LINKS ────────────────────────────────────────────────────────────

document.querySelectorAll('.btn-copy').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = btn.dataset.target;
    let url = '';
    if (target === 'viewer') {
      url = `${config.serverUrl}/#live/${config.username}`;
    } else if (target === 'obs') {
      url = `${config.serverUrl}/obs?key=${config.pullKey}`;
    }
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = '✅';
      setTimeout(() => btn.textContent = '📋', 1500);
    });
  });
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────

$('btn-settings').addEventListener('click', async () => {
  // Reset and show setup view
  await chrome.storage.local.clear();
  config = null;
  $('view-track').style.display = 'none';
  $('view-setup').style.display = 'flex';
  $('setup-status').textContent = '';
  $('btn-register').textContent = '✅ Registrar e Conectar';
  $('btn-register').disabled = false;
});
