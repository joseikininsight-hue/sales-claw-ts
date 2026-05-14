// Secret redaction for PTY / log streams
//
// AI CLI セッションの stdin/stdout を pty-log に書き出す前に
// 機密文字列をマスクする。トークンが平文でログに残ると、
// 1) ローカルディスクに永続化されて意図しない共有経路 (バックアップ・
//    クラッシュレポート添付) で漏洩する、2) ユーザーが「CLI Activity」
//    タブのログを引用して相談する際に他人へ送ってしまう、という
//    両方のリスクがある。
//
// 設計方針:
//  - パターンは既知の token フォーマットだけ。汎用 base64 (32文字以上)
//    のような broad pattern は false positive が多すぎてログが
//    読めなくなるので採用しない。
//  - マッチした文字列は `[REDACTED:<種別>]` で置換する。
//  - 入力 (ユーザー打鍵) と出力 (CLI からのエコー) の両方に適用する。
//  - 元のテキスト長は意図的に保持しない (情報漏洩経路を増やさない)。

export type RedactLabel =
  | 'api-key'
  | 'oauth'
  | 'aws'
  | 'gcp'
  | 'github'
  | 'gitlab'
  | 'slack'
  | 'bearer'
  | 'basic-auth'
  | 'password'
  | 'private-key'
  | 'jwt';

export const REDACT_LABELS: readonly RedactLabel[] = Object.freeze([
  'api-key',
  'oauth',
  'aws',
  'gcp',
  'github',
  'gitlab',
  'slack',
  'bearer',
  'basic-auth',
  'password',
  'private-key',
  'jwt',
]);

interface PatternEntry {
  re: RegExp;
  label: RedactLabel;
  replaceWith?: string;
}

/**
 * パターン定義。順序が重要:
 *  - 最初に長く具体的なものを試し、最後に一般的なものを試す。
 */
const PATTERNS: PatternEntry[] = [
  // Anthropic API keys: `sk-ant-` プレフィックス付き、英数とダッシュ。
  { re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g, label: 'api-key' },

  // OpenAI API keys: `sk-` または `sk-proj-` プレフィックス (sk-ant- 以外)
  { re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, label: 'api-key' },

  // GitHub tokens (PAT classic / fine-grained / OAuth / server / refresh)
  { re: /\b(?:ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{36,}\b/g, label: 'github' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g, label: 'github' },

  // GitLab personal access tokens
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: 'gitlab' },

  // AWS Access Key ID + 16 桁
  { re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g, label: 'aws' },

  // Google API key (AIza...)
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'gcp' },

  // Slack tokens (xox{a,b,o,p,r,s,t}-...)
  { re: /\bxox[abopsrt]-[A-Za-z0-9-]{10,}\b/g, label: 'slack' },

  // JWT (header.payload.signature, base64url 各 segment)
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: 'jwt' },

  // PEM private key blocks (複数行)
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g, label: 'private-key' },

  // PEM チャンク分断のフォールバック (BEGIN/END 行単独でも redact)
  { re: /^.*-----(?:BEGIN|END) (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----.*$/gm, label: 'private-key' },

  // Bearer / Basic auth — Authorization ヘッダ非依存の汎用形
  { re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, label: 'bearer', replaceWith: '$1[REDACTED:bearer]' },
  { re: /(\bBasic\s+)[A-Za-z0-9+/=_-]{12,}/g, label: 'basic-auth', replaceWith: '$1[REDACTED:basic-auth]' },

  // 一般的なシークレット用ヘッダ全体を value-only redact
  { re: /(\b(?:X-(?:API|Auth|Access|Session|Service|Refresh)-?(?:Key|Token|Secret)|Cookie|Set-Cookie)\s*[:=]\s*)([^\r\n,;"'\s]{12,})/gi, label: 'bearer', replaceWith: '$1[REDACTED:bearer]' },

  // URL クエリ password / pass / secret / api_key / access_token
  { re: /\b(password|passwd|pass|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*=\s*([^\s&"'<>]{4,})/gi, label: 'password', replaceWith: '$1=[REDACTED:password]' },

  // Anthropic OAuth `claudeAiOauth.accessToken`-style strings (180+ 文字)
  { re: /\b[A-Za-z0-9_-]{180,}\b/g, label: 'oauth' },
];

export interface SecretMatch {
  label: RedactLabel;
  match: string;
  index: number;
}

export type RedactDebugHook = (matches: SecretMatch[], originalLen: number) => void;

let _debugHook: RedactDebugHook | null = null;

/** 開発・運用診断用にデバッグフックを設定。null を渡すと無効化。 */
export function setRedactDebugHook(hook: RedactDebugHook | null): void {
  _debugHook = typeof hook === 'function' ? hook : null;
}

/** 1 チャンクの文字列に含まれる機密文字列をマスクする。 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  if (_debugHook) {
    const matches = findSecretMatches(text);
    if (matches.length > 0) {
      try { _debugHook(matches, text.length); } catch { /* ignore hook errors */ }
    }
  }

  let out = text;
  for (const { re, label, replaceWith } of PATTERNS) {
    re.lastIndex = 0;
    if (replaceWith) {
      out = out.replace(re, replaceWith);
    } else {
      out = out.replace(re, `[REDACTED:${label}]`);
    }
  }
  return out;
}

/** テスト/デバッグ用: マッチした各 secret を返す。 */
export function findSecretMatches(text: string): SecretMatch[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const found: SecretMatch[] = [];
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      found.push({ label, match: m[0], index: m.index });
      // 0 幅マッチで無限ループしないように
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return found;
}

module.exports = {
  REDACT_LABELS,
  redactSecrets,
  findSecretMatches,
  setRedactDebugHook,
  __PATTERNS_INTERNAL: PATTERNS,
};
