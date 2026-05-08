/**
 * Cloudflare Tunnel management for Firtal Browser.
 *
 * Spins up `cloudflared tunnel --url http://127.0.0.1:<port>` against the
 * agent Chrome's remote-debugging port (CDP). The tunnel is a free,
 * ephemeral *.trycloudflare.com URL — no Cloudflare account needed.
 *
 * Sara can open the tunnel URL on a phone or another mac to drive the
 * agent's Chrome via the Chrome DevTools Protocol (e.g. via a CDP-over-HTTP
 * frontend, or by appending /devtools/inspector.html?ws=... — see README).
 *
 * Auto-shutdown: a watchdog timer kills the tunnel after `idleMinutes` of
 * no usage (default 30). Audit log records start/stop/access events.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const {
  ensureDirs,
  logFile,
  readState,
  writeState,
  isPidAlive,
  LOG_DIR
} = require('./agentRuntime');
const { spawnAuthProxy, stopAuthProxy } = require('./authProxy');

const DEFAULT_IDLE_MINUTES = 30;

function pickFreePort() {
  // Synchronous(ish) probe: open a server on :0, read the port, close.
  // We use spawn-sync-friendly Node net here; in practice this returns
  // within a few milliseconds.
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function auditLog(profile, event, data = {}) {
  ensureDirs();
  const file = path.join(LOG_DIR, `${profile}.tunnel-audit.log`);
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n';
  fs.appendFileSync(file, line);
}

function isCloudflaredInstalled() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installCloudflared() {
  // macOS: brew. Linux: apt/curl. We'll prefer brew on macOS and fall back
  // to a download URL on Linux.
  if (process.platform === 'darwin') {
    try {
      execSync('which brew', { stdio: 'ignore' });
    } catch {
      throw new Error('brew not installed. Install Homebrew first or install cloudflared manually.');
    }
    execSync('brew install cloudflared', { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'linux') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    const target = '/usr/local/bin/cloudflared';
    execSync(`sudo curl -L -o ${target} ${url} && sudo chmod +x ${target}`, { stdio: 'inherit' });
    return;
  }
  throw new Error(`Auto-install of cloudflared not supported on ${process.platform}.`);
}

function ensureCloudflared() {
  if (isCloudflaredInstalled()) return;
  installCloudflared();
}

/**
 * Start a Cloudflare quick-tunnel against the given local port.
 *
 * The `port` argument is the *upstream* port that owns the resource we
 * want to expose (typically Chrome's --remote-debugging-port). We do NOT
 * point cloudflared directly at it. Instead we:
 *   1. Pick a free local port for our token-auth proxy
 *   2. Start the auth proxy: 127.0.0.1:<proxyPort> -> 127.0.0.1:<port>
 *   3. Point cloudflared at the proxy port
 *
 * This way the public tunnel URL only serves authenticated requests.
 *
 * Returns { pid, url, token } once the tunnel URL has been allocated.
 */
async function startTunnel(profile, { port, idleMinutes = DEFAULT_IDLE_MINUTES } = {}) {
  if (!port) throw new Error('startTunnel requires a port');
  ensureCloudflared();
  ensureDirs();

  // Already running for this profile? Return current state.
  const state = readState(profile);
  if (state.tunnel_pid && isPidAlive(state.tunnel_pid)) {
    return { pid: state.tunnel_pid, url: state.tunnel_url, token: state.tunnel_token, reused: true };
  }

  const token = crypto.randomBytes(16).toString('hex');
  const proxyPort = await pickFreePort();

  // Start the auth proxy first so cloudflared has something to talk to.
  const proxyPid = spawnAuthProxy({
    profile,
    listenPort: proxyPort,
    upstreamPort: port,
    token
  });

  // Wait briefly for the proxy to bind. If we point cloudflared at a port
  // that isn't listening yet it will refuse with ECONNREFUSED for the
  // first few seconds.
  const proxyDeadline = Date.now() + 5000;
  while (Date.now() < proxyDeadline) {
    try {
      execSync(`nc -z 127.0.0.1 ${proxyPort}`, { stdio: 'ignore' });
      break;
    } catch {
      execSync('sleep 0.1');
    }
  }

  // Truncate previous tunnel log so URL detection never returns a stale
  // hostname from an earlier session.
  fs.writeFileSync(logFile(profile, 'tunnel'), '');
  const out = fs.openSync(logFile(profile, 'tunnel'), 'a');

  // Chrome's DevTools rejects requests whose Host header is not "localhost" or
  // an IP address (it's a deliberate anti-DNS-rebinding defense). When
  // cloudflared forwards a request from *.trycloudflare.com it preserves the
  // public hostname by default, which Chrome refuses. --http-host-header
  // rewrites the Host header on the way to the upstream so Chrome sees a
  // local-looking origin and serves the response.
  const child = spawn(
    'cloudflared',
    [
      'tunnel',
      '--no-autoupdate',
      '--url', `http://127.0.0.1:${proxyPort}`,
      '--http-host-header', `localhost:${port}`
    ],
    { detached: true, stdio: ['ignore', out, out] }
  );
  child.unref();

  // Poll the log for the assigned trycloudflare URL — typically appears
  // within 2-5 seconds.
  const logPath = logFile(profile, 'tunnel');
  const deadline = Date.now() + 30_000;
  let url = null;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const m = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        url = m[0];
        break;
      }
    } catch {
      // log not yet flushed
    }
    // Sync sleep — startTunnel is a setup-time call, blocking is fine.
    execSync('sleep 0.3');
  }

  if (!url) {
    try { process.kill(child.pid); } catch {}
    try { stopAuthProxy(profile); } catch {}
    throw new Error('Cloudflare tunnel did not produce a URL within 30s — check ~/.firtal-browser/logs/');
  }

  writeState(profile, {
    tunnel_pid: child.pid,
    tunnel_url: url,
    tunnel_token: token,
    tunnel_port: port,
    tunnel_proxy_port: proxyPort,
    tunnel_started_at: new Date().toISOString(),
    tunnel_idle_minutes: idleMinutes
  });

  auditLog(profile, 'tunnel_start', { url, port, proxy_port: proxyPort, idle_minutes: idleMinutes, pid: child.pid, auth_proxy_pid: proxyPid });

  return { pid: child.pid, url, token, reused: false, proxyPid, authedUrl: `${url}?token=${token}` };
}

function stopTunnel(profile) {
  const state = readState(profile);
  const pid = state.tunnel_pid;
  // Always tear down the auth proxy alongside the tunnel.
  try { stopAuthProxy(profile); } catch {}

  if (!pid || !isPidAlive(pid)) {
    writeState(profile, { tunnel_pid: null, tunnel_url: null, tunnel_token: null, tunnel_proxy_port: null });
    return { stopped: false, reason: 'not_running' };
  }
  try {
    process.kill(pid);
  } catch {
    // Already gone
  }
  auditLog(profile, 'tunnel_stop', { pid, url: state.tunnel_url });
  writeState(profile, { tunnel_pid: null, tunnel_url: null, tunnel_token: null, tunnel_proxy_port: null });
  return { stopped: true };
}

function tunnelStatus(profile) {
  const state = readState(profile);
  if (!state.tunnel_pid) {
    return { running: false };
  }
  const alive = isPidAlive(state.tunnel_pid);
  if (!alive) {
    writeState(profile, { tunnel_pid: null, tunnel_url: null, tunnel_token: null });
    return { running: false, reason: 'died' };
  }
  return {
    running: true,
    pid: state.tunnel_pid,
    url: state.tunnel_url,
    token: state.tunnel_token,
    port: state.tunnel_port,
    started_at: state.tunnel_started_at,
    idle_minutes: state.tunnel_idle_minutes
  };
}

module.exports = {
  isCloudflaredInstalled,
  ensureCloudflared,
  installCloudflared,
  startTunnel,
  stopTunnel,
  tunnelStatus,
  auditLog,
  DEFAULT_IDLE_MINUTES
};
