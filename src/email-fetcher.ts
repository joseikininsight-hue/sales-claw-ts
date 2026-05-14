// Outlook Web からメールを取得するスクリプト
// 設定されたキーワードでメールを検索し、やり取り履歴を蓄積する
// 初回はログインが必要（ブラウザが開くので手動でログイン）

const fs = require('fs');
const settings = require('./settings-manager');
const { ensureDataDir, resolveDataPath } = require('./data-paths');
const { log: cliLog } = (() => { try { return require('./cli-logger'); } catch { return { log: console.warn }; } })();

function requireChromium() {
  try {
    return require('playwright').chromium;
  } catch {
    throw new Error(
      'Playwrightがインストールされていません。メール取得には playwright が必要です。\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium\n' +
      'を実行してからやり直してください。'
    );
  }
}

function getSessionDir() {
  return resolveDataPath('outlook-session');
}

function getEmailsFile() {
  return resolveDataPath('emails.json');
}

function loadEmails() {
  try { return JSON.parse(fs.readFileSync(getEmailsFile(), 'utf-8')); } catch { return { emails: [], lastFetched: null }; }
}

function saveEmails(data) {
  ensureDataDir();
  fs.writeFileSync(getEmailsFile(), JSON.stringify(data, null, 2), 'utf-8');
}

async function fetchEmails() {
  const prefs = settings.getSection('preferences');
  const provider = (prefs.emailProvider || 'outlook').toLowerCase();
  const searchKeyword = prefs.emailSearchKeyword;

  if (provider !== 'outlook') {
    return { success: false, error: `emailProvider "${provider}" is not supported yet.` };
  }

  if (!searchKeyword) {
    console.log('メール検索キーワードが設定されていません。');
    console.log('ダッシュボードの設定画面で emailSearchKeyword を設定してください。');
    return { success: false, error: '検索キーワード未設定' };
  }

  const sessionDir = getSessionDir();
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    // Restrict directory permissions to owner-only on POSIX systems
    if (process.platform !== 'win32') {
      try { fs.chmodSync(sessionDir, 0o700); } catch (_) {}
    }
    cliLog('[security] Outlook session stored in plaintext at: ' + sessionDir, 'warn');
    cliLog('[security] Ensure this directory is not accessible by other users.', 'warn');
  }

  const chromium = requireChromium();

  const context: any = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    locale: prefs.locale || 'ja-JP',
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    console.log('[1] Outlook Web にアクセス...');
    await page.goto('https://outlook.office.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('microsoftonline') || currentUrl.includes('signin')) {
      console.log('\n  ログインが必要です。ブラウザでログインしてください。');
      console.log('  ログイン完了後、自動的にメール取得を開始します。');
      console.log('  待機中...\n');

      try {
        await page.waitForURL('**/mail/**', { timeout: 180000 });
        console.log('  ログイン完了！\n');
        await page.waitForTimeout(5000);
      } catch (e) {
        console.log('  タイムアウト。ログインが完了していない可能性があります。');
        await context.close();
        return { success: false, error: 'ログインタイムアウト' };
      }
    } else {
      console.log('  ログイン済み');
    }

    await page.waitForTimeout(5000);

    console.log('[2] 「' + searchKeyword + '」で検索...');
    try {
      const searchBox: any = await page.$('input[aria-label*="検索"], input[aria-label*="Search"], input[placeholder*="検索"], #topSearchInput');
      if (searchBox) {
        await searchBox.click();
        await page.waitForTimeout(1000);
        await searchBox.fill(searchKeyword);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
        console.log('  検索完了');
      } else {
        console.log('  検索ボックスが見つかりません。受信トレイから取得します。');
      }
    } catch (e) {
      console.log('  検索エラー: ' + e.message.substring(0, 60));
    }

    console.log('[3] メール一覧を取得...');
    await page.waitForTimeout(3000);

    const emailList: any = await page.evaluate(() => {
      const items = document.querySelectorAll('[role="listbox"] [role="option"], [aria-label*="メッセージ一覧"] [role="option"], .customScrollBar [role="option"], [data-convid]');
      return Array.from(items).slice(0, 30).map(item => {
        const sender = item.querySelector('[data-testid="SenderName"], .lvHighlightFromClass, .jGG6V')?.textContent?.trim() || '';
        const subject = item.querySelector('[data-testid="Subject"], .lvHighlightSubjectClass, .jGG6V + span, .jGG6V ~ div')?.textContent?.trim() || '';
        const preview = item.querySelector('[data-testid="Preview"], .lvHighlightBodyClass, .CxFDQ')?.textContent?.trim() || '';
        const date = item.querySelector('[data-testid="DateString"], .EeijM, time')?.textContent?.trim() || '';
        const ariaLabel = item.getAttribute('aria-label') || '';
        return { sender, subject, preview, date, ariaLabel: ariaLabel.substring(0, 200) };
      });
    });

    console.log('  取得: ' + emailList.length + '件');

    const detailedEmails: any[] = [];
    const existingData = loadEmails();
    const existingIds = new Set(existingData.emails.map(e => e.id));

    for (let i = 0; i < Math.min(emailList.length, 30); i++) {
      const item = emailList[i];
      if (!item.sender && !item.subject && !item.ariaLabel) continue;

      try {
        const items: any = await page.$$('[role="listbox"] [role="option"], [data-convid]');
        if (items[i]) {
          await items[i].click();
          await page.waitForTimeout(2000);

          const detail: any = await page.evaluate(() => {
            const body = document.querySelector('[role="main"] [aria-label*="メッセージ本文"], .XbIp4, [data-testid="MessageBody"]');
            const from = document.querySelector('[data-testid="SenderPersona"], .wide .bqja2')?.textContent?.trim() || '';
            const to = document.querySelector('[data-testid="ToRecipient"]')?.textContent?.trim() || '';
            const subj = document.querySelector('[role="main"] [data-testid="Subject"], .wide .jGG6V')?.textContent?.trim() || '';
            const dateEl = document.querySelector('[data-testid="SentReceivedSavedTime"], .wide .EeijM, .wide time');
            const dateText = dateEl?.textContent?.trim() || dateEl?.getAttribute('datetime') || '';
            return {
              body: body ? (body as HTMLElement).innerText.substring(0, 2000) : '',
              from, to, subject: subj, date: dateText,
            };
          });

          const id = (detail.from + detail.subject + detail.date).replace(/\s/g, '').substring(0, 100);

          if (!existingIds.has(id)) {
            detailedEmails.push({
              id,
              from: detail.from || item.sender,
              subject: detail.subject || item.subject,
              date: detail.date || item.date,
              preview: item.preview,
              body: detail.body,
              fetchedAt: new Date().toISOString(),
            });
            console.log('  [' + (i + 1) + '] ' + (detail.from || item.sender) + ' | ' + (detail.subject || item.subject || '').substring(0, 40));
          }
        }
      } catch (e) {
        // skip
      }
    }

    const allEmails = [...detailedEmails, ...existingData.emails];
    const unique: any[] = [];
    const seen = new Set<any>();
    for (const e of allEmails) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        unique.push(e);
      }
    }
    unique.sort((a: any, b: any) => {
      const da = new Date(a.fetchedAt || a.date || 0);
      const db = new Date(b.fetchedAt || b.date || 0);
      return db.getTime() - da.getTime();
    });

    saveEmails({ emails: unique, lastFetched: new Date().toISOString() });
    console.log('\n[4] 保存完了: 新規' + detailedEmails.length + '件 / 合計' + unique.length + '件');

    console.log('\nブラウザを閉じてセッションを保存します...');
    await context.close();

    return { success: true, newCount: detailedEmails.length, totalCount: unique.length };

  } catch (e) {
    console.error('エラー:', e.message);
    await context.close();
    return { success: false, error: e.message };
  }
}

module.exports = { fetchEmails, loadEmails };

if (require.main === module) {
  fetchEmails().then(r => console.log('\n結果:', JSON.stringify(r)));
}
