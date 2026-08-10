// watchdog.js — Detects event loop blockage and exits the process so Docker
// can restart it. Same as discord-joe's watchdog.
let watchdogTimer = null;
let lastHeartbeat = Date.now();
let watchdogTimeoutMs = 120000;
let clientInstance = null;
let logChannelId = null;
let isExiting = false;

function start(options = {}) {
  watchdogTimeoutMs = options.timeoutMs || 120000;
  clientInstance = options.client || null;
  logChannelId = options.channelId || null;

  watchdogTimer = setInterval(() => {
    lastHeartbeat = Date.now();
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