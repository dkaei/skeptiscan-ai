// Node's native TypeScript loader does not resolve the application's
// extensionless imports. Bundle only the pure validation modules in memory,
// using the already-pinned build dependency and leaving source files untouched.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  stdin: {
    contents: `
      export {
        ActionIdSchema, CheckInputSchema, EvidenceSchema,
        EvidenceStateSchema, QuestionIdSchema,
      } from './shared/contracts.ts';
      export { inspectLinkInput } from './src/linkInput.ts';
    `,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    sourcefile: 'evaluation-validation-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  write: false,
  logLevel: 'silent',
});

const validation = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

export const {
  ActionIdSchema, CheckInputSchema, EvidenceSchema,
  EvidenceStateSchema, QuestionIdSchema, inspectLinkInput,
} = validation;
