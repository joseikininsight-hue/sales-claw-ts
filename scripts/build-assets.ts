#!/usr/bin/env node
'use strict';

/**
 * ローカルアセットビルドスクリプト
 *
 * 外部CDN依存をなくし、全てのフォント・アイコン・Tailwind CSS を
 * assets/vendor/ 配下にバンドルする。
 *
 * 実行: npm run build:assets
 *
 * 出力:
 *   assets/vendor/
 *     fonts.css                           — Inter / Noto Sans JP / JetBrains Mono
 *     fonts/                              — .woff2 ファイル群
 *     material-symbols.css                — Material Symbols Outlined (Variable)
 *     material-symbols/material-symbols-outlined.woff2
 *     phosphor.css                        — Phosphor Icons
 *     phosphor/Phosphor.woff2             — webfont
 *     tailwind.css                        — production build (purged)
 *
 * オフライン / CSP 厳格環境でも UI が壊れないようにするため、
 * これらは必ずパッケージに含まれる必要がある。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const VENDOR_DIR = path.join(ASSETS_DIR, 'vendor');
const FONTS_DIR = path.join(VENDOR_DIR, 'fonts');
const MS_DIR = path.join(VENDOR_DIR, 'material-symbols');
const PHOSPHOR_DIR = path.join(VENDOR_DIR, 'phosphor');
const JS_DIR = path.join(VENDOR_DIR, 'js');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to, label) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  const size = (fs.statSync(to).size / 1024).toFixed(1);
  console.log(`  ✓ ${label || path.relative(ROOT, to)} (${size} KB)`);
}

function requireResolve(id) {
  return require.resolve(id, { paths: [ROOT] });
}

function packageRoot(pkgName) {
  // 一部パッケージは exports field で package.json を非公開にしているので
  // node_modules 内を直接参照する
  const direct = path.join(ROOT, 'node_modules', pkgName);
  if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
  try {
    const pkgJsonPath = requireResolve(`${pkgName}/package.json`);
    return path.dirname(pkgJsonPath);
  } catch (_) {
    return direct;
  }
}

// ──────────────────────────────────────────────────────────────
// Step 1: フォント (Inter / Noto Sans JP / JetBrains Mono)
// ──────────────────────────────────────────────────────────────

const FONT_SPECS = [
  // family, variant, fontsourcePkg, subset, style, weights
  { family: 'Inter', pkg: '@fontsource/inter', subsets: ['latin'], weights: [400, 500, 600, 700, 800, 900], style: 'normal' },
  { family: 'Noto Sans JP', pkg: '@fontsource/noto-sans-jp', subsets: ['japanese'], weights: [400, 500, 700], style: 'normal' },
  { family: 'JetBrains Mono', pkg: '@fontsource/jetbrains-mono', subsets: ['latin'], weights: [400, 500], style: 'normal' },
];

function bundleFonts() {
  console.log('[1/4] Fonts (Inter / Noto Sans JP / JetBrains Mono)');
  ensureDir(FONTS_DIR);
  const cssChunks = [];
  for (const spec of FONT_SPECS) {
    const pkgRoot = packageRoot(spec.pkg);
    const subFamilyDir = path.basename(pkgRoot); // @fontsource/inter → inter
    for (const subset of spec.subsets) {
      for (const weight of spec.weights) {
        // @fontsource の命名規則: files/<pkgbasename>-<subset>-<weight>-<style>.woff2
        const srcName = `${path.basename(pkgRoot)}-${subset}-${weight}-${spec.style}.woff2`;
        const srcPath = path.join(pkgRoot, 'files', srcName);
        if (!fs.existsSync(srcPath)) {
          console.warn(`    ⚠ skip (not found): ${srcName}`);
          continue;
        }
        const destName = srcName;
        const destPath = path.join(FONTS_DIR, destName);
        copyFile(srcPath, destPath, `fonts/${destName}`);
        cssChunks.push([
          `@font-face {`,
          `  font-family: '${spec.family}';`,
          `  font-style: ${spec.style};`,
          `  font-weight: ${weight};`,
          `  font-display: swap;`,
          `  src: url('/assets/vendor/fonts/${destName}') format('woff2');`,
          `}`,
        ].join('\n'));
      }
    }
  }
  fs.writeFileSync(path.join(VENDOR_DIR, 'fonts.css'), cssChunks.join('\n\n') + '\n', 'utf8');
  console.log(`  ✓ vendor/fonts.css (${cssChunks.length} @font-face rules)`);
}

// ──────────────────────────────────────────────────────────────
// Step 2: Material Symbols Outlined (variable font)
// ──────────────────────────────────────────────────────────────

function bundleMaterialSymbols() {
  console.log('[2/4] Material Symbols Outlined');
  ensureDir(MS_DIR);
  const pkgRoot = packageRoot('material-symbols');
  // material-symbols パッケージは outlined.woff2 等の variable font を含む
  const candidates = [
    'material-symbols-outlined.woff2',
    'outlined.woff2',
  ];
  let srcPath = null;
  for (const name of candidates) {
    const p = path.join(pkgRoot, name);
    if (fs.existsSync(p)) { srcPath = p; break; }
  }
  if (!srcPath) {
    // ディレクトリ走査でフォールバック
    const files = fs.readdirSync(pkgRoot).filter(f => f.toLowerCase().includes('outlined') && f.endsWith('.woff2'));
    if (files.length > 0) srcPath = path.join(pkgRoot, files[0]);
  }
  if (!srcPath) throw new Error('material-symbols: outlined variable font not found');
  const destName = 'material-symbols-outlined.woff2';
  copyFile(srcPath, path.join(MS_DIR, destName), `material-symbols/${destName}`);

  const css = [
    `/* Material Symbols Outlined (variable) */`,
    `@font-face {`,
    `  font-family: 'Material Symbols Outlined';`,
    `  font-style: normal;`,
    `  font-weight: 100 700;`,
    `  font-display: block;`,
    `  src: url('/assets/vendor/material-symbols/${destName}') format('woff2');`,
    `}`,
    `.material-symbols-outlined {`,
    `  font-family: 'Material Symbols Outlined';`,
    `  font-weight: normal;`,
    `  font-style: normal;`,
    `  font-size: 24px;`,
    `  line-height: 1;`,
    `  letter-spacing: normal;`,
    `  text-transform: none;`,
    `  display: inline-block;`,
    `  white-space: nowrap;`,
    `  word-wrap: normal;`,
    `  direction: ltr;`,
    `  -webkit-font-feature-settings: 'liga';`,
    `  font-feature-settings: 'liga';`,
    `  -webkit-font-smoothing: antialiased;`,
    `  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;`,
    `}`,
  ].join('\n');
  fs.writeFileSync(path.join(VENDOR_DIR, 'material-symbols.css'), css + '\n', 'utf8');
  console.log(`  ✓ vendor/material-symbols.css`);
}

// ──────────────────────────────────────────────────────────────
// Step 3: Phosphor Icons
// ──────────────────────────────────────────────────────────────

function bundlePhosphor() {
  console.log('[3/4] Phosphor Icons');
  ensureDir(PHOSPHOR_DIR);
  const pkgRoot = packageRoot('@phosphor-icons/web');
  // @phosphor-icons/web/src/regular/style.css + 関連 woff2
  const srcCss = path.join(pkgRoot, 'src', 'regular', 'style.css');
  if (!fs.existsSync(srcCss)) throw new Error('@phosphor-icons/web regular/style.css not found');
  // style.css 内の url() を /assets/vendor/phosphor/ に置換してコピー
  const rawCss = fs.readFileSync(srcCss, 'utf8');
  const regularDir = path.join(pkgRoot, 'src', 'regular');
  const files = fs.readdirSync(regularDir);
  const fontFiles = files.filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
  for (const f of fontFiles) {
    copyFile(path.join(regularDir, f), path.join(PHOSPHOR_DIR, f), `phosphor/${f}`);
  }
  // url 書き換え: url("./xxx.woff2") → url("/assets/vendor/phosphor/xxx.woff2")
  const rewritten = rawCss.replace(/url\(("|')?\.\/([^"')]+)(\1)?\)/g, (_m, _q1, p, _q2) => {
    return `url('/assets/vendor/phosphor/${p}')`;
  });
  fs.writeFileSync(path.join(VENDOR_DIR, 'phosphor.css'), rewritten, 'utf8');
  console.log(`  ✓ vendor/phosphor.css (${fontFiles.length} font files)`);
}

// ──────────────────────────────────────────────────────────────
// Step 4: Tailwind CSS (production build)
// ──────────────────────────────────────────────────────────────

function bundleTailwind() {
  console.log('[4/4] Tailwind CSS (production build)');
  ensureDir(VENDOR_DIR);
  const inputCss = path.join(VENDOR_DIR, '.tailwind-input.css');
  const outCss = path.join(VENDOR_DIR, 'tailwind.css');
  const bin = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'tailwindcss.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
  if (!fs.existsSync(bin)) {
    if (fs.existsSync(outCss)) {
      const size = (fs.statSync(outCss).size / 1024).toFixed(1);
      console.warn(`  ! tailwindcss CLI not found; keeping existing vendor/tailwind.css (${size} KB)`);
      return;
    }
    throw new Error('tailwindcss CLI not found and vendor/tailwind.css is missing');
  }
  fs.writeFileSync(inputCss, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n', 'utf8');
  const cmd = `"${bin}" -c "${path.join(ROOT, 'tailwind.config.js')}" -i "${inputCss}" -o "${outCss}" --minify`;
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  try { fs.unlinkSync(inputCss); } catch (_) {}
  const size = (fs.statSync(outCss).size / 1024).toFixed(1);
  console.log(`  ✓ vendor/tailwind.css (${size} KB)`);
}

// ──────────────────────────────────────────────────────────────
// Step 5: JS ライブラリ (Chart.js, xterm)
// ──────────────────────────────────────────────────────────────

function bundleJsLibraries() {
  console.log('[5/5] JS libraries (Chart.js, xterm)');
  ensureDir(JS_DIR);

  // Chart.js
  {
    const pkgRoot = packageRoot('chart.js');
    const candidates = [
      path.join(pkgRoot, 'dist', 'chart.umd.js'),
      path.join(pkgRoot, 'dist', 'chart.umd.min.js'),
      path.join(pkgRoot, 'dist', 'chart.js'),
    ];
    const src = candidates.find(fs.existsSync);
    if (!src) throw new Error('chart.js dist not found');
    copyFile(src, path.join(JS_DIR, 'chart.umd.js'), 'js/chart.umd.js');
  }

  // xterm (legacy package layout)
  {
    const pkgRoot = packageRoot('xterm');
    const srcJs = path.join(pkgRoot, 'lib', 'xterm.js');
    const srcCss = path.join(pkgRoot, 'css', 'xterm.css');
    if (fs.existsSync(srcJs)) copyFile(srcJs, path.join(JS_DIR, 'xterm.js'), 'js/xterm.js');
    if (fs.existsSync(srcCss)) copyFile(srcCss, path.join(JS_DIR, 'xterm.css'), 'js/xterm.css');
  }

  // xterm-addon-fit
  {
    const pkgRoot = packageRoot('xterm-addon-fit');
    const src = path.join(pkgRoot, 'lib', 'xterm-addon-fit.js');
    if (fs.existsSync(src)) copyFile(src, path.join(JS_DIR, 'xterm-addon-fit.js'), 'js/xterm-addon-fit.js');
  }
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

function main() {
  console.log('Building local vendor assets (offline-safe UI)');
  console.log(`Output: ${VENDOR_DIR}`);
  ensureDir(VENDOR_DIR);
  bundleFonts();
  bundleMaterialSymbols();
  bundlePhosphor();
  bundleTailwind();
  bundleJsLibraries();
  console.log('\n✅ Local vendor assets ready. No external CDN needed at runtime.');
  console.log('   Note: assets/vendor/ai-icons/*.svg は手動管理（git commit 済みを使う）');
}

main();
