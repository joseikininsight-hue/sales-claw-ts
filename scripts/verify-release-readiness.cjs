'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const CHECK_DIST = args.has('--dist');
const CHECK_INSTALLED = args.has('--installed');
const CHECK_GITHUB = args.has('--github');

const EXPECTED = {
  provider: 'github',
  owner: 'joseikininsight-hue',
  repo: 'sales-claw',
  channel: 'latest',
};

const REQUIRED_RUNTIME_DEPENDENCIES = [
  '@playwright/mcp',
  'electron-updater',
  'fs-extra',
  'npm',
  'universalify',
];

const failures = [];
const warnings = [];
const passes = [];

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readText(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function pass(message) {
  passes.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  failures.push(message);
}

function requireMatch(name, text, pattern, message) {
  if (pattern.test(text)) {
    pass(`${name}: ${message}`);
  } else {
    fail(`${name}: ${message}`);
  }
}

function requireContains(name, text, needle, message) {
  if (text.includes(needle)) {
    pass(`${name}: ${message}`);
  } else {
    fail(`${name}: ${message}`);
  }
}

function parseFlatYaml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('- ')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function parseLatestYaml(text) {
  const info = parseFlatYaml(text);
  const urls = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*-\s+url:\s*(.+)\s*$/) || rawLine.match(/^\s+url:\s*(.+)\s*$/);
    if (match) urls.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return { info, urls };
}

function getPackageVersion() {
  const pkg = readJson('package.json');
  return pkg.version;
}

function checkSourceConfig() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const builder = readText('electron-builder.yml');
  const main = readText('electron-main.ts');
  const workflow = readText('.github/workflows/release.yml');

  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    pass(`package.json: version ${pkg.version}`);
  } else {
    fail(`package.json: version must be semver, got ${pkg.version}`);
  }

  if (lock.version === pkg.version && lock.packages && lock.packages[''] && lock.packages[''].version === pkg.version) {
    pass('package-lock.json: root version matches package.json');
  } else {
    fail('package-lock.json: root version must match package.json');
  }

  if (pkg.build && pkg.build.extends === './electron-builder.yml') {
    pass('package.json: build extends electron-builder.yml');
  } else {
    fail('package.json: build.extends must be ./electron-builder.yml');
  }

  if (pkg.dependencies && pkg.dependencies['electron-updater']) {
    pass('package.json: electron-updater dependency is present');
  } else {
    fail('package.json: electron-updater dependency is required for desktop auto-update');
  }

  for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
    if (pkg.dependencies && pkg.dependencies[dependency]) {
      pass(`package.json: runtime dependency ${dependency} is declared`);
    } else {
      fail(`package.json: runtime dependency ${dependency} must be declared`);
    }
  }

  requireContains('electron-builder.yml', builder, 'provider: github', 'uses GitHub Releases provider');
  requireContains('electron-builder.yml', builder, `owner: ${EXPECTED.owner}`, `pins owner ${EXPECTED.owner}`);
  requireContains('electron-builder.yml', builder, `repo: ${EXPECTED.repo}`, `pins repo ${EXPECTED.repo}`);
  requireContains('electron-builder.yml', builder, `channel: ${EXPECTED.channel}`, `uses ${EXPECTED.channel} update channel`);
  requireContains('electron-builder.yml', builder, 'publishAutoUpdate: true', 'publishes auto-update metadata');
  requireContains('electron-builder.yml', builder, 'releaseType: release', 'uses non-draft release feed');
  requireContains('electron-builder.yml', builder, 'Sales-Claw-Setup-${version}.${ext}', 'Windows artifact name matches latest.yml references');

  for (const forbidden of ['${env.GH_OWNER}', '${env.GH_REPO}', 'owner: local-test', 'repo: local-test', 'your-org', 'your-username']) {
    if (builder.includes(forbidden)) {
      fail(`electron-builder.yml: forbidden placeholder/update feed remains: ${forbidden}`);
    }
  }

  for (const exclude of [
    '!dist/**',
    '!dist-released/**',
    '!.claude/**',
    '!.electron-userdata/**',
    '!.aidesigner/**',
    '!.code-review-graph/**',
    '!.gemini/**',
    '!.next/**',
    '!.playwright-mcp/**',
    '!.sales-claw-work/**',
    '!app/**',
    '!components/**',
    '!lib/**',
    '!public/**',
    '!tests/**',
  ]) {
    requireContains('electron-builder.yml', builder, exclude, `excludes ${exclude} from packaged app`);
  }

  // electron-updater は CJS hand-written / TS ES import / TS compiled CJS の3形態に対応
  //  CJS:        const { autoUpdater } = require('electron-updater');
  //  TS source:  import { autoUpdater } from 'electron-updater';
  //  TS compiled: const electron_updater_1 = require("electron-updater");
  const hasImport = /(require\(['"]electron-updater['"]\)|from\s+['"]electron-updater['"])/.test(main);
  if (hasImport && /autoUpdater/.test(main)) {
    pass('electron-main.ts: imports electron-updater');
  } else {
    fail('electron-main.ts: imports electron-updater');
  }
  requireContains('electron-main.ts', main, 'app-update.yml', 'reads packaged app-update.yml');
  requireContains('electron-main.ts', main, 'checkForUpdates()', 'has automatic update check path');
  requireContains('electron-main.ts', main, 'AUTO_UPDATE_ENABLED', 'guards update state explicitly');
  requireContains('electron-main.ts', main, 'PLACEHOLDER_UPDATE_OWNERS', 'blocks local-test/placeholder update feeds');

  requireContains('.github/workflows/release.yml', workflow, 'npm ci', 'installs from lockfile');
  // GitHub Release への artifacts upload は 2 パターンを許可:
  //   (A) softprops/action-gh-release を使った明示 upload (旧パターン)
  //   (B) electron-builder --publish always (新パターン、推奨)
  //       electron-builder が installer / blockmap / latest.yml を自動 publish する
  const usesPublishAlways = /electron-builder.*--publish\s+always/.test(workflow);
  if (usesPublishAlways) {
    pass('.github/workflows/release.yml: uploads Windows installer (via electron-builder --publish always)');
    pass('.github/workflows/release.yml: uploads Windows blockmap (via electron-builder --publish always or differentialPackage:false で省略)');
    pass('.github/workflows/release.yml: uploads latest update metadata (via electron-builder --publish always)');
    pass('.github/workflows/release.yml: creates GitHub Release (via electron-builder --publish always)');
  } else {
    requireContains('.github/workflows/release.yml', workflow, 'dist/*.exe', 'uploads Windows installer');
    requireContains('.github/workflows/release.yml', workflow, 'dist/*.exe.blockmap', 'uploads Windows blockmap');
    requireContains('.github/workflows/release.yml', workflow, 'dist/latest*.yml', 'uploads latest update metadata');
    requireContains('.github/workflows/release.yml', workflow, 'softprops/action-gh-release', 'creates GitHub Release');
  }
}

function checkDist() {
  const version = getPackageVersion();
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    fail('dist: directory does not exist; run npm run dist:win first');
    return;
  }

  const latestFiles = fs.readdirSync(distDir)
    .filter((name) => /^latest.*\.yml$/i.test(name))
    .map((name) => path.join(distDir, name));

  if (latestFiles.length === 0) {
    fail('dist: no latest*.yml update metadata was generated');
  }

  for (const latestPath of latestFiles) {
    const latest = parseLatestYaml(fs.readFileSync(latestPath, 'utf8'));
    const label = rel(latestPath);

    if (latest.info.version === version) {
      pass(`${label}: version matches package.json (${version})`);
    } else {
      fail(`${label}: version ${latest.info.version || '(missing)'} must match package.json ${version}`);
    }

    const referenced = new Set([latest.info.path, ...latest.urls].filter(Boolean));
    if (referenced.size === 0) {
      fail(`${label}: no artifact path/url found`);
    }

    for (const artifactName of referenced) {
      const artifactPath = path.join(distDir, artifactName);
      if (fs.existsSync(artifactPath)) {
        pass(`${label}: referenced artifact exists (${artifactName})`);
      } else {
        fail(`${label}: referenced artifact is missing (${artifactName})`);
      }

      if (/\.exe$/i.test(artifactName)) {
        const blockMapPath = `${artifactPath}.blockmap`;
        // electron-builder.yml で nsis.differentialPackage: false の場合 blockmap は生成されない。
        // その場合は blockmap 不存在を許容する。
        const builderYml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
        const differentialDisabled = /differentialPackage\s*:\s*false/i.test(builderYml);
        if (fs.existsSync(blockMapPath)) {
          pass(`${label}: Windows blockmap exists (${path.basename(blockMapPath)})`);
        } else if (differentialDisabled) {
          pass(`${label}: Windows blockmap intentionally absent (nsis.differentialPackage:false)`);
        } else {
          fail(`${label}: Windows blockmap is missing for ${artifactName}`);
        }
      }
    }
  }

  const winResources = path.join(distDir, 'win-unpacked', 'resources');
  if (fs.existsSync(winResources)) {
    const appUpdatePath = path.join(winResources, 'app-update.yml');
    if (!fs.existsSync(appUpdatePath)) {
      fail('dist/win-unpacked/resources/app-update.yml: missing packaged update feed');
    } else {
      const config = parseFlatYaml(fs.readFileSync(appUpdatePath, 'utf8'));
      checkUpdateFeedConfig(rel(appUpdatePath), config);
    }

    const packagedPackagePath = path.join(winResources, 'app', 'package.json');
    if (fs.existsSync(packagedPackagePath)) {
      const packagedPkg = JSON.parse(fs.readFileSync(packagedPackagePath, 'utf8'));
      if (packagedPkg.version === version) {
        pass(`${rel(packagedPackagePath)}: packaged version matches package.json`);
      } else {
        fail(`${rel(packagedPackagePath)}: packaged version ${packagedPkg.version} must match package.json ${version}`);
      }
    } else {
      fail(`${rel(packagedPackagePath)}: missing packaged package.json`);
    }

    for (const forbiddenDir of [
      '.claude',
      '.electron-userdata',
      '.aidesigner',
      '.code-review-graph',
      '.gemini',
      '.next',
      '.playwright-mcp',
      '.sales-claw-work',
      'app',
      'components',
      'lib',
      'public',
      'tests',
      'dist',
      'dist-released',
    ]) {
      const forbiddenPath = path.join(winResources, 'app', forbiddenDir);
      if (fs.existsSync(forbiddenPath)) {
        fail(`${rel(forbiddenPath)}: dev-only directory must not be packaged`);
      } else {
        pass(`${rel(forbiddenPath)}: dev-only directory is excluded`);
      }
    }

    for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
      const dependencyPath = path.join(winResources, 'app', 'node_modules', dependency, 'package.json');
      if (fs.existsSync(dependencyPath)) {
        const depPkg = JSON.parse(fs.readFileSync(dependencyPath, 'utf8'));
        pass(`${rel(dependencyPath)}: packaged runtime dependency ${dependency}@${depPkg.version} is present`);
      } else {
        fail(`${rel(dependencyPath)}: packaged runtime dependency ${dependency} is missing`);
      }
    }
  } else {
    warn('dist/win-unpacked/resources: not present; skipping Windows packaged app checks');
  }
}

function checkUpdateFeedConfig(label, config) {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    if (config[key] === expected) {
      pass(`${label}: ${key} is ${expected}`);
    } else {
      fail(`${label}: ${key} must be ${expected}, got ${config[key] || '(missing)'}`);
    }
  }

  if (config.owner === 'local-test' || config.repo === 'local-test') {
    fail(`${label}: local-test update feed disables auto-update`);
  }
}

function checkInstalled() {
  const expectedVersion = getPackageVersion();
  const installRoots = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Sales Claw'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Sales Claw') : null,
  ].filter(Boolean);

  let found = false;
  for (const installRoot of installRoots) {
    const appUpdatePath = path.join(installRoot, 'resources', 'app-update.yml');
    const packagePath = path.join(installRoot, 'resources', 'app', 'package.json');
    if (!fs.existsSync(appUpdatePath) && !fs.existsSync(packagePath)) continue;
    found = true;

    if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (pkg.version === expectedVersion) {
        pass(`${packagePath}: installed version matches package.json (${pkg.version})`);
      } else {
        fail(`${packagePath}: installed version ${pkg.version} must match package.json ${expectedVersion}`);
      }
    } else {
      fail(`${packagePath}: missing installed package.json`);
    }

    if (fs.existsSync(appUpdatePath)) {
      const config = parseFlatYaml(fs.readFileSync(appUpdatePath, 'utf8'));
      checkUpdateFeedConfig(appUpdatePath, config);
    } else {
      fail(`${appUpdatePath}: missing installed update feed`);
    }

    for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
      const dependencyPath = path.join(installRoot, 'resources', 'app', 'node_modules', dependency, 'package.json');
      if (fs.existsSync(dependencyPath)) {
        const depPkg = JSON.parse(fs.readFileSync(dependencyPath, 'utf8'));
        pass(`${dependencyPath}: installed runtime dependency ${dependency}@${depPkg.version} is present`);
      } else {
        fail(`${dependencyPath}: installed runtime dependency ${dependency} is missing`);
      }
    }
  }

  if (!found) {
    warn('installed: Sales Claw installation was not found in standard locations');
  }
}

function printResults() {
  for (const message of passes) console.log(`OK   ${message}`);
  for (const message of warnings) console.warn(`WARN ${message}`);
  for (const message of failures) console.error(`FAIL ${message}`);

  if (failures.length > 0) {
    console.error(`\nRelease readiness failed: ${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log(`\nRelease readiness passed (${passes.length} checks${warnings.length ? `, ${warnings.length} warning(s)` : ''}).`);
}

async function checkGitHub() {
  const version = getPackageVersion();
  const tag = `v${version}`;
  const owner = EXPECTED.owner;
  const repo = EXPECTED.repo;

  // gh CLI が使えるか確認
  const { execSync } = require('child_process');
  let ghAvailable = false;
  try {
    execSync('gh --version', { stdio: 'ignore' });
    ghAvailable = true;
  } catch (_) {}

  if (!ghAvailable) {
    warn('github: gh CLI not available — skipping GitHub Releases checks');
    return;
  }

  // タグが存在するか
  let releaseJson;
  try {
    const out = execSync(`gh api repos/${owner}/${repo}/releases/tags/${tag} 2>&1`, { encoding: 'utf8' });
    releaseJson = JSON.parse(out);
  } catch (e) {
    const msg = String(e.stdout || e.message || '');
    if (msg.includes('Not Found') || msg.includes('404')) {
      fail(`github: release ${tag} not found on GitHub — run: git tag ${tag} && git push origin ${tag}`);
    } else {
      warn(`github: could not fetch release ${tag} — ${msg.slice(0, 120)}`);
    }
    return;
  }

  pass(`github: release ${tag} exists`);

  const assets = Array.isArray(releaseJson.assets) ? releaseJson.assets : [];
  const assetNames = assets.map(a => a.name);

  // latest.yml が存在するか
  const latestYmlAsset = assets.find(a => a.name === 'latest.yml');
  if (!latestYmlAsset) {
    fail(`github: latest.yml missing from release ${tag} — auto-update will not work`);
  } else if (latestYmlAsset.size < 50) {
    fail(`github: latest.yml in release ${tag} is ${latestYmlAsset.size} bytes (too small) — auto-update will not work`);
  } else {
    pass(`github: latest.yml present in release ${tag} (${latestYmlAsset.size} bytes)`);
    // 内容を確認
    try {
      const content = execSync(`curl -sL "${latestYmlAsset.browser_download_url}"`, { encoding: 'utf8', timeout: 15000 });
      if (content.includes(`version: ${version}`)) {
        pass(`github: latest.yml in release ${tag} contains correct version ${version}`);
      } else {
        fail(`github: latest.yml in release ${tag} does not reference version ${version} — content: ${content.slice(0, 200)}`);
      }
    } catch (_) {
      warn(`github: could not fetch latest.yml content from release ${tag}`);
    }
  }

  // Windows EXE が存在するか
  const winExe = assets.find(a => /Sales-Claw-Setup.*\.exe$/.test(a.name));
  if (winExe) {
    pass(`github: Windows installer present in release ${tag} (${winExe.name}, ${Math.round(winExe.size / 1024 / 1024)}MB)`);
  } else {
    warn(`github: Windows installer not found in release ${tag} — available: ${assetNames.join(', ') || '(none)'}`);
  }

  // リリースがドラフトでないか
  if (releaseJson.draft) {
    fail(`github: release ${tag} is a draft — electron-updater requires non-draft releases`);
  } else {
    pass(`github: release ${tag} is published (not draft)`);
  }

  // latest release と package.json バージョンの一致
  try {
    const latestOut = execSync(`gh api repos/${owner}/${repo}/releases/latest 2>&1`, { encoding: 'utf8' });
    const latestRelease = JSON.parse(latestOut);
    const latestTag = latestRelease.tag_name;
    if (latestTag === tag) {
      pass(`github: release ${tag} is marked as Latest release`);
    } else {
      fail(`github: latest release is ${latestTag} but package.json version is ${version} — users will receive ${latestTag} updates, not ${version}`);
    }
  } catch (_) {
    warn(`github: could not determine latest release`);
  }
}

checkSourceConfig();
if (CHECK_DIST) checkDist();
if (CHECK_INSTALLED) checkInstalled();
if (CHECK_GITHUB) {
  checkGitHub().then(printResults).catch(e => {
    fail(`github check error: ${e.message}`);
    printResults();
  });
} else {
  printResults();
}
