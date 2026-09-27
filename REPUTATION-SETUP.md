# Reputation evidence

The application combines local URL analysis with an optional external reputation observation. It does not visit arbitrary submitted sites, follow their redirects or establish who owns an account.

## Local domain analysis

Local checks examine the supplied address, host structure, international characters and a small reviewed host directory. A listed host is not proof that a caller is authentic or that a payment request is appropriate. An unlisted host remains unknown rather than automatically malicious.

## Optional Google Web Risk

Set `GOOGLE_WEB_RISK_API_KEY` privately and explicitly enable `WEB_RISK_ENABLED` only in an appropriately configured environment. No provider credential is published here. The app requires user opt-in and accepts only eligible public-homepage origins for the external check, reducing disclosure of private paths and query parameters.

The result distinguishes a threat-list match, no match, an unsupported input, a check that was not requested and a provider that was unavailable. A no-match response means no listed threat was returned for that lookup; it does not certify a site or its surrounding request as safe. The implementation and tests in `server/` and `tests/` define the exact eligibility, request limits and result handling.

The separate historical end-to-end lookup returned no match. It demonstrates one connected workflow, not detection accuracy. No new provider calls are needed to run the offline test suite.

## Phone numbers

Phone-number formatting and extraction are implemented. No Singapore reported-number database is connected, and the application must not claim a number was checked against such a database. A future licensed feed would need explicit provenance, coverage and freshness, reliable failure states, and evaluation of how its evidence changes advice.
