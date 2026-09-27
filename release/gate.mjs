// No cached receipt authorizes deployment. Each invocation performs every check.
export async function runReleaseGate({ mode, steps }) {
  if (!['stage', 'check', 'deploy'].includes(mode)) throw new Error('Unknown release mode.');
  const staging = mode === 'stage';
  const report = { schemaVersion: 1, mode, startedAt: new Date().toISOString(), passed: false, deploymentAttempted: false,
    candidateUploadAttempted: false, candidateUploaded: false, checks: {}, issues: [] };
  try {
    const initial = await steps.snapshot();
    report.candidateHash = initial.candidateHash;
    report.policyHash = initial.policyHash;
    const required = staging ? ['environment', 'privateAccess', 'safeguards', 'build', 'package'] : ['environment', 'safeguards', 'build', 'package', 'evaluation'];
    for (const name of required) {
      try {
        const check = await steps[name](initial);
        report.checks[name] = check;
        if (check?.passed !== true) report.issues.push(...(check?.issues?.length ? check.issues : [`${name} did not pass.`]));
      } catch {
        // Raw exception text can contain response bodies or environment values.
        report.checks[name] = { passed: false, issues: [`${name} could not be verified. Inspect its local diagnostic file.`] };
        report.issues.push(...report.checks[name].issues);
      }
      if (['environment', 'privateAccess'].includes(name) && report.issues.length) break;
    }
    const current = await steps.snapshot();
    if (JSON.stringify(initial) !== JSON.stringify(current)) report.issues.push('Release inputs changed while checks were running.');
    const integrity = await steps.integrity();
    report.checks.integrity = integrity;
    if (integrity?.passed !== true) report.issues.push(...(integrity?.issues?.length ? integrity.issues : ['Build integrity was not verified.']));
    report.passed = report.issues.length === 0;
    await steps.writeReport(report);
    if (mode === 'deploy' && report.passed) {
      // Recheck after writing the receipt, immediately before dispatch.
      if (JSON.stringify(initial) !== JSON.stringify(await steps.snapshot()) || (await steps.integrity()).passed !== true) {
        report.passed = false;
        report.issues.push('Release inputs changed before deployment.');
      } else {
        report.deploymentAttempted = true;
        const result = await steps.deploy();
        report.deploymentExitCode = result.exitCode;
        if (result.exitCode !== 0) { report.passed = false; report.issues.push('Deployment failed.'); }
      }
    }
    if (staging && report.passed) {
      const access = await steps.privateAccess(initial);
      if (JSON.stringify(initial) !== JSON.stringify(await steps.snapshot()) || (await steps.integrity()).passed !== true || access?.passed !== true) {
        report.passed = false;
        report.issues.push('Candidate inputs, build integrity or private Access verification changed before upload.');
      } else {
        report.candidateUploadAttempted = true;
        const result = await steps.uploadCandidate();
        report.candidateUploadExitCode = result.exitCode;
        if (result.exitCode !== 0 || typeof result.versionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.versionId)) {
          report.passed = false;
          report.issues.push('Candidate upload was not confirmed. Inspect the upload log and remote versions before retrying.');
        } else {
          report.candidateUploaded = true;
          report.candidateVersionId = result.versionId;
          report.versionUrlsEnabled = false;
        }
      }
    }
  } catch {
    report.passed = false;
    report.issues.push('The release gate could not finish verification. No further upload or deployment is authorized.');
  }
  report.completedAt = new Date().toISOString();
  await steps.writeReport(report);
  return report;
}
