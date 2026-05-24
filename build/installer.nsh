; ============================================================================
; Sales Claw — Custom NSIS installer hook
; ============================================================================
;
; Goal: launch the app right after installation finishes,
;       but only after every file has actually landed on disk.
;
; History (do not regress):
;   v1.2.5 / v1.2.6 / v1.2.7 / v1.2.8 — three consecutive incidents where
;   electron-builder's `runAfterFinish: true` auto-launched the app before
;   NSIS finished writing transitive node_modules (universalify / node-pty /
;   ws / xlsx ...), causing "Cannot find module" crashes on first start.
;   That is why `nsis.runAfterFinish` is hard-coded to `false` and we
;   instead launch the app from this custom macro, AFTER an explicit
;   integrity check + safety delay.
;
; The macro runs only on fresh install / upgrade. It does NOT run during
; an electron-updater initiated install (that one auto-relaunches on its
; own via app.relaunch()).
; ============================================================================

!macro customInstall
  ; -------------------------------------------------------------------------
  ; Skip auto-launch when the installer is invoked silently — e.g. by
  ; electron-updater during an auto-update. The updater calls
  ; `quitAndInstall()` which then relaunches the app on its own, so we
  ; must not double-launch.
  ;
  ; Note: use native `IfSilent` instruction (jumps if silent) rather than
  ; the LogicLib `${IfSilent}` wrapper — electron-builder's NSIS script
  ; does not auto-include LogicLib.nsh inside the customInstall macro
  ; scope, so using ${IfSilent} produces "Invalid command" at compile time.
  ; -------------------------------------------------------------------------
  IfSilent customInstall_end

  ; -------------------------------------------------------------------------
  ; Wait until critical files are physically on disk.
  ; We probe the main entry point and a few transitive dependencies that
  ; have historically been the last to land. Up to ~6s total.
  ; -------------------------------------------------------------------------
  StrCpy $0 0
  customInstall_wait:
    IntOp $0 $0 + 1
    Sleep 300
    IfFileExists "$INSTDIR\resources\app\electron-main.js" 0 customInstall_retry
    IfFileExists "$INSTDIR\resources\app\dist-ts\electron-main.js" 0 customInstall_retry
    IfFileExists "$INSTDIR\resources\app\node_modules\electron-updater\package.json" 0 customInstall_retry
    Goto customInstall_ready
  customInstall_retry:
    ${If} $0 < 20
      Goto customInstall_wait
    ${EndIf}
    ; Time-out: launch anyway. Worst case the user re-opens from Start menu.

  customInstall_ready:
    ; Extra safety buffer for slower disks / on-demand AV scans.
    Sleep 1500
    ; Launch as the current (non-elevated) user. Using ExecShell with
    ; "open" lets Windows pick the desktop shell's privileges instead of
    ; the elevated installer process — important so the new Sales Claw
    ; window inherits the user session, not SYSTEM.
    ExecShell "" "$INSTDIR\${PRODUCT_FILENAME}.exe"

  customInstall_end:
!macroend
