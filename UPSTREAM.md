# Upstream Sync Process

## Setup (one-time)

The fork was created with `gh repo fork` which automatically configured the `upstream` remote.

Verify:
```bash
git remote -v
# origin    https://github.com/firtal-group/firtal-browser.git (fetch)
# upstream  https://github.com/railsblueprint/blueprint-mcp.git (fetch)
```

If `upstream` is missing:
```bash
git remote add upstream https://github.com/railsblueprint/blueprint-mcp.git
```

## Sync Process

1. **Fetch upstream**
   ```bash
   git fetch upstream
   ```

2. **Check diff size**
   ```bash
   git diff upstream/main..HEAD --stat
   ```

3. **Merge**
   ```bash
   git checkout main
   git merge upstream/main
   ```

4. **Resolve conflicts using FIRTAL-CHANGES.md**
   - Open `FIRTAL-CHANGES.md` for file-by-file merge strategies
   - Re-apply rebrand if locale/manifest files conflicted

5. **Test**
   ```bash
   cd server && npm test
   cd ../extensions/chrome && npm run build
   ```

6. **Tag the sync point**
   ```bash
   git tag upstream-sync-$(date +%Y-%m-%d)
   ```

7. **Update FIRTAL-CHANGES.md** if new Firtal changes were added since last sync

8. **Push**
   ```bash
   git push origin main --tags
   ```

## When to Sync

- Check upstream monthly for updates
- Sync immediately if upstream publishes security fixes
- Before starting new Firtal-specific features (to minimize divergence)
