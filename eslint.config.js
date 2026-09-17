/**
 * Lint for mistakes, not for style. The rules here are the ones that catch a real bug — a name that does not exist, a variable
 * assigned and never read, a promise nobody waits for — and nothing that argues about how the code is laid out.
 */
import js from '@eslint/js';
import globals from 'globals';
import typescript from 'typescript-eslint';

export default [
  { ignores: ['dist/', 'node_modules/', '.perch/'] },
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // An argument that goes unused is often a signature that drifted; one named with a leading _ is deliberate. The base rule
      // is off because typescript-eslint's covers both languages, and leaving both on reports every finding twice.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-async-promise-executor': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'array-callback-return': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['test/**'],
    languageOptions: { globals: { ...globals.node } },
    // A fixture is allowed to hold a GitHub Actions expression, which is a ${{ }} the shell never sees.
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-template-curly-in-string': 'off' },
  },
];
