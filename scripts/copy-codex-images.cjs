#!/usr/bin/env node
/**
 * Codex CLI が生成した画像を public/images/blog/ にコピーする
 * (Windows の Codex バグ #19133 回避用)
 *
 * Usage:
 *   node scripts/copy-codex-images.cjs <session-id> [name-prefix]
 *
 * 例:
 *   node scripts/copy-codex-images.cjs 019e1c85-2f13-79c3-81fa-952535ecab4e cover-2026-05-12
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const sessionId = args[0];
const prefix = args[1] || `codex-${new Date().toISOString().slice(0, 10)}`;

if (!sessionId) {
  console.error('Usage: node scripts/copy-codex-images.cjs <session-id> [name-prefix]');
  console.error('');
  console.error('Find your session-id from codex output. Available sessions:');
  const baseDir = path.join(os.homedir(), '.codex', 'generated_images');
  if (fs.existsSync(baseDir)) {
    const sessions = fs.readdirSync(baseDir).sort();
    sessions.slice(-5).forEach((s) => {
      const stat = fs.statSync(path.join(baseDir, s));
      const files = fs.readdirSync(path.join(baseDir, s)).filter((f) => f.endsWith('.png'));
      console.error(`  ${s}  (${files.length} images, ${stat.mtime.toISOString()})`);
    });
  }
  process.exit(1);
}

const srcDir = path.join(os.homedir(), '.codex', 'generated_images', sessionId);
const dstDir = path.join(__dirname, '..', 'public', 'images', 'blog');

if (!fs.existsSync(srcDir)) {
  console.error(`Session directory not found: ${srcDir}`);
  process.exit(1);
}

fs.mkdirSync(dstDir, { recursive: true });

const images = fs.readdirSync(srcDir)
  .filter((f) => f.startsWith('ig_') && f.endsWith('.png'))
  .sort();

if (images.length === 0) {
  console.error('No generated images found in session.');
  process.exit(1);
}

console.log(`Found ${images.length} image(s) in session ${sessionId}\n`);

images.forEach((src, i) => {
  const suffix = images.length === 1 ? '' : `-${i + 1}`;
  const dstName = `${prefix}${suffix}.png`;
  const dstPath = path.join(dstDir, dstName);
  fs.copyFileSync(path.join(srcDir, src), dstPath);
  const sizeMB = (fs.statSync(dstPath).size / 1024 / 1024).toFixed(2);
  console.log(`✓ ${src} → public/images/blog/${dstName} (${sizeMB} MB)`);
});

console.log(`\nDone. ${images.length} image(s) copied to public/images/blog/.`);
