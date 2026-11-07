import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { builtinModules } from 'node:module';

// GizeVerse (ADR 0004, audit R11): src/shared is bundled into the sandboxed renderers and the web
// host, so Node built-ins (in either spelling) and Node/DOM globals must not appear there or in core.
// Exact names (paths), not patterns: a pattern 'constants' would also match './constants'.
const NODE_BUILTINS = builtinModules.filter((m) => !m.startsWith('_')).map((name) => ({ name, message: 'core/shared must stay platform-agnostic (Node built-in).' }));
const PURE_GLOBALS = ['process', 'Buffer', '__dirname', '__filename', 'require', 'module', 'global', 'setImmediate', 'clearImmediate', 'window', 'document', 'navigator', 'localStorage', 'sessionStorage'];

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', '.claude/**', 'scripts/**', 'build/**', 'android/**', '*.config.mts', '*.config.mjs'] },
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
          paths: NODE_BUILTINS,
          patterns: [
            { group: ['electron', 'electron/*', 'node:*', 'koffi'], message: 'core/shared must stay platform-agnostic.' },
            { group: ['**/main/**', '**/renderer/**', '**/preload/**'], message: 'core/shared must not depend on process-specific code.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...PURE_GLOBALS.map((name) => ({ name, message: 'core/shared run in Electron main, sandboxed renderers and the browser: inject what you need.' }))],
    },
  },
  {
    // v1.2 (ADR 0003 D1, review C2): the simulation is deterministic for a seed. Time and randomness
    // are injected (CatSimOptions.now/random/wallClock); only the injection defaults may name them.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the injected Random (src/core/behavior/random.ts).' },
        { object: 'Date', property: 'now', message: 'Use the injected clock (env.now / wallClock).' },
        { object: 'performance', property: 'now', message: 'Use the injected clock (env.now).' },
      ],
      'no-restricted-syntax': ['error', { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use the injected wall clock.' }],
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
    // GizeVerse web host (ADR 0004 §8): browser code like the renderers, plus only the pure main
    // modules it composes (catHost and what they import are Electron-, Node- and koffi-free, and
    // type-check with the DOM lib alone). Never win32/index.ts or native.ts (koffi), never the
    // overlay manager (Electron). No key listeners anywhere (M5).
    files: ['src/web/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((p) => ({ ...p, message: 'The web host runs in a browser page (Node built-in).' })),
          patterns: [
            { group: ['electron', 'electron/*', 'node:*', 'koffi'], message: 'The web host runs in a browser page.' },
            {
              // A regex, not a group: gitignore-style negation cannot re-include files below an excluded folder.
              regex: '(^|/)main/(?!(catHost|contracts|overlay/renderMapping|win32/win32Api|win32/windowTracker|win32/activityMonitor)$)',
              message: 'The web host may only use the pure main modules (catHost, contracts, overlay/renderMapping, win32/win32Api, win32/windowTracker, win32/activityMonitor).',
            },
            { group: ['**/preload/**'], message: 'The web host has no preload: it builds its OverlayApi in the page.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['process', 'Buffer', '__dirname', '__filename', 'require', 'module', 'global', 'setImmediate', 'clearImmediate'].map((name) => ({ name, message: 'The web host runs in a browser page.' })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'Literal[value=/^key(down|up|press)$/i]', message: 'The web host never listens to the keyboard (ADR 0004 §8, M5).' },
        { selector: 'TemplateElement[value.raw=/key(down|up|press)/i]', message: 'The web host never listens to the keyboard (ADR 0004 §8, M5).' },
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
