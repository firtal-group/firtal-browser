# Firtal Changes — Upstream Merge Guide

This document tracks all Firtal-specific changes made to the Blueprint MCP fork.
Use it when merging upstream updates to identify and resolve conflicts.

## Upstream

- **Source:** github.com/railsblueprint/blueprint-mcp
- **Fork point:** v1.9.21 (main branch)
- **License:** Apache 2.0

## Change Log

### 1. Rebrand: Blueprint MCP → Firtal Browser

- **Files changed:**
  - `package.json` — name, description, repository, homepage, author
  - `server/package.json` — name, description, repository, homepage, author, bin
  - `extensions/chrome/package.json` — name, description, repository, homepage, author
  - `extensions/chrome/manifest.json` — action title, host_permissions
  - `extensions/shared/_locales/*/messages.json` — extName in all locales
- **What:** All user-visible names changed from "Blueprint MCP" to "Firtal Browser". URLs changed from railsblueprint.com to firtal.com.
- **Merge strategy:** Accept upstream changes, then re-apply rebrand via search-replace:
  ```bash
  # After merging upstream:
  find extensions/shared/_locales -name "messages.json" -exec sed -i '' 's/Blueprint MCP/Firtal Browser/g' {} +
  sed -i '' 's/Blueprint MCP/Firtal Browser/g' extensions/chrome/manifest.json
  # Then manually update package.json files
  ```

### 2. CLI: setup + launch commands
- **Files:** server/cli.js (MODIFIED)
- **What:** Added `setup` and `launch` subcommands. Default `serve` command preserved. Changed program name and description.
- **Merge strategy:** The additions are at the end of the file (new functions + command definitions). The original action handler is preserved inside `serve` subcommand. On upstream merge, re-apply the subcommand structure if cli.js conflicts.

### 3. New files (no upstream conflicts)

- **Files added:**
  - `FIRTAL-CHANGES.md` — this file
  - `UPSTREAM.md` — upstream sync process
  - `scripts/setup-profile.sh` — agent Chrome profile setup
- **Merge strategy:** Additive only — these files don't exist upstream, zero conflict risk.

## Conflict Risk Assessment

| File | Upstream change frequency | Firtal changes | Risk |
|------|--------------------------|----------------|------|
| `package.json` | Every release (version bump) | Name, description | LOW — only metadata fields |
| `server/package.json` | Every release | Name, description, bin | LOW |
| `extensions/chrome/manifest.json` | Moderate (permissions, version) | Title, host_permissions | LOW |
| `_locales/*/messages.json` | Rare | extName only | MINIMAL |
| `server/src/*` | Frequent | None yet | NONE |
| `extensions/shared/*` | Frequent | None yet | NONE |
