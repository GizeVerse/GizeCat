; Desktop Cat — NSIS customisations (included by electron-builder).
; On a real uninstall (not an upgrade: electron-builder runs the old uninstaller with
; --updated), remove the launch-at-sign-in entry the app writes through Electron's
; setLoginItemSettings (value name = LOGIN_ITEM_NAME in src/main/lifecycle/loginItem.ts).
; User data in %APPDATA%\Desktop Cat is kept.
;
; Reinstall marker: when the entry existed and Windows' Startup apps never toggled it (no
; StartupApproved value), leave $APPDATA\Desktop Cat\login-item-removed-by-uninstall so a
; reinstall registers again instead of reading the missing entry as an opt-out. With a
; StartupApproved value (disabled or re-enabled in Task Manager), or when its presence
; cannot be checked, no marker is written: the reinstalled app then keeps startup off
; until the user turns it on (never silently re-enabled).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $R7
    Push $R8
    Push $R9

    ClearErrors
    ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.enesiltas.desktopcat"
    ${if} ${Errors}
      StrCpy $R8 ""
    ${endIf}
    ; RegGetValueW(HKCU, StartupApproved\Run, name, RRF_RT_ANY, NULL, NULL, NULL): 0 = exists, 2 = absent.
    StrCpy $R9 "error"
    System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", w "io.github.enesiltas.desktopcat", i 0x0000ffff, p 0, p 0, p 0) i .R9'

    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.enesiltas.desktopcat"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.github.enesiltas.desktopcat"

    ${if} $R8 != ""
    ${andIf} $R9 == "2"
      ; Electron keeps user data per user, also for a per-machine install.
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endIf}
      ${if} ${FileExists} "$APPDATA\Desktop Cat\*.*"
        ClearErrors
        FileOpen $R7 "$APPDATA\Desktop Cat\login-item-removed-by-uninstall" w
        ${ifNot} ${Errors}
          FileWrite $R7 "Startup entry removed by the Desktop Cat uninstaller.$\r$\n"
          FileClose $R7
        ${endIf}
      ${endIf}
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endIf}
    ${endIf}

    Pop $R9
    Pop $R8
    Pop $R7
  ${endIf}
!macroend
