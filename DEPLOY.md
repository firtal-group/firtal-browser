# Deploy

`firtal-browser` is distributed through GitHub and npm. There is no automatic
production deploy from this repository.

## Release Branch

- Development and pull requests target `main`.
- Runtime-stability work may live on feature branches until reviewed.
- Publishing is done from a tagged release after tests pass.

## CI/CD

- GitHub Actions runs the publish workflow for npm releases.
- Local verification before review:
  - `cd server && npm test -- --runInBand`
  - targeted CLI smoke checks for changed runtime commands

## Review And Deploy Ownership

- Code review and QA: Tine or Karlotta.
- Release/deploy approval: Sara for user-facing or runtime-risk changes.

## Deploy Verification

After release or local rollout, verify:

- `node server/cli.js auto-launch --profile <profile> --remote-debugging-port <port> --output json`
- `node server/cli.js health --profile <profile> --output json`
- `node server/cli.js tunnel start --profile <profile> --port <port> --output json`
- The returned authed tunnel URL opens a browser-control UI from a separate browser session.

## Rollback

- Stop runtime processes with `node server/cli.js tunnel stop --profile <profile>` and watchdog stop if active.
- Reinstall the previous npm/GitHub release or revert the merge commit.
- If a tunnel token leaked, stop the tunnel; tokens are per tunnel session.
