/**
 * Token-auth proxy in front of Chrome's DevTools Protocol.
 *
 * Chrome's CDP has no authentication at all — anyone who can reach
 * 127.0.0.1:9222 can drive the browser. When we expose it through a
 * Cloudflare tunnel, the random subdomain provides obscurity but not
 * security; the URL leaking once is enough for an attacker to take over
 * the browser.
 *
 * This module spawns a small HTTP+WS reverse proxy that:
 *   - requires a `token` query param OR `Authorization: Bearer <token>`
 *     header on every HTTP request and WebSocket upgrade
 *   - rejects unauthenticated requests with 401 (no info leak)
 *   - forwards everything else 1:1 to Chrome's CDP
 *
 * The tunnel command points cloudflared at the proxy's port instead of
 * Chrome's. The token is the random hex generated when the tunnel is
 * started, so each tunnel session has a fresh token.
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const {
  ensureDirs,
  logFile,
  readState,
  writeState,
  isPidAlive
} = require('./agentRuntime');

/**
 * Run the proxy in-process. Used by the daemon child mode of cli.js.
 */
function runAuthProxy({ listenPort, upstreamPort, token, profile }) {
  if (!listenPort || !upstreamPort || !token) {
    throw new Error('runAuthProxy requires listenPort, upstreamPort, token');
  }

  const log = (msg) => {
    try {
      fs.appendFileSync(
        logFile(profile || 'firtal-agent', 'auth-proxy'),
        `[${new Date().toISOString()}] ${msg}\n`
      );
    } catch {}
  };

  function isAuthed(req) {
    // Token in Authorization header
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && auth.slice(7) === token) return true;
    // Token in ?token=...
    const u = url.parse(req.url, true);
    if (u.query && u.query.token === token) return true;
    return false;
  }

  const server = http.createServer((clientReq, clientRes) => {
    if (!isAuthed(clientReq)) {
      log(`401 ${clientReq.method} ${clientReq.url} from ${clientReq.socket.remoteAddress}`);
      clientRes.writeHead(401, { 'Content-Type': 'text/plain' });
      clientRes.end('Unauthorized');
      return;
    }

    // Strip the token from the upstream URL so Chrome doesn't see it.
    const u = url.parse(clientReq.url, true);
    delete u.query.token;
    delete u.search;

    const upstreamPath = url.format({ pathname: u.pathname, query: u.query });

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: upstreamPath,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: `localhost:${upstreamPort}` }
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    );

    proxyReq.on('error', (err) => {
      log(`upstream error: ${err.message}`);
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Gateway');
    });

    clientReq.pipe(proxyReq);
  });

  // WebSocket upgrade: validate token on the upgrade request, then bridge
  // raw TCP between client and Chrome's WS endpoint.
  server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthed(req)) {
      log(`401-ws ${req.url} from ${req.socket.remoteAddress}`);
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const u = url.parse(req.url, true);
    delete u.query.token;
    delete u.search;
    const upstreamPath = url.format({ pathname: u.pathname, query: u.query });

    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      const headerLines = [
        `GET ${upstreamPath} HTTP/1.1`,
        `Host: localhost:${upstreamPort}`,
        ...Object.entries(req.headers)
          .filter(([k]) => k.toLowerCase() !== 'host')
          .map(([k, v]) => `${k}: ${v}`)
      ];
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      log(`ws upstream error: ${err.message}`);
      try { clientSocket.destroy(); } catch {}
    });
    clientSocket.on('error', () => {
      try { upstream.destroy(); } catch {}
    });
  });

  server.listen(listenPort, '127.0.0.1', () => {
    log(`auth proxy listening on 127.0.0.1:${listenPort} -> 127.0.0.1:${upstreamPort}`);
  });

  return server;
}

/**
 * Spawn the proxy as a background process. Returns the pid.
 */
function spawnAuthProxy({ profile, listenPort, upstreamPort, token }) {
  ensureDirs();
  const out = fs.openSync(logFile(profile, 'auth-proxy'), 'a');
  const cliPath = path.resolve(__dirname, '..', 'cli.js');
  const child = spawn(
    process.execPath,
    [
      cliPath,
      'auth-proxy',
      '--profile', profile,
      '--listen-port', String(listenPort),
      '--upstream-port', String(upstreamPort),
      '--token', token,
      '--child'
    ],
    { detached: true, stdio: ['ignore', out, out] }
  );
  child.unref();
  writeState(profile, {
    auth_proxy_pid: child.pid,
    auth_proxy_listen_port: listenPort,
    auth_proxy_upstream_port: upstreamPort,
    auth_proxy_started_at: new Date().toISOString()
  });
  return child.pid;
}

function stopAuthProxy(profile) {
  const state = readState(profile);
  const pid = state.auth_proxy_pid;
  if (!pid || !isPidAlive(pid)) {
    writeState(profile, { auth_proxy_pid: null });
    return { stopped: false, reason: 'not_running' };
  }
  try { process.kill(pid); } catch {}
  writeState(profile, { auth_proxy_pid: null });
  return { stopped: true };
}

module.exports = { runAuthProxy, spawnAuthProxy, stopAuthProxy };
