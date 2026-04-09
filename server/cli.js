#!/usr/bin/env node
/**
 * Copyright (c) 2025 Rails Blueprint
 * Originally inspired by Microsoft's Playwright MCP
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Note: Environment variables should be set by the MCP client or system environment
// No need to load .env files for published MCP servers

// Enable stealth mode patches by default (uses generic names instead of Playwright-specific ones)
process.env.STEALTH_MODE = 'true';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Command } = require('commander');
const { StatefulBackend } = require('./src/statefulBackend');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { getLogger } = require('./src/fileLogger');

const packageJSON = require('./package.json');
const { startScriptMode } = require('./src/scriptMode');

// Simple config resolver
function resolveConfig(options) {
  return {
    debug: options.debug === true,
    port: options.port || 5555,
    server: {
      name: 'Blueprint MCP for Browser',
      version: packageJSON.version
    }
  };
}

// Wrapper mode - spawns child process and monitors for reload (exit code 42)
function runAsWrapper() {
  console.error('[Wrapper] Starting in wrapper mode with auto-reload enabled');
  console.error('[Wrapper] Press Ctrl+C to exit');

  const inputBuffer = new PassThrough();
  const outputBuffer = new PassThrough();

  // Pipe stdin to input buffer
  process.stdin.pipe(inputBuffer);

  // Pipe output buffer to stdout
  outputBuffer.pipe(process.stdout);

  function spawnChild() {
    console.error('[Wrapper] Starting MCP server...');

    // Spawn child with --child flag to indicate it's the inner process
    const args = process.argv.slice(2).filter(arg => arg !== '--debug');
    args.push('--child');

    const child = spawn(process.execPath, [__filename, ...args], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    // Proxy buffered input to child
    inputBuffer.pipe(child.stdin);

    // Proxy child output to buffer
    child.stdout.pipe(outputBuffer, { end: false });

    child.on('exit', (code, signal) => {
      console.error(`[Wrapper] Child exited (code=${code}, signal=${signal})`);

      // Unpipe to prevent write-after-end errors
      inputBuffer.unpipe(child.stdin);
      child.stdout.unpipe(outputBuffer);

      // Check if this was an intentional reload (exit code 42)
      if (code === 42) {
        console.error('[Wrapper] Reload requested, restarting...');
        setTimeout(() => spawnChild(), 100);
      } else {
        console.error('[Wrapper] Server terminated, shutting down');
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`[Wrapper] Child error: ${err.message}`);
      process.exit(1);
    });

    // Handle signals
    process.on('SIGTERM', () => {
      child.kill();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      child.kill();
      process.exit(0);
    });
  }

  spawnChild();
}

// Simple exit watchdog
function setupExitWatchdog() {
  let cleanupDone = false;

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;

    if (global.DEBUG_MODE) {
      console.error('[cli.js] Cleanup initiated');
    }

    // Give 5 seconds for graceful shutdown
    setTimeout(() => {
      if (global.DEBUG_MODE) {
        console.error('[cli.js] Forcing exit after timeout');
      }
      process.exit(0);
    }, 5000);
  };

  process.stdin.on('close', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// Main action
async function main(options) {
  setupExitWatchdog();

  // Store debug mode globally for access by other modules
  global.DEBUG_MODE = options.debug === true;

  // Enable file logging in debug mode
  const logger = getLogger(options.logFile);
  if (global.DEBUG_MODE) {
    logger.enable();
    logger.log('[cli.js] Starting MCP server in PASSIVE mode (no connections)');
    logger.log('[cli.js] Version:', packageJSON.version);
    logger.log('[cli.js] Use connect tool to activate');
    logger.log('[cli.js] Debug mode: ENABLED');
    logger.log('[cli.js] Log file:', logger.logFilePath);
    if (options.port) {
      logger.log('[cli.js] Custom port:', options.port);
    }
  }

  const config = resolveConfig(options);

  // Create StatefulBackend
  const backend = new StatefulBackend(config);

  if (global.DEBUG_MODE) {
    console.error(`[cli.js] Creating MCP Server v${packageJSON.version}...`);
  }

  // Create MCP Server
  const server = new Server(
    {
      name: config.server.name,
      version: config.server.version
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Register handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await backend.listTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await backend.callTool(name, args);
  });

  // Initialize backend
  const clientInfo = {}; // Will be populated on connection
  await backend.initialize(server, clientInfo);

  if (global.DEBUG_MODE) {
    console.error('[cli.js] Starting stdio transport...');
  }

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (global.DEBUG_MODE) {
    console.error('[cli.js] MCP server ready (passive mode)');
  }

  // Handle shutdown
  process.on('SIGINT', async () => {
    if (global.DEBUG_MODE) {
      console.error('[cli.js] Shutting down...');
    }
    await backend.serverClosed();
    await server.close();
    process.exit(0);
  });
}

// Setup command: one-command setup for Firtal Browser
async function setupFirtalBrowser(options) {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  const profileName = options.profile || 'firtal-agent';
  const profileDir = path.join(require('os').homedir(), '.firtal-browser', 'profiles', profileName);
  const repoRoot = path.resolve(__dirname, '..');
  const distDir = path.join(repoRoot, 'dist', 'chrome');
  const cliPath = path.resolve(__dirname, 'cli.js');

  console.log('\n  Firtal Browser Setup\n');

  // Step 1: Build extension
  console.log('  [1/4] Building Chrome extension...');
  try {
    execSync('node ' + path.join(repoRoot, 'extensions', 'build-chrome.js'), {
      cwd: repoRoot,
      stdio: 'pipe'
    });
    console.log('        Done\n');
  } catch (e) {
    console.error('        Build failed:', e.message);
    process.exit(1);
  }

  // Step 2: Create profile directory
  console.log('  [2/4] Creating agent Chrome profile...');
  fs.mkdirSync(profileDir, { recursive: true });
  console.log('        ' + profileDir + '\n');

  // Step 3: Detect Chrome and launch
  console.log('  [3/4] Launching agent Chrome...');
  let chromeBin;
  if (process.platform === 'darwin') {
    chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else if (process.platform === 'linux') {
    try {
      chromeBin = execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf8' }).trim();
    } catch {
      console.error('        Chrome not found. Install Google Chrome first.');
      process.exit(1);
    }
  } else {
    chromeBin = 'chrome';
  }

  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${distDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ];

  const chrome = spawn(chromeBin, chromeArgs, {
    detached: true,
    stdio: 'ignore'
  });
  chrome.unref();
  console.log('        Agent Chrome is open — log into your services now\n');

  // Step 4: Print MCP config
  console.log('  [4/4] Add to your MCP client:\n');
  console.log('  Claude Code:');
  console.log(`    claude mcp add firtal-browser -- node ${cliPath}\n`);
  console.log('  Claude Desktop (claude_desktop_config.json):');
  console.log(`    {
      "mcpServers": {
        "firtal-browser": {
          "command": "node",
          "args": ["${cliPath}"]
        }
      }
    }\n`);
  console.log('  VS Code / Cursor (.vscode/settings.json):');
  console.log(`    {
      "mcp.servers": {
        "firtal-browser": {
          "command": "node",
          "args": ["${cliPath}"]
        }
      }
    }\n`);

  console.log('  Next time, just run:');
  console.log(`    node ${cliPath} launch\n`);
}

// Launch command: relaunch agent Chrome with existing profile
function launchFirtalBrowser(options) {
  const path = require('path');
  const fs = require('fs');

  const profileName = options.profile || 'firtal-agent';
  const profileDir = path.join(require('os').homedir(), '.firtal-browser', 'profiles', profileName);
  const repoRoot = path.resolve(__dirname, '..');
  const distDir = path.join(repoRoot, 'dist', 'chrome');

  if (!fs.existsSync(profileDir)) {
    console.error(`Profile "${profileName}" not found. Run "setup" first.`);
    process.exit(1);
  }

  if (!fs.existsSync(distDir)) {
    console.error('Extension not built. Run "setup" first.');
    process.exit(1);
  }

  let chromeBin;
  if (process.platform === 'darwin') {
    chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    try {
      const { execSync } = require('child_process');
      chromeBin = execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf8' }).trim();
    } catch {
      chromeBin = 'chrome';
    }
  }

  const chrome = spawn(chromeBin, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${distDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  console.log(`Agent Chrome launched (profile: ${profileName})`);
}

// Set up command
const program = new Command();

program
  .version('Version ' + packageJSON.version)
  .name('firtal-browser')
  .description('Firtal Browser — MCP server for browser automation using your real Chrome profile');

// Default command: start MCP server
program
  .command('serve', { isDefault: true })
  .description('Start MCP server (default)')
  .option('--debug', 'Enable debug mode')
  .option('--log-file <path>', 'Custom log file path')
  .option('--port <number>', 'WebSocket server port (default: 5555)', parseInt)
  .option('--child', 'Internal flag: child process spawned by wrapper')
  .option('--script-mode', 'Enable scripting mode')
  .action(async (options) => {
    if (options.scriptMode) {
      const config = resolveConfig(options);
      await startScriptMode(config);
      return;
    }
    if (options.debug && !options.child) {
      runAsWrapper();
      return;
    }
    if (options.child) {
      options.debug = true;
    }
    await main(options);
  });

// Setup command
program
  .command('setup')
  .description('One-command setup: build extension, create Chrome profile, launch browser')
  .option('--profile <name>', 'Profile name (default: firtal-agent)')
  .action(setupFirtalBrowser);

// Launch command
program
  .command('launch')
  .description('Launch agent Chrome with existing profile')
  .option('--profile <name>', 'Profile name (default: firtal-agent)')
  .action(launchFirtalBrowser);

program.parse(process.argv);
