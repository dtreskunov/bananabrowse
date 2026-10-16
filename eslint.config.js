import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import noCatchAll from 'eslint-plugin-no-catch-all';

export default [
  { ignores: ['**/node_modules/', '**/dist/', '**/.browser-artifacts/', '**/test-results/', '**/playwright-report/'] },
  { files: ['**/*.{js,mjs,cjs,ts,tsx}'] },
  { languageOptions: { globals: globals.node } },
  {
    files: ['domagent-extension/src/**', 'domagent-extension/ui/src/**', 'domagent-extension/test/browser/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, ...globals.node } },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
