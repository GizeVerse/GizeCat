import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', '.claude/**', 'scripts/**', 'build/**', '*.config.mts', '*.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // core/ and shared/ are pure logic: no Electron, no Node built-ins, no DOM-only modules.
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*', 'node:*', 'fs', 'path', 'os', 'child_process', 'koffi'], message: 'core/shared must stay platform-agnostic.' },
            { group: ['**/main/**', '**/renderer/**', '**/preload/**'], message: 'core/shared must not depend on process-specific code.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*', 'node:*', 'koffi'], message: 'Renderers are sandboxed: use the preload API.' },
            { group: ['**/main/**'], message: 'Renderers must not import main-process code.' },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
