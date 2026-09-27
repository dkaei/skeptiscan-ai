# SkeptiScan AI

SkeptiScan AI is a research prototype that examines a suspicious message, a written call account, a link or a screenshot and explains a practical next step. It separates the supplied material, the requested action, supporting observations and uncertainty. It does not authenticate a sender or provide a numerical safety score.

This repository publishes the implementation, automated tests and synthetic evaluation evidence. The application was developed as a **private pilot**; publishing its source does not open that pilot to the public or establish readiness for public reliance.

**Current research finding:** the evaluated private candidate passed **1,523 automated tests**, but its completed regression evaluation failed the release requirements. Among **68 AI cases**, 56 returned a complete API result, 55 met the accepted-completion criteria and 44 met every workflow criterion. **SS03 exposed a critical screenshot interpretation error. Release remained blocked.** The separate local rejection control passed. See [evaluation results and limitations](docs/EVALUATION.md).

## Academic context

**4 CM3020 Artificial Intelligence**  
**4.1 Project Idea 1: Orchestrating AI models to achieve a goal**

The project investigates whether bounded model orchestration can turn uncertain submitted material into useful advice while preserving the distinction between interpretation and supporting evidence. The academic report follows six chapters: Introduction, Literature Review, Design, Implementation, Evaluation and Conclusion.

## Run locally

Use **Node.js 24 and npm**. Install the pinned dependency graph from this directory:

```sh
npm ci
```

Copy [`.dev.vars.example`](.dev.vars.example) to `.dev.vars` **if that file does not already exist**. The example selects local development with AI and external reputation lookups disabled. Existing local settings may enable those services, so inspect your own configuration before running.

Then initialise the local database and start the application:

```sh
npm run db:local
npm run build
npm run dev
```

Open **http://127.0.0.1:5173**. Vite serves the interface on port 5173 and Wrangler serves the local API on port 8787. Stop both processes with Ctrl+C. No provider key is required for the default local interface and offline checks. A complete AI assessment requires separately configured services.

The public deployment configuration uses placeholders. A deployment needs the operator's own Cloudflare Worker, D1 database, Images binding, Access configuration and server-side secrets; live model calls also require an OpenAI API account. Google Web Risk is optional and requires separate configuration. Keep credentials in local secret files or the hosting platform's secret store, never frontend code or Git. [SETUP.md](SETUP.md) and [REPUTATION-SETUP.md](REPUTATION-SETUP.md) describe these boundaries.

## Verify the implementation

```sh
npm test
npm run typecheck
npm run build
node evaluation/validate.mjs
node evaluation/validate-stress.mjs
```

These checks do not perform a live model evaluation. Tests exercise controlled inputs, mocks and local runtimes; the two evaluation validators check reference structure. Passing them does not establish useful or correct AI advice.

```sh
npm run release:check
```

This runs the release checks without deploying or calling an AI model. A nonzero result is expected when current, compatible evaluation evidence is missing or fails policy. Neither `release:prepare` nor a successful build constitutes release approval. See [the release workflow](RELEASE.md) and [gate policy](release/policy.json).

## How it works

The React/TypeScript interface sends a bounded request to a Hono API on Cloudflare Workers. The server authenticates and validates the request, reserves allowance in D1 and prepares an image when supplied. It then coordinates two sequential model calls:

1. **Extraction:** `gpt-5.4-mini-2026-03-17` identifies entities, actions, quotations and missing context.
2. **Evidence checks:** server code validates structure and source quotations, analyses URL structure and, when explicitly requested and eligible, obtains a bounded Web Risk observation.
3. **Review:** `gpt-5.4-2026-03-05` receives the original submitted text or normalised image, user context, extraction and evidence. Server policy validates the returned rationale and constructs the displayed advice.

One permitted clarification can trigger one additional review call. There is no repeated extraction, automatic generation retry or autonomous browsing loop. Failed validation can stop the workflow with an incomplete result. Returned usage is accounted for even when output validation fails.

| Path | Responsibility |
| --- | --- |
| [`src/`](src/) | Interface, transient drafts, local image preparation and API client |
| [`server/`](server/) | Authentication, orchestration, evidence, image processing and accounting |
| [`shared/contracts.ts`](shared/contracts.ts) | Validated request/result schemas and action definitions |
| [`migrations/`](migrations/) | D1 schema and bounded operational-state migrations |
| [`public/`](public/) | Local assets, font notices, manifest and response headers |
| [`tests/`](tests/) | Automated checks and synthetic fixtures |
| [`evaluation/`](evaluation/) | Frozen references, image fixtures, captures and semantic reviews |
| [`release/`](release/) | Evidence validation, fingerprinting and release safeguards |

## Evidence and publication provenance

The reported live results belong to a recorded **private candidate fingerprint**, not automatically to this public export. Replacing deployment identifiers and preparing public configuration changes covered source files and therefore creates a new source fingerprint. Historical captures remain research evidence; they must not be relabelled as approval for the export or a future deployment.

The original reference JSON and image fixtures retain their versioned provenance. Migrations preserve schema history: the later admission-override migrations extend the bounded schema and copy existing rows; they do not activate a lease. The [frozen reference plan](verification/evaluation-completion-2026-09-27/reference-plan.json) is retained because the release tooling depends on it. Details and reproduction boundaries are in [docs/EVALUATION.md](docs/EVALUATION.md).

## Limits and privacy

The evidence is synthetic, AI-authored and AI-reviewed; all final cases had been used previously. There was no participant study, untouched holdout or component ablation. Screenshot interpretation remains a material weakness. The current interface is English-only, and accessibility measures have not established accessibility conformance.

The application has no saved-case database, service worker, offline analysis, public report feed or connected phone-reputation service. Drafts and results remain in browser memory until reload. D1 stores operational accounting rather than submitted messages, images or model responses. Live checks still transmit submitted material to configured processors, so this is not an on-device-only or guaranteed zero-retention service. A Web Risk no-match result does not prove safety.

## Licence status

The source is publicly available for viewing and academic inspection. **A project-code licence has not been selected.** Bundled fonts retain their own notices: [Inter](public/assets/Inter-OFL.txt) and [Plus Jakarta Sans](public/assets/Plus-Jakarta-Sans-OFL.txt). Dependency licences remain those of their respective packages; public visibility does not assign one licence to the whole project.
