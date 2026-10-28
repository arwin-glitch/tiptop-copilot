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

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2

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
