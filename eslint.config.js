import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/.next/',
      '**/dist/',
      '**/coverage/',
      '**/next-env.d.ts',
      // Eval cases contain deliberately broken code.
      'packages/evals/dataset/',
      // Eval runner scratch space: patched case files, mid-run.
      'packages/evals/.eval-tmp/',
      // The sample site's pages are full of a11y bugs on purpose. Its config
      // is linted like everything else.
      'fixtures/sample-site/src/',
      'fixtures/sample-site/index.html',
    ],
  },
  js.configs.recommended,
  // Type-aware rules (no-floating-promises, no-misused-promises, ...) matter
  // for code that calls LLMs, the database, and GitHub.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: {
          // Root config files aren't in any workspace tsconfig.
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.tsx'],
    ...jsxA11y.flatConfigs.strict,
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  prettier,
);
