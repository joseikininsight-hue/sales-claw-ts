// ESLint flat config for Sales Claw (2.0.0-rc.1 — public release ready)
// 重点: バグ予防 (no-undef / no-unused-vars / eqeqeq) + Node セキュリティ + TS 段階導入
// 対象: src/**, scripts/**, tests/**, electron-main.ts  (.ts / .cjs / .js)
// 除外: dist/, .claude/, app/ (Next.js TS は別 config), node_modules/

import js from '@eslint/js';
import nodePlugin from 'eslint-plugin-n';
import promisePlugin from 'eslint-plugin-promise';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
// 注: eslint-plugin-security 3.x は ESLint 10 と非互換 (context.getSourceCode が
// 削除された API を呼ぶ)。security の保護は built-in no-eval / no-implied-eval /
// no-new-func で代替している。プラグインが ESLint 10 対応した時点で再導入を検討。

export default [
  // ────────────────────────────────────────────────
  // 共通: ignore
  // ────────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      'dist-released/**',
      'dist-ts/**',
      'node_modules/**',
      '.claude/**',
      '.next/**',
      '.tmp-*/**',
      '.electron-userdata/**',
      'app/**',         // Next.js (TS) は別 config
      'components/**',  // Next.js (TS)
      'lib/**',         // Next.js (TS)
      'public/**',
      'screenshots/**',
      'data/**',
      'tmp/**',
      'temp/**',
      '**/*.tmp.*',
      '**/*.min.js',
      'assets/vendor/**',
      // TypeScript ビルド成果物 (.ts の隣に出る .js / .js.map / .d.ts)。
      // hand-written .js / .cjs と区別するため、対応する .ts が存在する .js は
      // ignore 対象。ここではシンプルに src/**/*.js (= TS 出力) を除外し、
      // .cjs だけ lint する。新規 .ts ファイルは下の TS ブロックで lint される。
      'src/**/*.js',
      'src/**/*.js.map',
      'src/**/*.d.ts',
      'electron-main.js',
      'electron-main.js.map',
    ],
  },

  // ────────────────────────────────────────────────
  // 全 .cjs / .js ファイル共通: ESLint 推奨 + Node + Promise + Security
  // ────────────────────────────────────────────────
  {
    files: ['src/**/*.cjs', 'src/**/*.js', 'scripts/**/*.cjs', 'scripts/**/*.js', 'tests/**/*.cjs', 'electron-main.js', 'next.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        // Node.js ビルトイン
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        // Test utility globals (defined per-file)
        describe: 'readonly',
        it: 'readonly',
      },
    },
    plugins: {
      n: nodePlugin,
      promise: promisePlugin,
    },
    rules: {
      // ─── ESLint 推奨ベース ─────────────────────────
      ...js.configs.recommended.rules,

      // ─── バグ予防 (typo/undefined/equality) ───────
      'no-undef': 'error',                 // 未定義参照
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-shadow': 'off',                  // CJS で多用、ノイズが多い
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-implicit-globals': 'error',
      'no-prototype-builtins': 'off',      // CJS でよく出る、誤検知
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',           // sanitize で使用
      'no-misleading-character-class': 'warn',
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true }],
      'no-useless-catch': 'warn',
      'no-redeclare': 'warn',

      // ─── セキュリティ: ESLint 標準ルールで eval 系を遮断 ──────
      //   (eslint-plugin-security 3.x は ESLint 10 と非互換のため標準で代替)
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // ─── Node プラグイン ──────────────────────────
      'n/no-deprecated-api': 'warn',
      'n/no-process-exit': 'off',          // CLI で使用
      'n/no-missing-require': 'off',       // electron 等の resolution は OK
      'n/no-extraneous-require': 'off',    // monorepo 構成

      // ─── Promise プラグイン ───────────────────────
      'promise/catch-or-return': 'off',
      'promise/no-nesting': 'off',
      'promise/always-return': 'off',
      'promise/no-callback-in-promise': 'off',
    },
  },

  // ────────────────────────────────────────────────
  // TypeScript 用設定 (.ts のみ)
  // 段階移行中なので no-explicit-any は warn (= 既存 800 件は warn として可視化)。
  // 新規コードでは any を書かないことを推奨する。
  // 詳細ロードマップ: docs/typescript-migration-roadmap.md
  // ────────────────────────────────────────────────
  {
    files: ['src/**/*.ts', 'electron-main.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        // browser globals (page.evaluate / electron renderer 経由)
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        HTMLElement: 'readonly',
        FormData: 'readonly',
        WebSocket: 'readonly',
        EventSource: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      promise: promisePlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,

      // TypeScript 移行段階 (詳細: docs/typescript-migration-roadmap.md)
      //   Stage 1 (current): any は warn として可視化、エラーにはしない
      //   Stage 2: 既存ファイルを 1 つずつ any 撲滅 (Top 15 ファイルから)
      //   Stage 3: error に昇格
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-require-imports': 'off',  // CJS 互換のため
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // 短絡評価 / void / try-catch 空 body 等の慣用句が多数あるため warn (段階移行)
      '@typescript-eslint/no-unused-expressions': ['warn', {
        allowShortCircuit: true,
        allowTernary: true,
        allowTaggedTemplates: true,
      }],

      // 既存ルール
      'no-undef': 'off',  // TS 側で型チェック済み
      'no-unused-vars': 'off',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-prototype-builtins': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true }],
      'no-useless-catch': 'warn',
      'no-redeclare': 'off',

      'promise/catch-or-return': 'off',
      'promise/no-nesting': 'off',
      'promise/always-return': 'off',
      'promise/no-callback-in-promise': 'off',

      // セキュリティ: ESLint 標準ルールで eval 系を遮断
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
    },
  },

  // ────────────────────────────────────────────────
  // テストファイル (.cjs / .ts): console.log OK、describe/it global、ガード緩和
  // - sanitizer/redact のテストで意図的に javascript: URL や eval 文字列を
  //   使うため、eval 系のルールも off にする (実行はしない、検査のみ)
  // ────────────────────────────────────────────────
  {
    files: ['tests/**/*.cjs', 'tests/**/*.ts', 'tests/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-eval': 'off',
      'no-implied-eval': 'off',
      'no-new-func': 'off',
      'no-script-url': 'off',
    },
  },

  // ────────────────────────────────────────────────
  // Playwright を使うファイル: page.evaluate(() => document.xxx) パターンで
  // browser globals (document/window/localStorage) が arrow function 内に出る。
  // ESLint は arrow function を Node 環境で評価するので false-positive。
  // 対象ファイルに browser globals を allowlist 追加。
  // ────────────────────────────────────────────────
  {
    files: [
      // 旧 .cjs はすべて .ts に移行済 (2026-05)。残るのは MCP server entry のみ。
      'src/mcp-servers/**/*.cjs',
      'src/list-builder/**/*.cjs',
      'src/ai-runtime/**/*.cjs',
      'scripts/**/*.cjs',
    ],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        HTMLElement: 'readonly',
        getComputedStyle: 'readonly',
        XMLHttpRequest: 'readonly',
        WebSocket: 'readonly',
        EventSource: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
  },

  // ────────────────────────────────────────────────
  // electron-main.js: Electron globals
  // ────────────────────────────────────────────────
  {
    // electron-main.js は build 成果物 ignore 済。残った .cjs は MCP server entry / scripts のみ。
    files: ['scripts/*.cjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        FormData: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        WebSocket: 'readonly',
        EventSource: 'readonly',
      },
    },
  },
];
