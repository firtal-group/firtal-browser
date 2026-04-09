# Firtal Browser

> Give Firtal AI agents access to your real Chrome browser with all your logged-in sessions

Fork of [Blueprint MCP](https://github.com/railsblueprint/blueprint-mcp) (Apache 2.0).

## What is this?

An MCP server + Chrome extension that lets AI agents control your actual browser. Unlike headless automation, this uses your real browser profile with all your logged-in sessions, cookies, and extensions intact.

**Use case:** Your AI agent needs to read a Looker Studio dashboard, check Shopify admin, or browse a supplier portal — and you're already logged in.

## Setup (5 minutes)

### 1. Install the MCP server

```bash
# From this repo
cd server && npm install
```

### 2. Set up agent Chrome profile

The agent gets its own Chrome profile so it doesn't interfere with your normal browser:

```bash
./scripts/setup-profile.sh
```

This opens a new Chrome window with a fresh profile. Log into your services (Looker Studio, Shopify, GA4, etc.) — the profile remembers your sessions.

### 3. Build and load the extension

```bash
# Build the Chrome extension
npm run build:chrome

# In the agent Chrome window:
# 1. Go to chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the dist/chrome folder
```

### 4. Add as MCP tool

**Claude Code:**
```bash
claude mcp add firtal-browser -- node /path/to/firtal-browser/server/cli.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "firtal-browser": {
      "command": "node",
      "args": ["/path/to/firtal-browser/server/cli.js"]
    }
  }
}
```

**VS Code / Cursor** (`.vscode/settings.json`):
```json
{
  "mcp.servers": {
    "firtal-browser": {
      "command": "node",
      "args": ["/path/to/firtal-browser/server/cli.js"]
    }
  }
}
```

### 5. Use it

1. Start the agent Chrome profile: `./scripts/setup-profile.sh`
2. Click the Firtal Browser extension icon — it should show "Connected"
3. Ask your AI to browse:

```
"Go to our Looker Studio dashboard and tell me what charts are on this page"
"Read the Shopify admin orders page"
"Take a screenshot of this supplier portal"
```

## Available Tools

### Connection
- `enable` — Activate browser automation (required first step)
- `disable` — Deactivate browser automation
- `status` — Check connection status

### Tabs
- `browser_tabs` — List, create, attach to, or close tabs

### Navigation
- `browser_navigate` — Navigate to a URL
- `browser_navigate_back` — Go back in history

### Reading Pages
- `browser_snapshot` — Get accessible page content (best for reading pages)
- `browser_take_screenshot` — Capture visual screenshot
- `browser_extract_content` — Extract page content as markdown
- `browser_console_messages` — Get browser console logs

### Interaction
- `browser_interact` — Perform multiple actions in sequence (click, type, hover, wait)
- `browser_click` — Click on elements
- `browser_type` — Type text into inputs
- `browser_fill_form` — Fill multiple form fields at once
- `browser_select_option` — Select dropdown options
- `browser_press_key` — Press keyboard keys
- `browser_drag` — Drag and drop elements
- `browser_hover` — Hover over elements

### Advanced
- `browser_evaluate` — Execute JavaScript in page context
- `browser_handle_dialog` — Handle alert/confirm/prompt dialogs
- `browser_file_upload` — Upload files
- `browser_window` — Resize, minimize, maximize browser window
- `browser_pdf_save` — Save page as PDF
- `browser_performance_metrics` — Get performance metrics
- `browser_verify_text_visible` — Verify text is present
- `browser_verify_element_visible` — Verify element exists

### Network
- `browser_network_requests` — Monitor, inspect, filter, and replay network requests

### Extensions
- `browser_list_extensions` — List installed browser extensions
- `browser_reload_extensions` — Reload unpacked extensions

## Agent Chrome Profile

The agent runs in a dedicated Chrome profile at `~/.firtal-browser/profiles/`. This means:

- Your normal Chrome is untouched
- The agent has its own window
- Sessions persist between runs (log in once)
- You can have multiple profiles: `./scripts/setup-profile.sh my-profile-name`

To relaunch the agent browser later:
```bash
./scripts/setup-profile.sh  # uses default "firtal-agent" profile
```

## Configuration

```bash
# Custom WebSocket port (default: 5555)
node server/cli.js --port 8080

# Debug mode
node server/cli.js --debug
```

## How it works

```
AI Assistant (Claude Code, Cursor, etc.)
    │
    │ MCP Protocol (stdio)
    ↓
Firtal Browser MCP Server (this repo, Node.js)
    │
    │ WebSocket (localhost:5555)
    ↓
Firtal Browser Extension (in agent Chrome)
    │
    │ Browser Extension APIs
    ↓
Your browser (real profile, real sessions)
```

## Troubleshooting

**Extension won't connect:**
1. Check the extension is installed and enabled in agent Chrome
2. Click the extension icon — it should show "Connected"
3. Check the MCP server is running: `lsof -i:5555`
4. Try reloading the extension

**"Port 5555 already in use":**
```bash
lsof -ti:5555 | xargs kill -9
# or use a different port:
node server/cli.js --port 8080
```

**Session expired:**
Open the agent Chrome window and log in again. The profile remembers your sessions, but cookies do expire.

## Upstream

This is a fork of [Blueprint MCP](https://github.com/railsblueprint/blueprint-mcp).

- See [FIRTAL-CHANGES.md](FIRTAL-CHANGES.md) for all Firtal-specific changes
- See [UPSTREAM.md](UPSTREAM.md) for how to sync with upstream updates

## License

Apache License 2.0 — see [LICENSE](LICENSE)

Original work: Copyright (c) 2025 Rails Blueprint
Fork modifications: Copyright (c) 2025 Firtal
