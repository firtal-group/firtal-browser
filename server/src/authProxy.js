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

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return null;
}

function getRequestToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const u = url.parse(req.url, true);
  if (u.query && typeof u.query.token === 'string') return u.query.token;
  return getCookie(req, 'firtal_browser_token');
}

function externalEndpoint(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const firstProto = String(proto).split(',')[0].trim();
  const firstHost = String(host || '').split(',')[0].trim();
  return {
    host: firstHost,
    httpScheme: firstProto === 'https' ? 'https' : 'http',
    wsScheme: firstProto === 'https' ? 'wss' : 'ws'
  };
}

function buildRemoteCdpUrl(req, originalUrl, token) {
  if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;

  const endpoint = externalEndpoint(req);
  const parsed = originalUrl.startsWith('ws://') || originalUrl.startsWith('wss://')
    ? new URL(originalUrl)
    : new URL(`ws://${originalUrl}`);
  parsed.protocol = `${endpoint.wsScheme}:`;
  parsed.host = endpoint.host;
  if (!endpoint.host.includes(':')) parsed.port = '';
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

function buildRemoteDevtoolsUrl(req, target, token) {
  const endpoint = externalEndpoint(req);
  let wsPath = target.id ? `/devtools/page/${target.id}` : '';

  if (target.webSocketDebuggerUrl) {
    try {
      wsPath = new URL(target.webSocketDebuggerUrl).pathname;
    } catch {}
  } else if (target.devtoolsFrontendUrl) {
    try {
      const frontend = new URL(target.devtoolsFrontendUrl, 'http://localhost');
      const wsParam = frontend.searchParams.get('ws');
      if (wsParam) wsPath = new URL(`ws://${wsParam}`).pathname;
    } catch {}
  }

  const wsTarget = `${endpoint.host}${wsPath}?token=${encodeURIComponent(token)}`;
  const params = new URLSearchParams({
    ws: wsTarget,
    token
  });
  return `/devtools/inspector.html?${params.toString()}`;
}

function rewriteCdpJson(req, payload, token) {
  if (Array.isArray(payload)) {
    return payload.map((target) => {
      if (!target || typeof target !== 'object') return target;
      const next = { ...target };
      if (next.webSocketDebuggerUrl) {
        next.webSocketDebuggerUrl = buildRemoteCdpUrl(req, next.webSocketDebuggerUrl, token);
      }
      if ((next.webSocketDebuggerUrl || next.devtoolsFrontendUrl) && next.id) {
        next.devtoolsFrontendUrl = buildRemoteDevtoolsUrl(req, next, token);
      }
      return next;
    });
  }

  if (payload && typeof payload === 'object') {
    const next = { ...payload };
    if (next.webSocketDebuggerUrl) {
      next.webSocketDebuggerUrl = buildRemoteCdpUrl(req, next.webSocketDebuggerUrl, token);
    }
    return next;
  }

  return payload;
}

function fetchJsonFromUpstream(upstreamPort, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: pathname,
        headers: { host: `localhost:${upstreamPort}` }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Timed out reading Chrome CDP targets'));
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderRemoteIndex({ targets, token }) {
  const pageTargets = targets.filter((target) => target && target.type === 'page' && target.id);
  const rows = pageTargets.map((target) => {
    const href = withQueryToken(target.devtoolsFrontendUrl, token);
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(target.title || target.url || target.id)}</a><span>${escapeHtml(target.url || '')}</span></li>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Firtal Browser Remote</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #171717; }
    main { max-width: 880px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    p { margin: 0 0 20px; color: #555; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 14px; }
    a { display: block; color: #0f766e; font-weight: 700; text-decoration: none; margin-bottom: 6px; }
    span { color: #666; font-size: 13px; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>Firtal Browser Remote</h1>
    <p>Open a tab below to interact with the dedicated agent Chrome profile.</p>
    <ul>${rows || '<li>No open page targets found. Start Chrome with a page URL and refresh.</li>'}</ul>
  </main>
</body>
</html>`;
}

function withQueryToken(link, token) {
  if (!link || typeof link !== 'string') return link;
  const separator = link.includes('?') ? '&' : '?';
  return /[?&]token=/.test(link) ? link : `${link}${separator}token=${encodeURIComponent(token)}`;
}

function upstreamUpgradeHeaders(req, upstreamPort) {
  return {
    ...req.headers,
    host: `localhost:${upstreamPort}`,
    origin: `http://localhost:${upstreamPort}`,
    cookie: undefined,
    authorization: undefined
  };
}

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
    return getRequestToken(req) === token;
  }

  const server = http.createServer(async (clientReq, clientRes) => {
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

    if ((u.pathname === '/' || u.pathname === '/remote') && clientReq.method === 'GET') {
      try {
        const targets = rewriteCdpJson(clientReq, await fetchJsonFromUpstream(upstreamPort, '/json/list'), token);
        clientRes.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `firtal_browser_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
        });
        clientRes.end(renderRemoteIndex({ targets, token }));
      } catch (err) {
        log(`remote index error: ${err.message}`);
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end('Could not read Chrome targets');
      }
      return;
    }

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: upstreamPath,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: `localhost:${upstreamPort}` }
      },
      (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const shouldRewriteJson =
          clientReq.method === 'GET' &&
          ['/json', '/json/list', '/json/version'].includes(u.pathname) &&
          String(contentType).includes('application/json');

        const headers = {
          ...proxyRes.headers,
          'set-cookie': `firtal_browser_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
        };

        if (!shouldRewriteJson) {
          clientRes.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(clientRes);
          return;
        }

        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const body = JSON.stringify(rewriteCdpJson(clientReq, json, token));
            clientRes.writeHead(proxyRes.statusCode, {
              ...headers,
              'content-length': Buffer.byteLength(body),
              'content-type': 'application/json; charset=utf-8'
            });
            clientRes.end(body);
          } catch (err) {
            log(`json rewrite error: ${err.message}`);
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            clientRes.end('Bad Gateway');
          }
        });
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
      const headers = upstreamUpgradeHeaders(req, upstreamPort);
      const headerLines = [
        `GET ${upstreamPath} HTTP/1.1`,
        ...Object.entries(headers)
          .filter(([, v]) => v !== undefined)
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

module.exports = {
  runAuthProxy,
  spawnAuthProxy,
  stopAuthProxy,
  rewriteCdpJson,
  renderRemoteIndex,
  buildRemoteCdpUrl,
  buildRemoteDevtoolsUrl,
  upstreamUpgradeHeaders
};
