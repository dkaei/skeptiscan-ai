# Evaluation evidence and reproducibility

This document separates the recorded private-candidate results from checks that can be repeated on the public source export. The evidence supports analysis of this implementation's behaviour; it does not establish real-world scam-detection accuracy or readiness for public reliance.

## Recorded outcome

The final private-candidate regression run on **27 September 2026** reviewed all **69 roster cases**: 68 AI cases and one local rejection control. All final cases had been used previously. Names such as `fresh_text` in the historical policy describe exposure at an earlier stage; they do not make this final run a fresh holdout.

| Measure | Recorded result | Interpretation |
| --- | ---: | --- |
| Automated tests | 1,523 passed | Controlled software checks for the evaluated private candidate |
| Complete API results | 56/68 | Operational completion, without assuming correctness |
| Partial API results | 12/68 | Incomplete assessments; not automatically successful abstentions |
| Gate-accepted completions | 55/68 | Completion accepted under the case-specific reference rules |
| Full workflow matches | 44/68 | Every required action, explanation, clarification and critical check passed |
| Local rejection control | 1/1 | Separate from the AI denominator |
| Critical case | SS03 | Fabricated consequential evidence; release blocked |

S05 returned a complete result when its frozen reference required abstention, explaining the difference between 56 API completions and 55 accepted completions. The final gate also failed cohort thresholds. Production was not promoted by this run.

| AI cohort | Cases | Accepted completions | Full workflow matches |
| --- | ---: | ---: | ---: |
| Known text regressions | 4 | 4/4 | 4/4 |
| Standard text | 33 | 33/33 | 27/33 |
| Standard screenshots | 5 | 3/5 | 3/5 |
| Stress text | 20 | 14/20 | 9/20 |
| Stress screenshots | 6 | 1/6 | 1/6 |
| **Total** | **68** | **55/68** | **44/68** |

These are descriptive fractions from unequal, correlated synthetic cohorts. They are not estimates of population performance. The [final evidence index](../evaluation/release-evidence.json) links case captures and reviews; [the gate policy](../release/policy.json) defines the acceptance rules and critical categories.

## What SS03 demonstrated

The screenshot said **“Do not send the code to this chat.”** Extraction preserved the negative instruction in a quotation but also produced the affirmative action label **“send the sign-in code to this chat”**. The controller stopped the assessment as partial after extraction, before dispatching the reviewer. Protective main advice did not correct the false attribution still displayed in extracted evidence.

This is a critical semantic error, even though exact quotation matching and conservative main advice were present. Source-span equality can establish that words occur in a source; it cannot prove that an interpretation preserves their meaning. The case must remain visible in any summary of this run.

## Reproduce offline checks

Use Node.js 24 and install from the committed lockfile:

```sh
npm ci
npm test
npm run typecheck
npm run build
node evaluation/validate.mjs
node evaluation/validate-stress.mjs
```

Run these commands from the repository root. They do not call live models or require the private pilot's credentials. The test suite uses mocks and local runtimes; evaluation validators check structure, identifiers and reference compatibility. They cannot independently reproduce the semantic review or prove that a model generated a recorded result.

To inspect release blockers without deploying:

```sh
npm run release:check
```

The full release gate requires matching source, policy, fixtures and reviewed evidence, including freshness limits. A failed check is the expected outcome for incompatible, stale or failing evidence. Preparing a candidate only records fingerprints and an unattempted template. Do not manufacture passing evidence or update hashes on old observations to make them appear current.

## Required reference and fixture provenance

The historical references are retained as versioned records:

- [`heldout-v1.json`](../evaluation/heldout-v1.json) and [`invalid-input-v1.json`](../evaluation/invalid-input-v1.json): text scenarios and separate malformed-input controls.
- [`screenshot-specs-v1.json`](../evaluation/screenshot-specs-v1.json) and [`fixtures/`](../evaluation/fixtures/): standard image specifications, realised pixels and manifests.
- [`stress-v1.json`](../evaluation/stress-v1.json), [`stress-v2.json`](../evaluation/stress-v2.json), [`stress-screenshot-specs-v1.json`](../evaluation/stress-screenshot-specs-v1.json) and [`stress-fixtures/`](../evaluation/stress-fixtures/): explicitly versioned stress references and images.
- [`reference-plan.json`](../verification/evaluation-completion-2026-09-27/reference-plan.json): selected roster, frozen decisions and exposure notes used by the release manifest.
- [`release-captures/`](../evaluation/release-captures/): retained synthetic captures and reviews. Some automated regressions explicitly read earlier captures, so these are not interchangeable with the final evidence index.

Creation-time status fields in frozen JSON describe their original preparation. Later execution does not justify silently rewriting those files. [The release manifest](../release/manifest.mjs), [file fingerprints](../release/files.mjs) and policy bind reference bytes and screenshot pixels. Changing a label or regenerating an image creates different evidence.

The fixture generators are retained under [`scripts/`](../scripts/), with test-fixture generation details in [`tests/fixtures/README.md`](../tests/fixtures/README.md). Their original rendering environment used system fonts. Use the committed images when checking recorded hashes; rendering with another font or rasteriser may change pixels even if visible words appear unchanged.

All seven [`migrations/`](../migrations/) are part of the code history. The later admission-override migrations modify the bounded schema without activating an operator allowance. Private databases, activation scripts, access attestations and ledger snapshots are not needed to initialise a clean local test database.

## Public export versus evaluated candidate

The live results refer to the private candidate recorded in its captures. Public packaging replaces deployment identifiers and prepares configuration for another operator. Because the fingerprint covers deployment configuration and release source, the export has a **new source fingerprint** even when application behaviour is intended to remain equivalent.

Retained historical hashes describe historical artifacts. They are not approval for this export, and a newly created Git commit is not the original evaluated revision. Any later deployment needs its own reviewed configuration and current matching evidence under the release policy. Public source publication does not itself deploy the application or authorise new paid evaluation calls.

## Limits of the evidence

The references and reviews were AI-authored rather than independent human ground truth. Cases are synthetic, related scenarios are correlated, and the final roster is a reused regression set. No participant study, component ablation, representative population sample or independent transcription benchmark was completed. The test count measures software checks, not scam-detection quality.

A separate consented Google Web Risk integration check exercised an eligible public-homepage lookup and returned `no_match`. It was outside the 68-case evaluation and does not measure malicious-link detection accuracy. No reported-phone feed or sender-authentication service is connected.

Captured outcomes can be inspected and reviewed again, but rerunning a model may produce different outputs. Model availability, external services and operational configuration are additional dependencies. Reproduction should distinguish repeatable offline checks, auditable historical results and a new live experiment.
