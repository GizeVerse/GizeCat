; Desktop Cat — NSIS customisations (included by electron-builder).
; On a real uninstall (not an upgrade), remove the optional launch-at-login entry the
; app writes through Electron's setLoginItemSettings (value name = LOGIN_ITEM_NAME in
; src/main/lifecycle/loginItem.ts). User data in %APPDATA%\Desktop Cat is kept.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.enesiltas.desktopcat"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.github.enesiltas.desktopcat"
  ${endIf}
!macroend
