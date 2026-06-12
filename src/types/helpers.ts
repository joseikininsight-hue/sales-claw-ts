/**
 * 型ヘルパー — Sales Claw の TypeScript 移行を支える共通プリミティブ
 * ──────────────────────────────────────────────────────────────────
 *
 * このファイルは「`any` を書かなくて済むようにする」ための共通ツールを
 * 集約する。コードレビューで `any` / `as any` を見つけたら、まずこの
 * ファイルのどれかで置き換えられないか検討する。
 *
 * ロードマップ: docs/typescript-migration-roadmap.md
 */

// ─────────────────────────────────────────────────────────────────
// 1. JSON / 未知データ — unknown を narrow するための型ガード
// ─────────────────────────────────────────────────────────────────

/**
 * 任意の値 (JSON 由来など) が plain object かを判定する。
 * `value && typeof value === 'object'` よりも narrow になる。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * value が string か。null / undefined / 数値などをすべて false にする。
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * value が「空でない string」か。trim 済みで length > 0 をチェック。
 * フォーム入力検証などで頻出。
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * value が有限の数値か (NaN / Infinity を除外)。
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * value が boolean か。
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * value が配列か。標準の Array.isArray を unknown 入力に対応させたバージョン。
 */
export function isArray<T = unknown>(value: unknown): value is T[] {
  return Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────
// 2. 安全な JSON.parse — try/catch を毎回書かないで済むようにする
// ─────────────────────────────────────────────────────────────────

/**
 * JSON.parse を try/catch 内包の Result 型で返す。失敗時は null を返し、
 * 例外を投げない。返り値の型は `unknown` なので、後続でガードを書く必要がある。
 *
 * 例:
 *   const parsed = parseJsonSafe(raw);
 *   if (isPlainObject(parsed) && isNonEmptyString(parsed.companyName)) {
 *     console.log(parsed.companyName);  // 型は string
 *   }
 */
export function parseJsonSafe(text: string | Buffer): unknown {
  if (text == null) return null;
  const s = typeof text === 'string' ? text : text.toString('utf8');
  if (!s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 既知の shape にフィットしているか確認しながら parse する。
 * predicate が true を返したら value にキャストして返す、false なら null。
 *
 * 例:
 *   const settings = parseJsonAs<Settings>(raw, isSettings);
 *   if (!settings) {
 *     throw new Error('Invalid settings file');
 *   }
 */
export function parseJsonAs<T>(
  text: string | Buffer,
  predicate: (value: unknown) => value is T,
): T | null {
  const parsed = parseJsonSafe(text);
  if (parsed == null) return null;
  return predicate(parsed) ? parsed : null;
}

// ─────────────────────────────────────────────────────────────────
// 3. Result 型 — try/catch を関数の境界で「失敗の可能性」として表現
// ─────────────────────────────────────────────────────────────────

/**
 * 成功 (ok=true + value) / 失敗 (ok=false + error) を表す Result 型。
 * 関数が「例外を投げる代わりに」失敗を返したいときに使う。
 *
 * 例:
 *   function loadSettings(): Result<Settings> {
 *     try {
 *       return ok(JSON.parse(fs.readFileSync('settings.json', 'utf8')));
 *     } catch (e) {
 *       return err(e instanceof Error ? e.message : String(e));
 *     }
 *   }
 *
 *   const r = loadSettings();
 *   if (!r.ok) {
 *     console.error(r.error);
 *     return;
 *   }
 *   // r.value は Settings 型に narrow される
 */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = string>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * unknown 型の error (catch 句で渡ってくる) を string にまとめる。
 * `e instanceof Error ? e.message : String(e)` を毎回書かないで済む。
 */
export function errorMessage(e: unknown): string {
  if (e == null) return '';
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * errorMessage のエイリアス。`getErrorMessage` という名前を期待する
 * 呼び出し側 (catch (e: unknown) 移行) のための discoverable な別名。
 */
export const getErrorMessage = errorMessage;

/**
 * unknown 型の error から `code` (NodeJS の errno 文字列など) を取り出す。
 * `(e as any)?.code` / `(e as { code?: string }).code` を毎回書かないで済む。
 * code が無い / string でない場合は undefined。
 */
export function getErrorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────
// 4. プロパティアクセス — Record<string, unknown> から型付きで取り出す
// ─────────────────────────────────────────────────────────────────

/**
 * オブジェクトから string プロパティを取り出す。型が違ったら fallback を返す。
 *
 * 例:
 *   const name = getString(parsed, 'companyName', '(unknown)');
 */
export function getString(
  obj: unknown,
  key: string,
  fallback: string = '',
): string {
  if (!isPlainObject(obj)) return fallback;
  const v = obj[key];
  return isString(v) ? v : fallback;
}

export function getNumber(
  obj: unknown,
  key: string,
  fallback: number = 0,
): number {
  if (!isPlainObject(obj)) return fallback;
  const v = obj[key];
  return isFiniteNumber(v) ? v : fallback;
}

export function getBoolean(
  obj: unknown,
  key: string,
  fallback: boolean = false,
): boolean {
  if (!isPlainObject(obj)) return fallback;
  const v = obj[key];
  return isBoolean(v) ? v : fallback;
}

export function getArray<T = unknown>(
  obj: unknown,
  key: string,
  fallback: T[] = [],
): T[] {
  if (!isPlainObject(obj)) return fallback;
  const v = obj[key];
  return isArray<T>(v) ? v : fallback;
}

/**
 * オブジェクトから sub-object を取り出す。型が違ったら空オブジェクトを返す。
 */
export function getObject(
  obj: unknown,
  key: string,
): Record<string, unknown> {
  if (!isPlainObject(obj)) return {};
  const v = obj[key];
  return isPlainObject(v) ? v : {};
}

// ─────────────────────────────────────────────────────────────────
// 5. CJS require の型付け — 動的 require の戻り値を unknown として扱う
// ─────────────────────────────────────────────────────────────────

/**
 * `require()` の戻り値を unknown として扱う型安全なラッパ。
 * シングルトンの module 解決は Node.js のキャッシュに任せる。
 *
 * 例:
 *   const sanitizer = requireSafe<typeof import('./spawn-env-sanitizer')>('./spawn-env-sanitizer');
 *   if (sanitizer) {
 *     sanitizer.buildSanitizedSpawnEnv({ ... });
 *   }
 */
export function requireSafe<T = unknown>(modulePath: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(modulePath) as T;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// 6. 値のクランプ・サニタイズ
// ─────────────────────────────────────────────────────────────────

/**
 * 数値を min/max にクランプ。入力が不正なら fallback。
 */
export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!isFiniteNumber(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 文字列を trim + 最大長で truncate。
 */
export function truncate(value: unknown, maxLen: number): string {
  if (!isString(value)) return '';
  const s = value.trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}
