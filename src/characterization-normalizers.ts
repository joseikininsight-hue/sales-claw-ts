import * as path from 'path';

export interface NormalizeOptions {
  roots?: string[];
}

function replaceAllLiteral(input: string, value: string, replacement: string): string {
  if (!value) return input;
  return input.split(value).join(replacement);
}

export function normalizeCharacterizationText(value: unknown, options: NormalizeOptions = {}): string {
  let text = String(value ?? '').replace(/\r\n/g, '\n');
  const roots = new Set(
    (options.roots ?? [])
      .filter(Boolean)
      .flatMap((root) => {
        const resolved = path.resolve(root);
        return [
          resolved,
          resolved.replace(/\\/g, '/'),
          resolved.replace(/\\/g, '\\\\'),
        ];
      }),
  );
  for (const root of roots) {
    text = replaceAllLiteral(text, root, '<ABS_ROOT>');
  }
  text = text
    .replace(/\b[a-f0-9]{48,}\b/gi, '<SESSION_TOKEN>')
    .replace(/\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, 'v<APP_VERSION>')
    // "Version 2.1.6" のような表記 (dashboard ヘッダの title 属性等)。
    // これを取り逃すとバージョンを上げるたびに page ハッシュが壊れる。
    .replace(/(\bVersion\s+)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/gi, '$1<APP_VERSION>')
    .replace(/(["']?version["']?\s*[:=]\s*["'])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, '$1<APP_VERSION>')
    .replace(/(https?:\/\/(?:127\.0\.0\.1|localhost)):\d+/g, '$1:<PORT>')
    .replace(/(isElectron\s*[:=]\s*)(?:true|false)/g, '$1<ELECTRON>');
  return text;
}
