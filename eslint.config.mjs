import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // Too many existing instances to fix now
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    rules: {
      'no-unused-vars': 'off', // Handled by typescript-eslint for ts files, but public js might need a different approach
    },
  },
  {
    ignores: [
      'node_modules/',
      '.wrangler/',
      'dist/',
      'coverage/',
      'worker-configuration.d.ts',
      'public/users/power-strip.js', // Existing legacy JS
    ],
  },
];
