const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDERS = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    cliLabel: 'Claude Code CLI',
    installPackage: '@anthropic-ai/claude-code',
    executableNames: ['claude.exe', 'claude.cmd', 'claude'],
    defaultModel: 'claude-sonnet-4-6',
    defaultMode: 'auto',
    autoModeNote: {
      ja: 'Claude は auto / bypassPermissions の相性が良く、日常運用では auto を推奨します。',
      en: 'Claude works well with auto / bypassPermissions. Use auto for normal operations.',
    },
  },
};

// Claude Code CLI のみをサポートする (v2.2.0 で Codex / Gemini 対応を削除)。
// 旧設定の aiProvider: 'codex' / 'gemini' などは全て 'claude' に正規化される。
function normalizeProviderId(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROVIDERS[key] ? key : 'claude';
}

function getProvider(value) {
  return PROVIDERS[normalizeProviderId(value)];
}

function listProviders() {
  return Object.values(PROVIDERS).map((provider: any) => ({
    id: provider.id,
    displayName: provider.displayName,
    cliLabel: provider.cliLabel,
    installPackage: provider.installPackage,
    defaultModel: provider.defaultModel,
    defaultMode: provider.defaultMode,
    autoModeNote: provider.autoModeNote,
  }));
}

function getInstallCommand(providerId) {
  const provider = getProvider(providerId);
  return `npm install -g ${provider.installPackage}`;
}

function getInstallSpawnArgs(providerId) {
  const provider = getProvider(providerId);
  return {
    command: 'npm',
    args: ['install', '-g', provider.installPackage],
  };
}

function getExecutableFallbackCandidates(providerId) {
  const provider = getProvider(providerId);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const userProfile = process.env.USERPROFILE || os.homedir();
  const localBin = path.join(userProfile, '.local', 'bin');
  const roamingNpm = path.join(appData, 'npm');
  const candidates: unknown[] = [];

  provider.executableNames.forEach((name: any) => {
    candidates.push(path.join(localBin, name));
    candidates.push(path.join(roamingNpm, name));
    candidates.push(path.join(userProfile, 'AppData', 'Roaming', 'npm', name));
  });

  return Array.from(new Set(candidates.filter(Boolean).map((entry: any) => path.resolve(entry))));
}

// Claude は `claude auth status` で判定するため、ファイルベースの認証検出は持たない。
function getAuthFiles(_providerId) {
  return [];
}

function hasAnyAuthFile(providerId) {
  return getAuthFiles(providerId).some((filePath: any) => fs.existsSync(filePath));
}

function buildLaunchArgs(providerId, mode = 'default', options: Record<string, unknown> = {}) {
  const provider = getProvider(providerId);
  const currentMode = typeof mode === 'string' && mode ? mode : provider.defaultMode;
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  const flags: unknown[] = [];

  if (provider.id === 'claude') {
    if (currentMode === 'acceptEdits') flags.push('--permission-mode', 'acceptEdits');
    if (currentMode === 'auto') flags.push('--permission-mode', 'auto');
    if (currentMode === 'bypassPermissions') flags.push('--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions');
    if (model) flags.push('--model', model);
    if (options.sessionId) flags.push('--session-id', options.sessionId);
    return flags;
  }

  return flags;
}

function buildHeadlessArgs(providerId, mode = 'auto', options: Record<string, unknown> = {}) {
  const provider = getProvider(providerId);
  const currentMode = typeof mode === 'string' && mode ? mode : provider.defaultMode;
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd();
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';

  if (provider.id === 'claude') {
    // Claude headless: `claude -p "<prompt>"` で出力を STDOUT に流して即終了する。
    // バッチ並列実行 (P1-4) で各 slot ごとに 1 プロセス使うのに使用。
    // permission mode はデフォルト bypassPermissions (パースの 1st Enter 不要)。
    const flags = ['-p', prompt || ''];
    const effectiveMode = currentMode === 'auto' ? 'bypassPermissions' : currentMode;
    if (effectiveMode === 'bypassPermissions') {
      flags.push('--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions');
    } else if (effectiveMode === 'acceptEdits') {
      flags.push('--permission-mode', 'acceptEdits');
    }
    // Prompt cache 再利用率を上げる: per-machine な dynamic system prompt section
    // (cwd / env info / memory paths / git status) を first user message に逃がす。
    // これによりプロンプトの先頭部分が hash 一致しやすくなり、Programmatic Credit
    // 枠の消費を抑える。
    flags.push('--exclude-dynamic-system-prompt-sections');
    if (model) flags.push('--model', model);
    return {
      promptViaStdin: !prompt,
      args: flags,
      effectiveMode,
    };
  }

  return {
    promptViaStdin: false,
    args: buildLaunchArgs(providerId, currentMode, options),
    effectiveMode: currentMode,
  };
}

function quoteCmdArg(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/(["^&|<>()%])/g, '^$1')}"`;
}

/**
 * node-pty の ConPTY 実装は filename が relative のとき
 * `GetEnvironmentVariableW(L"Path", ...)` で **呼び出し元プロセスの PATH**
 * を引いて検索する (spawn() に渡した env ではない)。
 * Electron で起動した Sales Claw の process.env.Path が System32 を含まない
 * 異常 env (起動コンテキスト依存で発生する) だと、`cmd.exe` も `powershell.exe`
 * も解決できず "File not found:" (パス空) で即 throw する。
 *
 * 解決策: relative filename を node-pty に渡さない。
 * GetSystemDirectoryW 相当の `process.env.SystemRoot` (常にセットされている
 * 可用性の高い env var) から絶対パスを組み立てて返す。
 * 取得できない極端なケース (env が完全に剥がされている) は最後の保険として
 * `C:\\Windows\\System32\\` を使う。
 */
function getWindowsSystemExecutable(name) {
  if (process.platform !== 'win32') return name;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
  const absolute = path.join(systemRoot, 'System32', name);
  return absolute;
}

function buildManagedSpawnSpec(providerId, executable, args) {
  const exePath = String(executable || '').trim();
  const extension = path.extname(exePath).toLowerCase();
  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    // node-pty は args を文字列で受け取ると ConPTY に verbatim で渡す。
    // child_process.spawn の自動 escape (\" 化) を回避し、cmd /s が剥がす
    // 最外 " で挟む Microsoft 推奨パターンで安定起動させる。
    const inner = [quoteCmdArg(exePath), ...(args || []).map(quoteCmdArg)].join(' ');
    return {
      // 絶対パスで cmd.exe を渡す (PATH に System32 が無い env でも通す)
      command: getWindowsSystemExecutable('cmd.exe'),
      args: `/d /s /c "${inner}"`,
    };
  }
  if (process.platform === 'win32' && extension === '.ps1') {
    const escapedArgs = (args || []).map((arg: any) => {
      const text = String(arg || '');
      return `'${text.replace(/'/g, "''")}'`;
    });
    const script = [
      `$host.ui.RawUI.WindowTitle = '${getProvider(providerId).displayName} CLI'`,
      ['&', `'${exePath.replace(/'/g, "''")}'`, ...escapedArgs].join(' '),
    ].join('; ');
    return {
      command: getWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-Command', script],
    };
  }
  return {
    command: exePath,
    args: args || [],
  };
}

module.exports = {
  PROVIDERS,
  normalizeProviderId,
  getProvider,
  listProviders,
  getInstallCommand,
  getInstallSpawnArgs,
  getExecutableFallbackCandidates,
  getAuthFiles,
  hasAnyAuthFile,
  buildLaunchArgs,
  buildHeadlessArgs,
  buildManagedSpawnSpec,
};
