; Desktop Cat — NSIS customisations (included by electron-builder).
; 1.4.0: the ARM64 installer also stops on PCs that are not Windows on Arm (customInit, at the end).
;
; On a real uninstall (not an upgrade: electron-builder runs the old uninstaller with
; --updated), remove the launch-at-sign-in entry the app writes through Electron's
; setLoginItemSettings (value name = LOGIN_ITEM_NAME in src/main/lifecycle/loginItem.ts).
; User data in %APPDATA%\Desktop Cat is kept.
;
; Reinstall marker (UNINSTALL_MARKER_FILE in loginItem.ts): when the uninstaller removes an
; entry that Windows would have started, it leaves $APPDATA\Desktop Cat\login-item-removed-by-uninstall
; (only if that folder exists), so a reinstall registers again instead of reading the missing
; entry as an opt-out; the app deletes the marker once it has registered. "Would have
; started" uses Electron's StartupApproved rule (docs/research/v1.1/startup.md §2): no
; StartupApproved value, or one whose first byte is 00, or 02 followed by 00. With a Task
; Manager disable (03 + FILETIME and anything else), without a Run value, or when the value
; cannot be read, no marker is written: the reinstalled app then keeps startup off until the
; user turns it on (an opt-out is never silently undone).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    Push $R9

    ClearErrors
    ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.enesiltas.desktopcat"
    ${if} ${Errors}
      StrCpy $R8 ""
    ${endIf}

    ; StartupApproved state: absent / enabled / disabled / unknown. RegGetValueW(HKCU, key, name,
    ; RRF_RT_ANY, NULL, buffer, &cb): 0 = read, 2 = absent, anything else (234 = larger than
    ; the buffer, 5 = access denied) = unknown. HKCU is 0x80000001 (this uninstaller is 32-bit).
    StrCpy $R6 "unknown"
    System::Alloc 64
    Pop $R5
    ${if} $R5 != 0
      ; Zero the two bytes that are judged, so a 1-byte value reads as <byte> 00.
      System::Call '*$R5(&i1 0, &i1 0)'
      System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", w "io.github.enesiltas.desktopcat", i 0x0000ffff, p 0, p R5, *i 64) i .R9'
      ${if} $R9 == 2
        StrCpy $R6 "absent"
      ${elseIf} $R9 == 0
        System::Call '*$R5(&i1 .R3, &i1 .R4)'
        IntOp $R3 $R3 & 0xff
        IntOp $R4 $R4 & 0xff
        ${if} $R3 == 0
          StrCpy $R6 "enabled"
        ${elseIf} $R3 == 2
          ${if} $R4 == 0
            StrCpy $R6 "enabled"
          ${else}
            StrCpy $R6 "disabled"
          ${endIf}
        ${else}
          StrCpy $R6 "disabled"
        ${endIf}
      ${endIf}
      System::Free $R5
    ${endIf}

    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.enesiltas.desktopcat"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.github.enesiltas.desktopcat"

    ${if} $R8 != ""
      ${if} $R6 == "absent"
      ${orIf} $R6 == "enabled"
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
    ${endIf}

    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
  ${endIf}
!macroend

; Windows on Arm guard (1.4.0). electron-builder builds one installer per architecture
; (buildUniversalInstaller: false). The ARM64 one (APP_ARM64 defined, APP_64 not) has no
; architecture check of its own: on x64 or 32-bit Windows its templates would find no package
; for the PC (extractAppPackage.nsh identify_package) and extract nothing. It stops here instead,
; in .onInit before anything is written. Silent runs (/S) skip the message and exit with code 1.
; The x64 installer defines APP_64, so this macro does not exist there and its behaviour is the
; same as before. ${IsNativeARM64} comes from NSIS x64.nsh (IsWow64Process2 native machine), which
; electron-builder's common.nsh includes before .onInit expands this macro.
!ifdef APP_ARM64
  !ifndef APP_64
    !macro customInit
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "This Desktop Cat installer is for Windows on Arm (ARM64) PCs. On this PC, use the x64 installer instead: Desktop-Cat-Setup-${VERSION}-x64.exe" /SD IDOK
        SetErrorLevel 1
        Quit
      ${EndIf}
    !macroend
  !endif
!endif
