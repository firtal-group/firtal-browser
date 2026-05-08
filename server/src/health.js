/**
 * Health check — single command that tells you (or an agent) whether the
 * browser-runtime is ready to use.
 *
 * Returns a structured object so it can be consumed both by humans on the
 * CLI and by agents through the MCP wrapper.
 */

const fs = require('fs');
const {
  detectChromeBin,
  extensionDir,
  profileDir,
  readState,
  isPidAlive,
  findRunningChrome,
  isMcpPortListening
} = require('./agentRuntime');
const { isCloudflaredInstalled, tunnelStatus } = require('./tunnel');
const { watchdogStatus } = require('./watchdog');

function checkHealth(profile, options = {}) {
  const port = options.port || 5555;
  const checks = {};

  // Chrome binary
  const chromeBin = detectChromeBin();
  checks.chrome_binary = {
    ok: Boolean(chromeBin),
    path: chromeBin || null,
    detail: chromeBin ? null : 'Install Google Chrome or set CHROME_BIN'
  };

  // Extension built
  const extDir = extensionDir();
  const extOk = fs.existsSync(extDir);
  checks.extension_built = {
    ok: extOk,
    path: extDir,
    detail: extOk ? null : 'Run `node cli.js setup` to build the extension'
  };

  // Profile directory
  const pDir = profileDir(profile);
  const profileOk = fs.existsSync(pDir);
  checks.profile = {
    ok: profileOk,
    name: profile,
    path: pDir,
    detail: profileOk ? null : 'Run `node cli.js setup --profile ' + profile + '`'
  };

  // Agent Chrome process running?
  const running = findRunningChrome(profile);
  checks.chrome_running = {
    ok: Boolean(running),
    pid: running ? running.pid : null,
    detail: running ? null : 'Run `node cli.js auto-launch --profile ' + profile + '`'
  };

  // MCP port (only relevant when an MCP client is connected; not a failure
  // by itself, since serve is started by the MCP client on demand)
  checks.mcp_port = {
    ok: true,
    listening: isMcpPortListening(port),
    port,
    detail: 'serve runs on stdio + WebSocket — the WS port is only bound while a client is connected'
  };

  // Watchdog
  const wd = watchdogStatus(profile);
  checks.watchdog = {
    ok: true,
    running: wd.running,
    pid: wd.pid || null,
    detail: wd.running ? null : 'Optional. Run `node cli.js watchdog --profile ' + profile + ' --daemon` to auto-respawn Chrome on crash.'
  };

  // Tunnel
  const tun = tunnelStatus(profile);
  checks.tunnel = {
    ok: true,
    running: tun.running || false,
    url: tun.url || null,
    detail: tun.running ? null : 'No tunnel active. Use `node cli.js tunnel start` to expose this profile remotely.'
  };

  // cloudflared
  const cfd = isCloudflaredInstalled();
  checks.cloudflared = {
    ok: cfd,
    installed: cfd,
    detail: cfd ? null : 'Install on demand when you first run `tunnel start` (brew install cloudflared on macOS)'
  };

  // State summary
  const state = readState(profile);

  const allRequiredOk =
    checks.chrome_binary.ok &&
    checks.extension_built.ok &&
    checks.profile.ok &&
    checks.chrome_running.ok;

  return {
    profile,
    healthy: allRequiredOk,
    checks,
    state
  };
}

function formatHealth(result) {
  const lines = [];
  lines.push(`Profile: ${result.profile}`);
  lines.push(`Healthy: ${result.healthy ? 'YES' : 'NO'}`);
  lines.push('');
  for (const [name, c] of Object.entries(result.checks)) {
    const flag = c.ok === false ? '✗' : (c.running === false ? '·' : '✓');
    const extras = [];
    if ('running' in c) extras.push(`running=${c.running}`);
    if (c.pid) extras.push(`pid=${c.pid}`);
    if (c.url) extras.push(`url=${c.url}`);
    if (c.path && !c.ok) extras.push(`path=${c.path}`);
    lines.push(`  ${flag} ${name}${extras.length ? '  (' + extras.join(', ') + ')' : ''}`);
    if (c.detail && !c.ok) lines.push(`      → ${c.detail}`);
  }
  return lines.join('\n');
}

module.exports = { checkHealth, formatHealth };
