// watchdog.js — Detects event loop blockage and exits the process so Docker
// can restart it. Also writes a heartbeat file for downtime detection.
const fs = require('fs');
const path = require('path');

let watchdogTimer = null;
let lastHeartbeat = Date.now();
let watchdogTimeoutMs = 120000;
let clientInstance = null;
let logChannelId = null;
let isExiting = false;

const HEARTBEAT_FILE = path.join(process.cwd(), 'last_heartbeat.txt');

function start(options = {}) {
  watchdogTimeoutMs = options.timeoutMs || 120000;
  clientInstance = options.client || null;
  logChannelId = options.channelId || null;

  watchdogTimer = setInterval(() => {
    lastHeartbeat = Date.now();
    try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString()); } catch (_) {}
  }, 10000);

  const checkTimer = setInterval(() => {
    const elapsed = Date.now() - lastHeartbeat;
    if (elapsed > watchdogTimeoutMs && !isExiting) {
      isExiting = true;
      const reason = `Watchdog: event loop blocked for ${Math.round(elapsed / 1000)}s. Forcing restart.`;
      console.error(`[Watchdog] ${reason}`);
      if (clientInstance && logChannelId) {
        try {
          const channel = clientInstance.channels?.cache?.get(logChannelId);
          if (channel) channel.send(`⚠️ **Автоматический перезапуск**\n${reason}`).catch(() => {});
        } catch (_) {}
      }
      setTimeout(() => { process.exit(1); }, 2000);
    }
  }, 15000);

  if (watchdogTimer.unref) watchdogTimer.unref();
  if (checkTimer.unref) checkTimer.unref();
  console.log(`[Watchdog] Started — timeout: ${watchdogTimeoutMs / 1000}s, channel: ${logChannelId || 'none'}`);
}

function stop() { if (watchdogTimer) clearInterval(watchdogTimer); watchdogTimer = null; }

module.exports = { start, stop };