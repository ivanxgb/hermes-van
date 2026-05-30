# CI activation

The Hermes-Van CI workflow lives at `deploy/ci/ci.yml.proposed` instead
of `.github/workflows/ci.yml` because the PAT this repo was bootstrapped
with doesn't carry the `workflow` scope. Pushing files under
`.github/workflows/` requires that scope, so we keep the proposed
config versioned here and you activate it manually from a session that
holds the right credentials.

## What it does

Three jobs, gated sequentially:

1. **lint-typecheck** — `pnpm typecheck` (ESLint is declared in
   `package.json` but not installed yet; the lint step is commented out
   until that's fixed).
2. **unit** — `pnpm test` (Vitest, 84 tests). Seeds a CI `.env` with
   ephemeral random keys so the SQLCipher backup test can run.
3. **e2e** — `pnpm test:e2e` (Playwright Chromium, 47 tests). Uses
   `actions/cache` for browsers. `continue-on-error: true` because some
   e2e specs hit the live Hermes gateway and CI doesn't have one — those
   need stubbing before the job becomes a hard gate.

## How to activate

Once. From a shell where the GitHub CLI / git credentials carry the
`workflow` scope:

```bash
mkdir -p .github/workflows
cp deploy/ci/ci.yml.proposed .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "chore(ci): activate proposed CI workflow"
git push
```

GitHub will pick up the workflow on the next push.

## Updating the workflow later

Edit `deploy/ci/ci.yml.proposed` (versioned, no scope needed). When you
want to roll the change out, copy it over `.github/workflows/ci.yml`
from a workflow-scoped session.

## Why two locations

It's annoying, but the alternative is rotating PATs every time we touch
CI. Keeping the source of truth in `deploy/ci/` means any session can
review and patch the CI config; only the activation moment needs the
elevated token.

## Pending hardening

- Wire up `eslint` properly and uncomment the lint step
- Stub `/v1/runs/*` for e2e or split specs into gateway-dependent vs
  gateway-independent so the e2e job can be a hard gate
- Add a coverage upload step (`@vitest/coverage-v8` is already in
  `devDependencies`)
