# Firtal Browser

> Give Firtal AI agents access to your real Chrome browser with all your logged-in sessions

Fork of [Blueprint MCP](https://github.com/railsblueprint/blueprint-mcp) (Apache 2.0).

## What is this?

An MCP server + Chrome extension that lets AI agents control your actual browser. Unlike headless automation, this uses your real browser profile with all your logged-in sessions, cookies, and extensions intact.

**Use case:** Your AI agent needs to read a Looker Studio dashboard, check Shopify admin, or browse a supplier portal — and you're already logged in.

## Quick Start

### Option 1: Double-click (easiest)

Double-click `Firtal Browser.command` in the repo folder. First time it runs setup automatically. After that it just launches agent Chrome.

You can drag the file to your desktop or Dock for quick access.

### Option 2: Terminal

```bash
cd server && npm install
node cli.js setup
```

Both options do the same thing:
1. Build the Chrome extension
2. Create a dedicated agent Chrome profile
3. Open agent Chrome with the extension installed
4. Print the MCP config to copy-paste into your AI client

**Log into your services** (Looker Studio, Shopify, GA4, etc.) in the agent Chrome window that opens. Sessions are saved automatically.

## After Setup

### Relaunch agent Chrome

Double-click `Firtal Browser.command` again, or:

```bash
node server/cli.js launch
```

Your sessions are remembered — no need to log in again.

### Add as MCP tool

The setup command prints the config for your AI client. Here it is again:

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

### Use it

1. Agent Chrome is running (extension icon shows "Connected")
2. Ask your AI to browse:

```
"Go to our Looker Studio dashboard and tell me what charts are on this page"
"Read the Shopify admin orders page"
"Take a screenshot of this supplier portal"
```

## CLI Reference

| Command | What it does |
|---------|-------------|
| `node cli.js setup` | First-time setup: build, create profile, launch Chrome |
| `node cli.js launch` | Relaunch agent Chrome with saved sessions |
| `node cli.js serve` | Start MCP server (default, used by AI clients) |
| `node cli.js serve --debug` | Start MCP server with verbose logging |
| `node cli.js serve --port 8080` | Use custom WebSocket port (default: 5555) |

## Available Tools

### Connection
| Tool | Description |
|------|-------------|
| `enable` | Activate browser automation (required first step) |
| `disable` | Deactivate browser automation |
| `status` | Check connection status |

### Tabs & Navigation
| Tool | Description |
|------|-------------|
| `browser_tabs` | List, create, attach to, or close tabs |
| `browser_navigate` | Navigate to a URL |
| `browser_navigate_back` | Go back in history |

### Reading Pages
| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get accessible page content (best for reading pages) |
| `browser_take_screenshot` | Capture visual screenshot |
| `browser_extract_content` | Extract page content as markdown |
| `browser_console_messages` | Get browser console logs |
| `browser_network_requests` | Monitor, inspect, filter, and replay network requests |

### Interaction
| Tool | Description |
|------|-------------|
| `browser_interact` | Perform multiple actions in sequence (click, type, hover, wait) |
| `browser_click` | Click on elements |
| `browser_type` | Type text into inputs |
| `browser_fill_form` | Fill multiple form fields at once |
| `browser_select_option` | Select dropdown options |
| `browser_press_key` | Press keyboard keys |
| `browser_drag` | Drag and drop elements |
| `browser_hover` | Hover over elements |

### Advanced
| Tool | Description |
|------|-------------|
| `browser_evaluate` | Execute JavaScript in page context |
| `browser_handle_dialog` | Handle alert/confirm/prompt dialogs |
| `browser_file_upload` | Upload files |
| `browser_window` | Resize, minimize, maximize browser window |
| `browser_pdf_save` | Save page as PDF |
| `browser_performance_metrics` | Get performance metrics |
| `browser_verify_text_visible` | Verify text is present |
| `browser_verify_element_visible` | Verify element exists |
| `browser_list_extensions` | List installed browser extensions |
| `browser_reload_extensions` | Reload unpacked extensions |

## Agent Chrome Profile

The agent runs in a dedicated Chrome profile at `~/.firtal-browser/profiles/`. This means:

- Your normal Chrome is untouched
- The agent has its own window
- Sessions persist between runs (log in once)
- Named profiles: `node cli.js setup --profile my-other-profile`

## How it works

```
AI Assistant (Claude Code, Cursor, etc.)
    |
    | MCP Protocol (stdio)
    v
Firtal Browser MCP Server (Node.js)
    |
    | WebSocket (localhost:5555)
    v
Firtal Browser Extension (in agent Chrome)
    |
    | Browser Extension APIs
    v
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
node server/cli.js serve --port 8080
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
