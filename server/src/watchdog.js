/**
 * Watchdog — keeps agent Chrome alive.
 *
 * This module is invoked in two ways:
 *   1. As a background daemon: `cli.js watchdog --profile X --daemon`
 *      forks the watchdog into the background and returns immediately.
 *   2. As a foreground monitor: `cli.js watchdog --profile X` runs in the
 *      current shell, useful for debugging.
 *
 * The watchdog process polls every WATCHDOG_INTERVAL_MS:
 *   - Is the recorded chrome_pid still alive?  If not, respawn.
 *   - Has the tunnel idle-timeout expired?  If yes, stop the tunnel.
 *
 * State is read from ~/.firtal-browser/state/<profile>.json and the
 * watchdog records its own pid back to the state file so other commands
 * can stop it.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  ensureDirs,
  logFile,
  readState,
  writeState,
  isPidAlive,
  findRunningChrome,
  spawnAgentChrome
} = require('./agentRuntime');
const { stopTunnel } = require('./tunnel');

const WATCHDOG_INTERVAL_MS = 5000;

function spawnDaemon(profile) {
  // Re-exec ourselves with --child so the parent returns immediately.
  ensureDirs();
  const out = fs.openSync(logFile(profile, 'watchdog'), 'a');
  const child = spawn(
    process.execPath,
    [path.resolve(__dirname, '..', 'cli.js'), 'watchdog', '--profile', profile, '--child'],
    { detached: true, stdio: ['ignore', out, out] }
  );
  child.unref();
  writeState(profile, { watchdog_pid: child.pid, watchdog_started_at: new Date().toISOString() });
  return child.pid;
}

function stopWatchdog(profile) {
  const state = readState(profile);
  if (!state.watchdog_pid || !isPidAlive(state.watchdog_pid)) {
    writeState(profile, { watchdog_pid: null });
    return { stopped: false, reason: 'not_running' };
  }
  try { process.kill(state.watchdog_pid); } catch {}
  writeState(profile, { watchdog_pid: null });
  return { stopped: true };
}

function watchdogStatus(profile) {
  const state = readState(profile);
  if (!state.watchdog_pid) return { running: false };
  if (!isPidAlive(state.watchdog_pid)) {
    writeState(profile, { watchdog_pid: null });
    return { running: false, reason: 'died' };
  }
  return { running: true, pid: state.watchdog_pid, started_at: state.watchdog_started_at };
}

async function runWatchdogLoop(profile) {
  // Record our own pid (overrides whatever the daemon-spawn wrote) and
  // keep the chrome process alive.
  writeState(profile, { watchdog_pid: process.pid, watchdog_started_at: new Date().toISOString() });

  // Touch the log on startup so we know we got here.
  try {
    fs.appendFileSync(
      logFile(profile, 'watchdog'),
      `[${new Date().toISOString()}] watchdog started (pid=${process.pid})\n`
    );
  } catch {}

  let stopRequested = false;
  const onSignal = (sig) => {
    stopRequested = true;
    try {
      fs.appendFileSync(
        logFile(profile, 'watchdog'),
        `[${new Date().toISOString()}] received ${sig}, exiting\n`
      );
    } catch {}
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  while (!stopRequested) {
    try {
      tick(profile);
    } catch (e) {
      try {
        fs.appendFileSync(
          logFile(profile, 'watchdog'),
          `[${new Date().toISOString()}] tick error: ${e.message}\n`
        );
      } catch {}
    }
    await new Promise((r) => setTimeout(r, WATCHDOG_INTERVAL_MS));
  }

  writeState(profile, { watchdog_pid: null });
}

function tick(profile) {
  const state = readState(profile);

  // 1. Chrome alive?
  const running = findRunningChrome(profile);
  if (!running) {
    fs.appendFileSync(
      logFile(profile, 'watchdog'),
      `[${new Date().toISOString()}] Chrome not running for profile=${profile}, respawning\n`
    );
    const pid = spawnAgentChrome(profile, {
      remoteDebuggingPort: state.remote_debugging_port || undefined
    });
    fs.appendFileSync(
      logFile(profile, 'watchdog'),
      `[${new Date().toISOString()}] Chrome respawned pid=${pid}\n`
    );
  }

  // 2. Tunnel idle timeout?
  if (state.tunnel_pid && state.tunnel_started_at && state.tunnel_idle_minutes) {
    const startedMs = new Date(state.tunnel_started_at).getTime();
    const ageMin = (Date.now() - startedMs) / 60_000;
    if (ageMin > state.tunnel_idle_minutes) {
      fs.appendFileSync(
        logFile(profile, 'watchdog'),
        `[${new Date().toISOString()}] tunnel idle ${ageMin.toFixed(1)}min > ${state.tunnel_idle_minutes}min, stopping\n`
      );
      stopTunnel(profile);
    }
  }
}

module.exports = {
  spawnDaemon,
  stopWatchdog,
  watchdogStatus,
  runWatchdogLoop,
  WATCHDOG_INTERVAL_MS
};
