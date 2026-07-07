/**
 * @fileoverview ESLint flat config enforcing the mechanical parts of the
 * Google JavaScript Style Guide (2-space indent, single quotes, semicolons,
 * 80-column lines, trailing commas, camelCase, etc.) via @stylistic. The
 * canonical `eslint-config-google` package is unmaintained and incompatible
 * with ESLint 9, so its conventions are reproduced here.
 */

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';

/** Google-style stylistic rules shared by all files. */
const googleStyle = {
  '@stylistic/indent': ['error', 2, {SwitchCase: 1}],
  '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
  '@stylistic/semi': ['error', 'always'],
  '@stylistic/comma-dangle': ['error', 'always-multiline'],
  '@stylistic/object-curly-spacing': ['error', 'never'],
  '@stylistic/arrow-parens': ['error', 'always'],
  '@stylistic/space-before-function-paren': ['error', {
    anonymous: 'never',
    named: 'never',
    asyncArrow: 'always',
  }],
  '@stylistic/max-len': ['error', {
    code: 80,
    tabWidth: 2,
    ignoreUrls: true,
    ignoreRegExpLiterals: true,
    ignoreTemplateLiterals: true,
    ignorePattern: '^\\s*// @',
  }],
  'camelcase': ['error', {properties: 'never'}],
  'prefer-const': 'error',
  'no-var': 'error',
};

export default [
  js.configs.recommended,
  {
    plugins: {'@stylistic': stylistic},
    rules: googleStyle,
  },
  {
    // The userscript runs in the browser as a classic script.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        // `module` is declared via a /* global */ comment in the source so the
        // Node export path also passes Tampermonkey's built-in linter.
      },
    },
  },
  {
    // Tests and the fetch mock are ES modules running under Node.
    files: ['test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        globalThis: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
];
