'use strict';

const SCRIPT = `(function(){
  var manualUpdateBusy = false;
  var lastUpdateState = null;

  function byId(id) { return document.getElementById(id); }

  function notify(message, tone) {
    if (typeof showToast === 'function') {
      showToast(message, tone || 'info');
    }
  }

  function setUpdateButton(state, data) {
    var btn = byId('updateCheckBtn');
    var label = byId('updateCheckLabel');
    var icon = byId('updateCheckIcon');
    if (!btn || !label) return;

    var disabled = false;
    var text = LANG === 'ja' ? '更新確認' : 'Check updates';
    var title = LANG === 'ja' ? '最新アップデートを確認' : 'Check for the latest update';
    var action = 'check';
    var iconName = 'sync';

    if (state === 'checking') {
      disabled = true;
      text = LANG === 'ja' ? '確認中' : 'Checking';
      title = LANG === 'ja' ? 'アップデートを確認しています' : 'Checking for updates';
      iconName = 'progress_activity';
    } else if (state === 'available' || state === 'downloading') {
      disabled = true;
      text = state === 'downloading'
        ? ((LANG === 'ja' ? '取得中 ' : 'Downloading ') + ((data && data.percent) || 0) + '%')
        : (LANG === 'ja' ? '取得準備中' : 'Update found');
      title = LANG === 'ja' ? 'アップデートをダウンロードしています' : 'Downloading update';
      iconName = 'downloading';
    } else if (state === 'downloaded') {
      text = LANG === 'ja' ? '再起動で更新' : 'Restart to update';
      title = LANG === 'ja' ? 'ダウンロード済みの更新を再起動して適用' : 'Restart and install the downloaded update';
      action = 'install';
      iconName = 'upgrade';
    } else if (state === 'error') {
      text = LANG === 'ja' ? '再確認' : 'Retry update';
      title = (LANG === 'ja' ? '更新確認でエラー: ' : 'Update check error: ') + ((data && data.message) || '');
      iconName = 'sync_problem';
    } else if (state === 'disabled' || state === 'disabled-dev' || state === 'dashboard-only') {
      disabled = true;
      text = LANG === 'ja' ? '更新不可' : 'No updater';
      title = LANG === 'ja' ? 'この実行環境では自動更新を利用できません' : 'Auto-update is not available in this runtime';
      iconName = 'block';
    } else if (state === 'up-to-date') {
      var remote = data && (data.remoteVersion || data.version);
      text = LANG === 'ja' ? '最新版確認' : 'Up to date';
      title = remote
        ? ((LANG === 'ja' ? '確認済み: 最新 ' : 'Checked: latest ') + remote)
        : title;
      iconName = 'task_alt';
    }

    if (manualUpdateBusy) disabled = true;
    btn.disabled = disabled;
    btn.dataset.updateAction = action;
    btn.title = title;
    label.textContent = manualUpdateBusy ? (LANG === 'ja' ? '処理中' : 'Working') : text;
    if (icon) icon.textContent = manualUpdateBusy ? 'progress_activity' : iconName;
    btn.classList.toggle('update-ready', action === 'install');
  }

  async function refreshUpdateControl() {
    try {
      var res = await fetch('/api/update-status');
      var data = await res.json();
      lastUpdateState = data && data.state;
      setUpdateButton(lastUpdateState, data || {});
    } catch (_) {
      setUpdateButton('unknown', {});
    }
  }

  async function manualCheckForUpdate() {
    var btn = byId('updateCheckBtn');
    var action = btn && btn.dataset.updateAction === 'install' ? 'install' : 'check';
    manualUpdateBusy = true;
    setUpdateButton(lastUpdateState, {});
    try {
      var endpoint = action === 'install' ? '/api/install-update' : '/api/check-update';
      var res = await fetch(endpoint, { method: 'POST' });
      var data = await res.json().catch(function(){ return {}; });
      if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
      notify(action === 'install'
        ? (LANG === 'ja' ? '更新を適用するため再起動します。' : 'Restarting to install the update.')
        : (LANG === 'ja' ? 'アップデート確認を開始しました。' : 'Update check started.'),
        'info');
    } catch (e) {
      notify((LANG === 'ja' ? 'アップデート操作に失敗: ' : 'Update action failed: ') + (e && e.message || e), 'error');
    } finally {
      manualUpdateBusy = false;
      setTimeout(refreshUpdateControl, 700);
      setTimeout(refreshUpdateControl, 3000);
    }
  }

  window.manualCheckForUpdate = manualCheckForUpdate;
  window.refreshUpdateControl = refreshUpdateControl;

  var btn = byId('updateCheckBtn');
  if (btn) btn.addEventListener('click', manualCheckForUpdate);
  refreshUpdateControl();
  setInterval(refreshUpdateControl, 60000);
})();`;

module.exports = function renderUpdateCheckControlsScript() {
  return SCRIPT;
};
