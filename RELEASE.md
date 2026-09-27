# Publication note

This is a sanitised research snapshot. All deployment identifiers below are inert examples; no private deployment receipt is included. Historical evaluation hashes are preserved and do not approve this publication copy. Configure your own protected environment and collect fresh evidence before any deployment.

# Release gate

`npm run deploy` now runs the release gate itself. It cannot use a previous passing receipt. `npm run release:check` and `npm run deploy:check` perform the same checks without uploading. These commands do not call AI models or replenish any budget or quota.

## Required evidence

The initial pilot policy is an engineering acceptance rule, not a measured population accuracy guarantee:

- All safeguard tests pass, with no skipped, pending, focused, missing or empty test files. The full existing suite is required, including privacy, authentication, spending, timeouts, repeated submissions and adversarial cases. A zero exit code alone is insufficient.
- Every planned evaluation case has a captured first attempt and completed review against its frozen reference. Failed and timed-out attempts remain in the denominator. A later retry cannot replace a first attempt; retain it as separately labelled regression evidence.
- At least 90% operational completion and 90% workflow matches **within each** fresh-text, fresh-screenshot, stress-text and stress-screenshot group. Known-failure regressions require 100%. Rates use exact fractions, not rounded displayed percentages. Local rejection controls are required but excluded from AI completion rates.
- Zero observed critical errors across all reviewed cases. Missing reviews, unresolved findings, or unknown categories block release. Critical checks include unsafe advice, invented verification, secret requests, prompt manipulation, privacy and spending failures. This is a statement about the observed cases, not proof that future errors are impossible.
- Evaluation evidence matches the current source, pinned model configuration, policy, frozen references and screenshot pixels, and is at most seven days old. Evaluation dates in the future fail. Any covered source or policy change requires matching evidence again.
- A fresh typecheck, production build and Worker package succeed. Source, evidence, assets and bundle fingerprints must remain unchanged through the final deployment check.

The roster has 69 cases: four known-failure text regressions, 34 previously unattempted text cases (including the L09 local rejection control), five remaining screenshot cases, 20 stress texts and six stress screenshots. Previously unattempted describes their historical exposure; repeated runs must not be reported as new holdout performance. Historical baseline results and mock-provider simulations cannot substitute for current live results. The original corpora remain unchanged.

An expected abstention is reported separately from a completed assessment. It counts as correctly handled only when the reference permits it and the review confirms the specific unreadable or contradictory detail was explained. A generic provider failure is incomplete. A permitted clarification requires its declared `unsure` answer and one final result; unnecessary questions remain workflow failures.

## Workflow

1. Make the candidate changes and finish offline checks. Use Node.js 24 and the pinned dependencies installed with `npm ci`. Freeze code and references before collecting live evidence.
2. Run `npm run release:prepare`. This writes `.release-gate/candidate.json` with source/policy fingerprints, the complete manifest and an explicitly **unattempted** evidence template. It is not an evaluation run or approval.
3. If a candidate version is needed, follow the private staging lane below. Then execute the frozen cases against that candidate, using real providers and synthetic material only, through the normal authenticated workflow and existing accounting limits. Do not deploy untested production code to obtain a matching fingerprint. No separate environment is provisioned. Do not reset ledgers, change identities, or bypass daily limits to collect evidence.
4. Save sanitized captures and explicit semantic reviews under `evaluation/release-captures/`. An AI reviewer can perform the review; recruiting participants is not required. Follow [the evidence format](release/EVIDENCE.md). Keep original failed observations and do not put secrets, continuation tokens, real personal data or unsanitized headers in these files.
5. Save the completed evidence index as `evaluation/release-evidence.json`, keeping its recorded source and policy fingerprints. Never copy new hashes onto old observations. Preserve historical evaluation records separately.
6. Run `npm run release:check`. Read `.release-gate/latest.json` and the referenced per-run diagnostics. Fix blockers, freeze a new candidate when source changes, and collect any replacement evidence required by that change.
7. Run `npm run deploy`. It repeats verification, then uploads the just-checked Worker bundle and built assets only if every requirement passes. No force flag, alternate config, account, environment or argument forwarding is supported.

No passing evidence index is shipped with this change. Any failing safeguard test and incomplete current live evaluation block release. This gate does not grandfather earlier deployments.

## Private candidate upload

`npm run release:stage` is a separate upload lane for an immutable version of the **same** `skeptiscan-pilot` Worker. It freshly verifies the environment, private Access attestation, full safeguard suite, typecheck, production build, Worker package and source/build integrity. It intentionally does not require live evaluation evidence: its purpose is to supply the candidate that will be evaluated. This exception applies only to version upload. `release:check`, `deploy:check` and `deploy` still require all live evaluation and artifact checks.

The command uses installed Wrangler `versions upload` with the checked bundle, `--no-bundle`, fixed assets/config and `--strict`. It does not invoke a deployment, create another Worker, change routes, upload secrets, set variable overrides or enable Version URLs. Existing `preview_urls: false` is mandatory. The existing remote secret bindings are inherited; never change the continuation secret or identity to obtain more quota. The configuration must retain the exact existing D1, production Access audience, operator allowlist and US$7 cloud lifetime allocation. [Cloudflare Version URLs documentation](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/) describes version testing with the Worker's existing resources before production deployment.

Before upload, an operator must inspect the actual saved remote configuration and signed-out network behavior, then save `.release-gate/private-access.json`. This is a locally verified configuration attestation, not cryptographic proof or a substitute for remote checks. The application must cover **the Worker's production and version URLs**, not merely the production hostname. Record the actual observations in sanitized files under `verification/` and hash those files. Do not manufacture a receipt from this example or claim disabled Version URLs have been tested online.

```json
{
  "schemaVersion": 1,
  "purpose": "private_candidate_upload",
  "verifiedAt": "ACTUAL_UTC_VERIFICATION_TIME",
  "candidateHash": "CURRENT_PREPARED_SOURCE_SHA256",
  "policyHash": "CURRENT_PREPARED_POLICY_SHA256",
  "workerName": "skeptiscan-pilot",
  "accountId": "11111111111111111111111111111111",
  "d1DatabaseId": "11111111-1111-4111-8111-111111111111",
  "productionVersionId": "OBSERVED_CURRENT_PRODUCTION_VERSION_UUID",
  "accessApplicationId": "22222222-2222-4222-8222-222222222222",
  "accessAud": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "accessTeamDomain": "your-team.cloudflareaccess.com",
  "operatorEmail": "operator@example.invalid",
  "versionHostnamePattern": "*-skeptiscan-pilot.example.invalid",
  "accessDestinationType": "worker",
  "accessProtectsAllWorkerVersions": true,
  "workerBindingsVerified": true,
  "versionUrlsEnabled": false,
  "verifiedBy": "read_only_dashboard_and_network",
  "verificationArtifacts": [
    { "path": "verification/ACTUAL_SANITIZED_OBSERVATION.json", "sha256": "ACTUAL_FILE_SHA256" }
  ]
}
```

`versionHostnamePattern` describes the expected URL boundary; it is not a claim that an Access wildcard hostname rule was configured. Receipt age must be at most one hour, with no future timestamp. Unknown fields, another target, stale hashes, missing or changed artifacts, symlinks and oversized files fail closed. The receipt and its artifacts are rechecked immediately before upload. Preparation does not generate an attestation. Finish all source, test and policy changes before preparing the candidate and binding this receipt.

The stage report distinguishes `candidateUploadAttempted`, `candidateUploaded` and `candidateVersionId` from `deploymentAttempted`, which remains false. A success means the CLI confirmed an uploaded version ID; it does not mean the URL is reachable or the version is deployed. With routing disabled, further reviewed operational work is needed before live evaluation. Before any AI submission, verify private access and actual same-ledger accounting on the candidate; retain the existing quota and budget. Verify production still serves the recorded deployment. If the upload times out or no unique version ID is acknowledged, inspect remote versions before any manual retry—an ambiguous result may already have created a version. No automatic retry is performed.

Any later source/configuration change invalidates the frozen candidate. After candidate evaluation, production promotion still runs the complete fresh release gate. Version URL requests do not support Workers Logs or `wrangler tail`; use sanitized observed captures and the existing bounded ledger diagnostics, without treating unavailable logs as proof that no requests occurred.

## Operational details and limits

Each invocation writes a new receipt under `.release-gate/runs/`. A lock prevents simultaneous gated runs. Commands time out after five minutes; that blocks subsequent commands and retains the lock because terminating a wrapper does not prove its children stopped. After a timeout or killed process, inspect whether it or a child process is still running before removing the exact `.release-gate/active.lock` file. A failed gate exits nonzero; missing or malformed reports fail closed. Receipts do not contain secret values. Do not commit runtime receipts or share raw diagnostic logs without checking them.

The source fingerprint covers application code, tests/fixtures, public assets, migrations, release scripts, dependency lockfile and build/deployment configuration. Frozen evaluation corpora and image fixtures also have a policy fingerprint. Secret files, local D1 databases and generated reports are excluded. Unreviewed Vite/Node/Wrangler environment overrides and production `.env` files are rejected; values are never printed. Cloudflare authentication credentials are allowed solely for the deployment CLI.

The gate uses the project's installed Wrangler with an explicit config and automatic configuration disabled. A dry run packages locally. A successful deployment uses that bundle with `--no-bundle`, the checked assets and `--strict`; remote configuration conflicts therefore fail instead of being silently accepted. See [Wrangler deploy documentation](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

This protects the repository's **local deployment command**. Someone with Cloudflare credentials can still bypass it using raw Wrangler, the dashboard or API, including secret operations that publish versions. Account-wide enforcement requires protected CI and deployment permissions; neither is configured by this change. Do not describe this as an account-enforced gate.

Captures and semantic reviews are auditable evidence, not cryptographically trusted provider attestations. Hashes detect accidental drift and mismatched files; a person able to edit all code and evidence can falsify them. The gate cannot independently prove a model ran, discover every semantic error, verify provider bills, or validate remote Access policies, secret values and database state. Keep the existing post-deployment login, screenshot and result smoke checks. Never classify those checks as fresh-case performance.
