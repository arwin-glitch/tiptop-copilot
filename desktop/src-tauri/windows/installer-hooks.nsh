; TipTop Kraken installer hooks (bundle.windows.nsis.installerHooks in
; tauri.conf.json). Tauri's NSIS template inserts these macros into its own
; script, so ${PRODUCTNAME}, ${MAINBINARYNAME} and $INSTDIR are the new app's.
;
; From 0.5.0 the app is named TipTop Kraken. Up to 0.4.2 it was TipTop
; Copilot, and the installer keys everything on the product name: the install
; folder (%LOCALAPPDATA%\TipTop Copilot), the Start menu and desktop
; shortcuts, and the Add or Remove Programs entry. Installing 0.5.0, by hand
; or through 0.4.2's own updater, puts TipTop Kraken next to it, so once the
; new app is in place this removes the old one.
;
; It never runs the old uninstaller, which can delete the app's data, and it
; never touches the data folders %APPDATA%\vc.tiptop.copilot and
; %LOCALAPPDATA%\vc.tiptop.copilot (the WebView profile with the sign-in, the
; window's place, the desktop alerts token): those are keyed on the
; identifier, which did not change. It deletes only:
;   - the old install folder, and only when its name ends in "TipTop Copilot",
;     it is not where this installer just put the new app, and it holds the
;     old uninstall.exe;
;   - the old Start menu and desktop shortcuts ("TipTop Copilot.lnk"), each
;     replaced by a "TipTop Kraken.lnk" (update mode makes no new ones);
;   - the old Add or Remove Programs entry and installer key.
; Shortcuts and registry entries go only once the old folder is gone, so a
; folder that could not be removed keeps its uninstaller entry. A desktop
; shortcut the old app had comes back as "TipTop Kraken", and a taskbar pin
; is pointed at the new app. Everything is a no-op when no old install is
; there, so running it on every install, and again, is safe.
;
; tests/unit/desktop-installer-hooks.test.ts checks this file is wired in and
; never names the identifier's data folders.

!ifndef KRAKEN_OLD_NAME
!define KRAKEN_OLD_NAME "TipTop Copilot"
!define KRAKEN_OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TipTop Copilot"
!define KRAKEN_OLD_PRODUCTKEY "Software\TipTop Ventures\TipTop Copilot"
!define KRAKEN_OLD_PIN "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\TipTop Copilot.lnk"
!endif

; In-app updates must replace the program files (seen Nov 2 2026, 0.5.0 to
; 0.5.1): the updater starts this installer and ends the app at once, but the
; app's process can take a few seconds to finish ending, and until it has,
; Windows will not let anything write over its .exe. Tauri's template copies
; the files right after this hook, guarded only by a Restart Manager check,
; and that check found nothing to close while the copy then failed. The
; template writes the new version into Add or Remove Programs either way, so
; the old app came back while Windows reported the new one.
;
; So before the copy, this waits up to 20 seconds for the .exe and
; uninstall.exe to be writable. Only for an update (the user chose Restart
; now, so the app is meant to be closed) does it end a copy still running
; after 5 seconds. A first install or a reinstall by hand keeps the template's
; own "close the app?" question. If the files are still locked after 20
; seconds, the template's copy shows its Retry / Ignore box as before.
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2

  StrCpy $R1 0
  kraken_wait_loop:
    StrCpy $R2 0
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 kraken_wait_exe_ok
      ClearErrors
      FileOpen $R0 "$INSTDIR\${MAINBINARYNAME}.exe" a
      IfErrors kraken_wait_exe_locked
      FileClose $R0
      Goto kraken_wait_exe_ok
    kraken_wait_exe_locked:
      StrCpy $R2 1
    kraken_wait_exe_ok:
    IfFileExists "$INSTDIR\uninstall.exe" 0 kraken_wait_un_ok
      ClearErrors
      FileOpen $R0 "$INSTDIR\uninstall.exe" a
      IfErrors kraken_wait_un_locked
      FileClose $R0
      Goto kraken_wait_un_ok
    kraken_wait_un_locked:
      StrCpy $R2 1
    kraken_wait_un_ok:
    StrCmp $R2 0 kraken_wait_done
    IntCmp $R1 40 kraken_wait_gave_up 0 kraken_wait_gave_up
    ; After 5 seconds (10 tries), an update ends the app if it is still there.
    IntCmp $R1 10 0 kraken_wait_sleep kraken_wait_sleep
    StrCmp $UpdateMode 1 0 kraken_wait_sleep
      DetailPrint "Closing ${PRODUCTNAME} so it can be updated"
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${MAINBINARYNAME}.exe'
      Pop $R0
    kraken_wait_sleep:
    Sleep 500
    IntOp $R1 $R1 + 1
    Goto kraken_wait_loop

  kraken_wait_gave_up:
  DetailPrint "${PRODUCTNAME}'s files are still in use"
  kraken_wait_done:

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2

  ; The copy must really have happened. The template has already written
  ; ${VERSION} into Add or Remove Programs; if the .exe is not that version,
  ; put back the version actually there and say so. The app the installer
  ; starts next is then the old one, which offers the update again.
  ClearErrors
  ${GetFileVersion} "$INSTDIR\${MAINBINARYNAME}.exe" $R0
  IfErrors kraken_version_ok
  StrCmp $R0 "${VERSIONWITHBUILD}" kraken_version_ok
    ; "0.5.0.0" is shown as "0.5.0".
    ${WordFind} "$R0" "." "-1{" $R1
    WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "$R1"
    DetailPrint "${MAINBINARYNAME}.exe is still $R1, not ${VERSION}"
    MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCTNAME} could not be updated to ${VERSION} because its files were in use. Nothing was changed. Try again from Check for Updates, or download the newest version from copilot.tiptop.vc/download." /SD IDOK
  kraken_version_ok:

  ; Where the old app was installed: the installer key's default value (the
  ; folder), else the default per-user folder.
  ClearErrors
  ReadRegStr $R0 HKCU "${KRAKEN_OLD_PRODUCTKEY}" ""
  StrCmp $R0 "" 0 kraken_have_dir
    StrCpy $R0 "$LOCALAPPDATA\${KRAKEN_OLD_NAME}"
  kraken_have_dir:
  ; No quotes and no trailing backslash.
  StrCpy $R1 $R0 1
  StrCmp $R1 '"' 0 +2
    StrCpy $R0 $R0 "" 1
  StrCpy $R1 $R0 1 -1
  StrCmp $R1 '"' 0 +2
    StrCpy $R0 $R0 -1
  StrCpy $R1 $R0 1 -1
  StrCmp $R1 "\" 0 +2
    StrCpy $R0 $R0 -1

  ; Only a folder named "...TipTop Copilot" that is not the new app's own and
  ; holds the old uninstaller is ever deleted.
  IfFileExists "$R0\*.*" 0 kraken_old_dir_gone
  StrCpy $R1 $R0 "" -14
  StrCmp $R1 "${KRAKEN_OLD_NAME}" 0 kraken_keep
  StrCmp $R0 $INSTDIR kraken_keep
  IfFileExists "$R0\uninstall.exe" 0 kraken_keep

  DetailPrint "Removing ${KRAKEN_OLD_NAME} from $R0"
  ; 0.4.2's updater exits before this installer runs; a copy opened by hand
  ; may still be running. The new app has not started yet (the installer
  ; starts it after this section), and this runs only while the old folder
  ; is there.
  ; Labels, not relative jumps: a plugin call is several instructions. Each
  ; call leaves taskkill's exit code on the stack.
  IfFileExists "$R0\tiptop-copilot-desktop.exe" 0 kraken_no_old_exe
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM tiptop-copilot-desktop.exe'
    Pop $R2
  kraken_no_old_exe:
  IfFileExists "$R0\${KRAKEN_OLD_NAME}.exe" 0 kraken_no_named_exe
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${KRAKEN_OLD_NAME}.exe"'
    Pop $R2
  kraken_no_named_exe:
  Sleep 1000
  RMDir /r "$R0"
  IfFileExists "$R0\*.*" 0 kraken_old_dir_gone
    ; Something held a file open. Try once more, then leave it all, uninstall
    ; entry included, so it can still be removed from Settings.
    Sleep 2000
    RMDir /r "$R0"
    IfFileExists "$R0\*.*" kraken_keep kraken_old_dir_gone

  kraken_old_dir_gone:
  ; Start menu: replaced by the new name if the old one was there (also as it
  ; would sit in a folder of its own). This matters on the updater path:
  ; 0.4.2's updater runs this installer with /UPDATE, and in update mode
  ; Tauri's template only refreshes a "${PRODUCTNAME}.lnk" that already
  ; exists, so without this the update would leave no Start menu entry at
  ; all. Windows toasts need that shortcut's AppUserModelID, so it would also
  ; silently end desktop alerts. No Start menu folder is configured, so this
  ; is where the template itself puts the shortcut on a fresh install.
  StrCpy $R2 0
  IfFileExists "$SMPROGRAMS\${KRAKEN_OLD_NAME}.lnk" 0 kraken_no_old_sm
    StrCpy $R2 1
    Delete "$SMPROGRAMS\${KRAKEN_OLD_NAME}.lnk"
  kraken_no_old_sm:
  IfFileExists "$SMPROGRAMS\${KRAKEN_OLD_NAME}\${KRAKEN_OLD_NAME}.lnk" 0 kraken_no_old_sm_dir
    StrCpy $R2 1
    Delete "$SMPROGRAMS\${KRAKEN_OLD_NAME}\${KRAKEN_OLD_NAME}.lnk"
  kraken_no_old_sm_dir:
  RMDir "$SMPROGRAMS\${KRAKEN_OLD_NAME}"
  StrCmp $R2 1 0 kraken_sm_done
  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" kraken_sm_done 0
    CreateDirectory "$SMPROGRAMS"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ; No !ifmacrodef guard: if the template ever drops or renames this macro,
    ; the Windows build must fail rather than ship shortcuts without the
    ; AppUserModelID that toasts need.
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  kraken_sm_done:
  ; Desktop: replaced by the new name only if the old one was there.
  IfFileExists "$DESKTOP\${KRAKEN_OLD_NAME}.lnk" 0 kraken_no_desktop
    Delete "$DESKTOP\${KRAKEN_OLD_NAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  kraken_no_desktop:
  ; A taskbar pin is a shortcut Windows keeps by this file name. Pointing it
  ; at the new app keeps the pin working (with the new icon) instead of
  ; leaving one that opens nothing; Windows cannot pin anything new for us.
  IfFileExists "${KRAKEN_OLD_PIN}" 0 kraken_no_pin
    CreateShortcut "${KRAKEN_OLD_PIN}" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${KRAKEN_OLD_PIN}"
  kraken_no_pin:
  DeleteRegKey HKCU "${KRAKEN_OLD_UNINSTKEY}"
  DeleteRegKey HKCU "${KRAKEN_OLD_PRODUCTKEY}"
  Goto kraken_done

  kraken_keep:
  DetailPrint "Left ${KRAKEN_OLD_NAME} in $R0 as it was"

  kraken_done:
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
