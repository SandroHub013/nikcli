; Installer hooks (Tauri's `installerHooks`), included by the NSIS template.
;
; Uninstalling ADE takes ADE out of the programs it was put into, and the downloads off the disk. The work is the app's own executable's, with
; one flag each (`src/uninstall.rs`): the installer only launches them, waits, and goes on whatever they say.
;
; None of it on an update. The template starts the old version's uninstaller with /UPDATE when a new version is installed over it, and that is
; not a removal: the new version needs its hooks in Claude Code and Codex, its voices and its keys. `$UpdateMode` is 1 then.
;
; The hook runs before the template deletes the executable, which is why it is PREUNINSTALL: after it, there is nothing left to launch.
;
; The template asks "ADE is open, close it?" only AFTER this hook, and the answer can be Cancel. So the same question is asked here first, as the
; very first thing: Cancel stops the uninstall before anything is gone, and the removals below run with ADE closed (its WebView2 and Piper files
; are not locked, and it cannot write more of them). The template's own check, after the hook, then finds nothing running and asks nothing.
;
; The installer is per user (no `installMode` in tauri.conf.json, which makes it `currentUser`): the uninstaller runs as the user whose home it
; cleans. Under `perMachine` an elevated uninstaller could be another account, and these flags would clean the wrong home. A test in
; `src/uninstall.rs` fails if the mode changes.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    ; ADE's hooks and plugin out of Claude Code, Codex and nikcli.
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --unlink-agents'
    ; What it downloaded and can download again: the voices, NikVerse's assets, the plugins' files, the WebView caches.
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --clean-caches'
    ; The keys and bot tokens in the system keychain go only with "elimina i dati": someone who ticked it wants nothing left. The names of
    ; what to delete are in the data folders, which the template removes after this hook, so it has to be done first.
    ${If} $DeleteAppDataCheckboxState = 1
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --delete-secrets'
    ${EndIf}
  ${EndIf}
!macroend
