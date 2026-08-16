import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['coverage/**', 'node_modules/**', 'storage/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Unused symbols are errors, but an underscore prefix marks intent.
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Logging goes through the pino logger so records stay structured and
      // correlatable; stray console calls bypass redaction and request ids.
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read configuration through src/config/env.js so every value is validated at boot.',
        },
      ],
    },
  },
  {
    // Config loading and entrypoints are the only places allowed to touch the
    // raw environment or write to stdout directly.
    files: ['src/config/**/*.js', 'src/entrypoints/**/*.js', 'eslint.config.js', '*.config.js'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.js'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
  prettier,
];
