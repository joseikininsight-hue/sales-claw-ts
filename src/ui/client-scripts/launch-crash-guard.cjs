'use strict';

/**
 * Defensive wrappers for the AI launch modal.
 *
 * The main dashboard bundle is intentionally left as-is because it is shared
 * by the desktop and preview surfaces. This small post-load guard reduces the
 * two crash-prone user paths:
 * - rapid provider/model switching, which can fan out setup diagnostics
 * - double-click launch, which can create back-to-back PTY restarts
 */

const SCRIPT = `(function(){
  if (window.__salesClawLaunchCrashGuard) return;
  window.__salesClawLaunchCrashGuard = true;

  var diagnosticsDelayMs = 180;
  var diagnosticsTimer = null;
  var diagnosticsInFlight = null;
  var diagnosticsResolvers = [];
  var launching = false;
  var lastClientErrorAt = 0;

  function showGuardToast(message, type) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(message, type || 'warning');
      }
    } catch (_) {}
  }

  function resolveAllDiagnostics(value) {
    var resolvers = diagnosticsResolvers.splice(0);
    resolvers.forEach(function(resolve){ try { resolve(value); } catch (_) {} });
  }

  function setLaunchButtonsBusy(busy) {
    ['launchConfirmBtn', 'launchExternalBtn'].forEach(function(id){
      var el = document.getElementById(id);
      if (!el) return;
      el.disabled = !!busy;
      el.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
    document.querySelectorAll('.launch-provider-card,.launch-mode-card').forEach(function(el){
      el.classList.toggle('is-busy', !!busy);
      el.setAttribute('aria-disabled', busy ? 'true' : 'false');
    });
  }

  function wrapGlobal(name, factory) {
    var original = window[name];
    if (typeof original !== 'function' || original.__salesClawGuarded) return false;
    var wrapped = factory(original);
    wrapped.__salesClawGuarded = true;
    window[name] = wrapped;
    return true;
  }

  wrapGlobal('loadLaunchSetupDiagnostics', function(original){
    return function(providerId) {
      var args = arguments;
      var self = this;
      clearTimeout(diagnosticsTimer);
      return new Promise(function(resolve) {
        diagnosticsResolvers.push(resolve);
        diagnosticsTimer = setTimeout(function(){
          if (diagnosticsInFlight) {
            diagnosticsInFlight.finally(function(){ resolveAllDiagnostics(null); });
            return;
          }
          diagnosticsInFlight = Promise.resolve()
            .then(function(){ return original.apply(self, args); })
            .catch(function(error){
              console.warn('[launch-guard] setup diagnostics failed:', error && error.message || error);
              return null;
            })
            .finally(function(){
              diagnosticsInFlight = null;
              resolveAllDiagnostics(null);
            });
        }, diagnosticsDelayMs);
      });
    };
  });

  function guardLaunchFunction(original) {
    return async function() {
      if (launching) {
        showGuardToast('AI 起動処理中です。完了まで少しお待ちください。', 'info');
        return null;
      }
      launching = true;
      setLaunchButtonsBusy(true);
      try {
        return await original.apply(this, arguments);
      } catch (error) {
        console.error('[launch-guard] launch failed:', error);
        showGuardToast('AI 起動中にエラーが発生しました: ' + (error && error.message || error), 'error');
        return null;
      } finally {
        launching = false;
        setLaunchButtonsBusy(false);
      }
    };
  }

  wrapGlobal('confirmLaunch', guardLaunchFunction);
  wrapGlobal('confirmExternalLaunch', guardLaunchFunction);

  wrapGlobal('selectLaunchProvider', function(original){
    return function() {
      if (launching) return null;
      try { return original.apply(this, arguments); }
      catch (error) {
        console.error('[launch-guard] provider selection failed:', error);
        showGuardToast('AI の選択を反映できませんでした。画面を再読み込みして再試行してください。', 'error');
        return null;
      }
    };
  });

  ['error', 'unhandledrejection'].forEach(function(type){
    window.addEventListener(type, function(event){
      var now = Date.now();
      var detail = type === 'error'
        ? (event && event.message)
        : (event && event.reason && (event.reason.message || event.reason));
      console.warn('[client-error]', type, detail || event);
      if (now - lastClientErrorAt > 8000) {
        lastClientErrorAt = now;
        showGuardToast('画面側の一時エラーを検知しました。処理は継続できます。', 'warning');
      }
    });
  });
})();`;

module.exports = function renderLaunchCrashGuardScript() {
  return SCRIPT;
};
