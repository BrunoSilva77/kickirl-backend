/**
 * KickIRL — Offscreen GPS Tracker
 * 
 * Roda num offscreen document do Chrome que mantém o GPS ativo
 * mesmo quando a popup está fechada.
 * 
 * Envia atualizações de posição para o service worker via runtime.sendMessage.
 */

let watchId = null;

// Escuta comandos do service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    startGPS();
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopGPS();
  }
});

function startGPS() {
  if (watchId !== null) return;

  if (!navigator.geolocation) {
    chrome.runtime.sendMessage({ type: 'GPS_ERROR', error: 'Geolocation não disponível' });
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      chrome.runtime.sendMessage({
        type: 'POSITION_UPDATE',
        position: {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          speed: position.coords.speed,
          heading: position.coords.heading,
          timestamp: position.timestamp,
        },
      });
    },
    (error) => {
      chrome.runtime.sendMessage({
        type: 'GPS_ERROR',
        error: error.message,
      });
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    }
  );

  console.log('[offscreen] GPS started, watchId:', watchId);
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    console.log('[offscreen] GPS stopped');
  }
}


