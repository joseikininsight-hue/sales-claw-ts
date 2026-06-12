/**
 * 技術的負債メトリクスの計測スクリプト。
 *
 * リファクタリング計画 (docs/refactoring-plan.md) の各フェーズ進捗を数値で
 * 追跡し、CI のラチェット (単調非増加 / カバレッジは非減少) の基準にする。
 *
 * 使い方:
 *   tsx scripts/debt-metrics.ts            # 人間可読テーブル
 *   tsx scripts/debt-metrics.ts --json     # JSON (CI 比較用)
 *
 * 計測対象は src/**.ts + electron-main.ts (テスト・dist は除外)。
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

interface Metrics {
  srcFiles: number;
  srcLines: number;
  dashboardServerLines: number;
  explicitAny: number;
  versionComments: number;
  emptyCatch: number;
  todoFixme: number;
  ciTestFiles: number;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

function measure(): Metrics {
  const files = collectTsFiles(SRC_DIR);
  const mainFile = path.join(REPO_ROOT, 'electron-main.ts');
  if (fs.existsSync(mainFile)) files.push(mainFile);

  let srcLines = 0;
  let explicitAny = 0;
  let versionComments = 0;
  let emptyCatch = 0;
  let todoFixme = 0;
  let dashboardServerLines = 0;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).length;
    srcLines += lines;
    if (path.basename(file) === 'dashboard-server.ts') dashboardServerLines = lines;
    // 明示的 any: `: any` / `as any` / `<any>`
    explicitAny += countMatches(text, /(:\s*any\b|\bas\s+any\b|<any>)/g);
    // バージョンタグ付きコメント (v1.2.x / v2.0.x 等)
    versionComments += countMatches(text, /\bv[12]\.[0-9]+\.[0-9]+/g);
    // 空 catch: `catch (x) {}` / `catch {}` (空白/改行のみ)
    emptyCatch += countMatches(text, /catch\s*(\([^)]*\))?\s*\{\s*\}/g);
    todoFixme += countMatches(text, /\b(TODO|FIXME|HACK|XXX)\b/g);
  }

  // CI で実行されるテスト数 (run-unit.cjs の discovered - quarantined - e2e)
  let ciTestFiles = 0;
  try {
    const runUnit = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'run-unit.cjs'), 'utf8');
    const quarantine = countMatches(runUnit.split('QUARANTINE')[1]?.split('E2E_SPECIAL')[0] || '', /\.test\.cjs'/g);
    const e2e = countMatches(runUnit.split('E2E_SPECIAL')[1]?.split('function')[0] || '', /\.test\.cjs'/g);
    function walk(d: string): number {
      let n = 0;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'fixtures' || e.name === 'node_modules') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) n += walk(f);
        else if (e.name.endsWith('.test.cjs')) n += 1;
      }
      return n;
    }
    const total = walk(path.join(REPO_ROOT, 'tests'));
    ciTestFiles = total - quarantine - e2e;
  } catch { /* best-effort */ }

  return {
    srcFiles: files.length,
    srcLines,
    dashboardServerLines,
    explicitAny,
    versionComments,
    emptyCatch,
    todoFixme,
    ciTestFiles,
  };
}

function main(): void {
  const m = measure();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(m, null, 2) + '\n');
    return;
  }
  const rows: Array<[string, number, string]> = [
    ['src ファイル数', m.srcFiles, ''],
    ['src 総行数', m.srcLines, ''],
    ['dashboard-server.ts 行数', m.dashboardServerLines, 'P3 目標 ≤ 3000 → 1500'],
    ['明示的 any (: any / as any / <any>)', m.explicitAny, 'P5 で削減'],
    ['バージョンタグ付きコメント', m.versionComments, 'P1/P3 で整理'],
    ['空 catch ブロック', m.emptyCatch, 'P4/P6 で可視化'],
    ['TODO/FIXME/HACK/XXX', m.todoFixme, ''],
    ['CI 実行テストファイル数', m.ciTestFiles, '増加が望ましい'],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  console.log('=== 技術的負債メトリクス (' + new Date().toISOString().slice(0, 10) + ') ===');
  for (const [label, value, note] of rows) {
    console.log('  ' + label.padEnd(w) + '  ' + String(value).padStart(7) + (note ? '   ' + note : ''));
  }
}

main();
