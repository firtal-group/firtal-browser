/**
 * Agent runtime helpers — Chrome process management, state file, paths.
 *
 * Shared between the `auto-launch`, `health`, `watchdog`, and `tunnel`
 * subcommands. All commands operate on a *named* profile (default: firtal-agent)
 * and persist runtime state under ~/.firtal-browser/state/<profile>.json so
 * that independent CLI invocations can coordinate.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const HOME = os.homedir();
const ROOT_DIR = path.join(HOME, '.firtal-browser');
const STATE_DIR = path.join(ROOT_DIR, 'state');
const LOG_DIR = path.join(ROOT_DIR, 'logs');

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function profileDir(profile) {
  return path.join(ROOT_DIR, 'profiles', profile);
}

function stateFile(profile) {
  return path.join(STATE_DIR, `${profile}.json`);
}

function logFile(profile, kind) {
  return path.join(LOG_DIR, `${profile}.${kind}.log`);
}

function readState(profile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(profile), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(profile, patch) {
  ensureDirs();
  const current = readState(profile);
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(stateFile(profile), JSON.stringify(next, null, 2));
  return next;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function detectChromeBin() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;
  }
  if (process.platform === 'linux') {
    try {
      return execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf8' }).trim();
    } catch {
      // fall through
    }
  }
  return null;
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function extensionDir() {
  return path.join(repoRoot(), 'dist', 'chrome');
}

function buildExtensionIfMissing() {
  if (fs.existsSync(extensionDir())) return;
  const buildScript = path.join(repoRoot(), 'extensions', 'build-chrome.js');
  if (!fs.existsSync(buildScript)) {
    throw new Error(`Cannot build extension — script missing at ${buildScript}`);
  }
  execSync(`node ${JSON.stringify(buildScript)}`, { cwd: repoRoot(), stdio: 'inherit' });
}

/**
 * Find a running agent Chrome process for this profile.
 * Returns { pid, args } if found, otherwise null.
 *
 * We match by --user-data-dir flag, not by Chrome binary, because Sara may
 * have many other Chrome processes running with her normal profile. The
 * agent profile path is unique to each named profile.
 */
function findRunningChrome(profile) {
  const profilePath = profileDir(profile);
  let psOutput;
  try {
    psOutput = execSync('ps -A -o pid=,args=', { encoding: 'utf8' });
  } catch {
    return null;
  }
  const lines = psOutput.split('\n');
  for (const line of lines) {
    if (!line.includes('--user-data-dir=')) continue;
    if (!line.includes(profilePath)) continue;
    // Skip helper / renderer subprocesses
    if (line.includes('--type=')) continue;
    const trimmed = line.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx < 0) continue;
    const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
    if (!Number.isFinite(pid)) continue;
    return { pid, args: trimmed.slice(spaceIdx + 1) };
  }
  return null;
}

function spawnAgentChrome(profile, options = {}) {
  ensureDirs();
  buildExtensionIfMissing();

  const chromeBin = detectChromeBin();
  if (!chromeBin) {
    throw new Error('Chrome not found. Install Google Chrome or set CHROME_BIN.');
  }

  const pDir = profileDir(profile);
  fs.mkdirSync(pDir, { recursive: true });

  const args = [
    `--user-data-dir=${pDir}`,
    `--load-extension=${extensionDir()}`,
    '--no-first-run',
    '--no-default-browser-check'
  ];

  if (options.remoteDebuggingPort) {
    args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`);
    args.push(`--remote-debugging-address=127.0.0.1`);
  }

  if (options.startUrl) {
    args.push(options.startUrl);
  }

  const out = fs.openSync(logFile(profile, 'chrome'), 'a');
  const child = spawn(chromeBin, args, {
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();

  writeState(profile, {
    chrome_pid: child.pid,
    chrome_started_at: new Date().toISOString(),
    chrome_args: args,
    remote_debugging_port: options.remoteDebuggingPort || null
  });

  return child.pid;
}

/**
 * Idempotent: returns existing pid if Chrome already runs for this profile,
 * otherwise spawns a new instance.
 */
function ensureRunning(profile, options = {}) {
  const existing = findRunningChrome(profile);
  if (existing) {
    return { pid: existing.pid, started: false };
  }
  const pid = spawnAgentChrome(profile, options);
  // Update state with the actual pid; spawnAgentChrome already did, but
  // belt-and-suspenders for callers that pass through here.
  return { pid, started: true };
}

function isMcpPortListening(port = 5555) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  ROOT_DIR,
  STATE_DIR,
  LOG_DIR,
  ensureDirs,
  profileDir,
  stateFile,
  logFile,
  readState,
  writeState,
  isPidAlive,
  detectChromeBin,
  repoRoot,
  extensionDir,
  buildExtensionIfMissing,
  findRunningChrome,
  spawnAgentChrome,
  ensureRunning,
  isMcpPortListening
};
