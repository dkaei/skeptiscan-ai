import path from 'node:path';
import { portable } from './files.mjs';

export function evaluateSafeguards({ report, exitCode, startedAt, finishedAt, root, expectedFiles, minimumTests = 608, requiredTests = [] }) {
  const issues = [];
  if (exitCode !== 0) issues.push(`Safeguard process exited with code ${exitCode ?? 'unknown'}.`);
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { passed: false, issues: [...issues, 'Safeguard report is missing or malformed.'] };
  if (report.success !== true) issues.push('Safeguard report is not successful.');
  if (!Number.isFinite(report.startTime) || report.startTime < startedAt - 1000 || report.startTime > finishedAt) issues.push('Safeguard report is stale or future-dated.');
  for (const key of ['numTotalTests', 'numPassedTests', 'numTotalTestSuites', 'numPassedTestSuites']) {
    if (!Number.isInteger(report[key]) || report[key] <= 0) issues.push(`Invalid ${key}.`);
  }
  for (const key of ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']) {
    if (report[key] !== 0) issues.push(`${key} must be zero (received ${report[key] ?? 'missing'}).`);
  }
  if (report.numPassedTests !== report.numTotalTests || report.numPassedTestSuites !== report.numTotalTestSuites) issues.push('Safeguard totals do not reconcile.');
  if (report.numTotalTests < minimumTests) issues.push(`Safeguard coverage dropped below ${minimumTests} tests.`);
  if ((report.numRuntimeErrorTestSuites ?? 0) !== 0 || (report.unhandledErrors && (!Array.isArray(report.unhandledErrors) || report.unhandledErrors.length))) issues.push('Safeguard runtime errors were reported.');
  if (report.snapshot?.failure || report.snapshot?.unmatched || report.snapshot?.unchecked || report.snapshot?.didUpdate) issues.push('Snapshots were failing, unchecked, or updated during release.');
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const seen = new Set();
  const seenTests = new Set();
  let assertions = 0;
  const failures = [];
  for (const suite of results) {
    const name = typeof suite.name === 'string' ? portable(path.relative(root, suite.name)) : '';
    if (!expectedFiles.includes(name) || seen.has(name)) issues.push('Unexpected or duplicate safeguard test file.');
    seen.add(name);
    if (suite.status !== 'passed') issues.push(`Safeguard file failed: ${name}`);
    if (!Array.isArray(suite.assertionResults) || !suite.assertionResults.length) issues.push(`Empty safeguard file: ${name}`);
    for (const assertion of Array.isArray(suite.assertionResults) ? suite.assertionResults : []) {
      assertions++;
      seenTests.add(`${name}\n${assertion.fullName}`);
      if (assertion.status !== 'passed' || !Array.isArray(assertion.failureMessages) || assertion.failureMessages.length !== 0) {
        failures.push({ file: name, test: assertion.fullName, status: assertion.status });
      }
    }
  }
  if (failures.length) issues.push(`${failures.length} safeguard assertions did not pass.`);
  if (assertions !== report.numTotalTests) issues.push('Assertion count differs from reported test count.');
  for (const name of expectedFiles) if (!seen.has(name)) issues.push(`Missing safeguard file: ${name}`);
  for (const suite of requiredTests) for (const name of suite.names) {
    if (!seenTests.has(`${suite.file}\n${name}`)) issues.push(`Required safeguard is missing: ${suite.file}: ${name}`);
  }
  if (!expectedFiles.length) issues.push('No safeguard files discovered.');
  return { passed: issues.length === 0, issues, total: report.numTotalTests, passedCount: report.numPassedTests, failedCount: report.numFailedTests, failures };
}
