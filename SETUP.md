# Setup

This publication copy runs locally without the private pilot's accounts. Its Cloudflare identifiers are inert examples, AI and reputation lookups are off, and no production secret or private database is included.

## Local interface and tests

Install Node.js 24, then run these commands from the repository root:

```sh
npm ci
```

Copy `.dev.vars.example` to `.dev.vars` if it does not already exist. Retain `ENVIRONMENT=development`, `LIVE_AI_ENABLED=false` and `WEB_RISK_ENABLED=false` for local checks without provider calls.

```sh
npm run db:local
npm run build
npm run dev
```

Visit `http://127.0.0.1:5173`. The interface uses the local API on port 8787. Stop the processes with Ctrl+C. Local checks can demonstrate the interface and deterministic evidence; they do not produce a complete AI assessment.

```sh
npm test
npm run typecheck
node evaluation/validate.mjs
node evaluation/validate-stress.mjs
```

The automated suite and structural validators do not call live AI providers. The committed synthetic images are the reference pixels; optional fixture-generation scripts require their original fonts and rendering dependencies.

## Optional live services

Live evaluation is a separate experiment with provider accounts, explicit spending controls and synthetic inputs. Keep credentials only in `.dev.vars` locally or your hosting provider's server-side secret store. Never put them in a `VITE_` variable, source file, browser code or commit.

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Authorises the extraction and review model calls |
| `CONTINUATION_SECRET` | A separate random secret of at least 32 characters for signed clarification state |
| `LIVE_AI_ENABLED` | Explicitly enables the model stages when set to `true` |
| `GOOGLE_WEB_RISK_API_KEY` | Optional reputation provider credential |
| `WEB_RISK_ENABLED` | Enables eligible, consented Web Risk requests when set to `true` |

Model snapshots and request bounds are defined in `server/`. Screenshot submission requires the application's image decode/re-encode service; copying a key alone does not configure that service. Provider availability, processor retention terms and current charges must be checked before any new live run. The historical pilot's allowance and account arrangements do not transfer to a clone of this repository.

## A separate private deployment

Source publication does not deploy the app. Any new deployment needs the operator's own Cloudflare Worker, D1 database and Images binding, plus Access protection and a reviewed allowlist. Replace the example identifiers in `wrangler.jsonc` and the matching deployment boundary in `release/staging.mjs`; retain authentication, bounded accounting and all release checks. Do not substitute private pilot identifiers from another record.

The default configuration is intentionally for local development. Never expose the development authentication mode publicly. Configure the production environment, protect production and candidate URLs, apply migrations to your own database, and review processor/privacy arrangements before collecting any live evaluation evidence.

`npm run release:check` runs without deployment or AI calls. It should fail for this publication snapshot: retained evidence describes a different historical source fingerprint and already contains a critical finding. Follow [RELEASE.md](RELEASE.md) to understand the required evidence. Changing hashes on old captures or bypassing the gate is not a valid deployment procedure.

The current screenshot interpretation failure is documented in [docs/EVALUATION.md](docs/EVALUATION.md). Fixes and new matching evaluation are prerequisites to relying on the app's advice.
