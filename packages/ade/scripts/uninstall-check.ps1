<#
  Proves ADE's uninstaller on a CI runner (`.github/workflows/ade-uninstall-check.yml`), never on a person's computer: the setup closes every
  ade-desktop.exe by name and the uninstall removes the hooks in the real ~/.claude, ~/.codex and nikcli.

  It works on the NSIS installer of the TEST identity (`ai.nikcli.ade.test`, `ade-test.exe`, product "ADE Test"), built with
  `tauri.test.conf.json`, so nothing here has the released app's names. The hooks are global and only the released identity removes them
  (`unlink_allowed` in uninstall.rs), so the phases that need them removed set ADE_UNLINK_AGENTS_FOR_TEST=1 for that process; the phase
  `identity` proves that without it nothing is touched.

  One phase per call; each installs, plants what the uninstaller has to treat, checks, and leaves the runner clean:

    silent    silent install and uninstall: ADE's entry, script and plugin go, someone else's entry stays, the caches go, what a plugin saved and
              the data folder stay (the box "delete the data" is off in a silent run)
    identity  the flag of a build that is not the released identity touches nothing
    running   ADE open, passive uninstall: the app is closed BEFORE the removals (a WebView2 cache can only go if nothing holds it)
    update    nothing is removed on an update: the new setup over the old, and the old uninstaller with /UPDATE
    secrets   --delete-secrets takes a planted Credential Manager entry (the box is not reachable in a silent run)

  Exit code 0 when every check of the phase held; otherwise the failed checks are listed and it is 1.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('silent', 'identity', 'running', 'update', 'secrets')]
  [string]$Phase,
  # The folder the NSIS installer was built into.
  [string]$Bundle = 'packages/ade/src-tauri/target/release/bundle/nsis'
)

$ErrorActionPreference = 'Stop'

$Id = 'ai.nikcli.ade.test'
$Product = 'ADE Test'
$Exe = 'ade-test.exe'
$InstallDir = Join-Path $env:LOCALAPPDATA $Product
$Uninstaller = Join-Path $InstallDir 'uninstall.exe'
$Local = Join-Path $env:LOCALAPPDATA $Id
$Roaming = Join-Path $env:APPDATA $Id
$Claude = Join-Path $env:USERPROFILE '.claude'
$HookScript = Join-Path $Claude 'hooks\ade-agent-session.ps1'
$Settings = Join-Path $Claude 'settings.json'

$script:Failures = New-Object System.Collections.Generic.List[string]

function Check([bool]$Condition, [string]$What) {
  if ($Condition) { Write-Host "ok    $What" } else { Write-Host "FAIL  $What"; $script:Failures.Add($What) }
}

function Write-Text([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  # UTF-8 without a BOM: the hook files are read by serde and by other programs.
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Setup-Path {
  $found = Get-ChildItem -Path $Bundle -Filter '*-setup.exe' | Select-Object -First 1
  if (-not $found) { throw "no setup in $Bundle" }
  return $found.FullName
}

function Install([string[]]$Arguments = @('/S')) {
  $run = Start-Process -FilePath (Setup-Path) -ArgumentList $Arguments -Wait -PassThru
  Check ($run.ExitCode -eq 0) "setup $($Arguments -join ' ') exited 0 (was $($run.ExitCode))"
  Check (Test-Path (Join-Path $InstallDir $Exe)) "$Exe is installed"
}

# `_?=<dir>` makes the uninstaller run in place and wait: without it NSIS copies itself to %TEMP% and this returns at once. It has to be last,
# and its path is not quoted.
function Uninstall([string[]]$Arguments = @('/S')) {
  $run = Start-Process -FilePath $Uninstaller -ArgumentList ($Arguments + "_?=$InstallDir") -Wait -PassThru
  return $run.ExitCode
}

# What the uninstaller has to treat: ADE's hook beside somebody else's in Claude Code's file, the script, downloads and caches, a plugin's
# saved document and a file in the data folder.
function Plant {
  Write-Text $HookScript '# ade'
  $settings = [ordered]@{
    theme = 'dark'
    hooks = [ordered]@{
      SessionStart = @(
        [ordered]@{
          matcher = 'startup'
          hooks = @(
            [ordered]@{ type = 'command'; command = 'powershell'; args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $HookScript); timeout = 10 },
            [ordered]@{ type = 'command'; command = 'notify-mine' }
          )
        }
      )
    }
  }
  Write-Text $Settings (($settings | ConvertTo-Json -Depth 10) + "`n")
  foreach ($file in @('tts\piper\piper.exe', 'tts\voices\ugo.onnx', 'nikverse-assets\world\city.glb', 'plugins\alpha\1.0.0\index.html', 'plugins\alpha\current', 'EBWebView\Default\Local Storage\leveldb\000003.log')) {
    Write-Text (Join-Path $Local $file) ('x' * 64)
  }
  Write-Text (Join-Path $Local 'plugins\alpha\storage.json') '{"saved":true}'
  Write-Text (Join-Path $Roaming 'keep.txt') 'mine'
  Check ((Get-Content $Settings -Raw) -match 'ade-agent-session') 'planted: ADE entry in settings.json'
}

function Clear-Planted {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Local, $Roaming, (Join-Path $Claude 'hooks'), $Settings
}

function Entry-Present { return ((Get-Content $Settings -Raw) -match 'ade-agent-session') }
function Other-Kept { return ((Test-Path $Settings) -and ((Get-Content $Settings -Raw) -match 'notify-mine')) }

# Nothing the uninstaller removes is gone: for the phases that prove an update or a refusal.
function Check-Untouched([string]$When) {
  Check (Entry-Present) "$When`: ADE's entry is still in settings.json"
  Check (Test-Path $HookScript) "$When`: the hook script is still there"
  Check (Test-Path (Join-Path $Local 'tts\piper\piper.exe')) "$When`: the voices are still there"
  Check (Test-Path (Join-Path $Local 'nikverse-assets\world\city.glb')) "$When`: the assets are still there"
  Check (Test-Path (Join-Path $Local 'plugins\alpha\1.0.0\index.html')) "$When`: the plugin files are still there"
}

function Finish {
  if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host "$($script:Failures.Count) check(s) failed in phase '$Phase':"
    $script:Failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
  }
  Write-Host "phase '$Phase': every check held"
}

# The proving job says so: a build that is not the released identity takes the hooks only then.
$env:ADE_UNLINK_AGENTS_FOR_TEST = $null
Clear-Planted

switch ($Phase) {

  'silent' {
    Install
    Plant
    $env:ADE_UNLINK_AGENTS_FOR_TEST = '1'
    $code = Uninstall @('/S')
    $env:ADE_UNLINK_AGENTS_FOR_TEST = $null
    Check ($code -eq 0) "the uninstaller exited 0 (was $code)"
    Check (-not (Entry-Present)) "ADE's entry is out of settings.json"
    Check (Other-Kept) "the other program's entry is still in settings.json"
    Check (-not (Test-Path $HookScript)) 'the hook script is gone'
    Check (-not (Test-Path (Join-Path $Claude 'hooks'))) 'the folder the hook was in, empty, is gone'
    Check (-not (Test-Path (Join-Path $Local 'tts'))) 'the voices are gone'
    Check (-not (Test-Path (Join-Path $Local 'nikverse-assets'))) 'the assets are gone'
    Check (-not (Test-Path (Join-Path $Local 'plugins\alpha\1.0.0'))) 'the plugin files are gone'
    Check (Test-Path (Join-Path $Local 'plugins\alpha\storage.json')) 'what the plugin saved stays'
    Check (Test-Path (Join-Path $Local 'EBWebView\Default\Local Storage\leveldb\000003.log')) "the page's local storage stays"
    Check (Test-Path (Join-Path $Roaming 'keep.txt')) 'the data folder stays: the box is off in a silent run'
    Check (-not (Test-Path (Join-Path $InstallDir $Exe))) "$Exe is removed"
  }

  'identity' {
    Install
    Plant
    $run = Start-Process -FilePath (Join-Path $InstallDir $Exe) -ArgumentList '--unlink-agents' -Wait -PassThru
    Check ($run.ExitCode -eq 0) "--unlink-agents without the proving variable exits 0 (was $($run.ExitCode))"
    Check-Untouched 'a build that is not the released identity'
    # And the uninstall of it, without the variable, leaves the hooks too.
    $code = Uninstall @('/S')
    Check ($code -eq 0) "the uninstaller exited 0 (was $code)"
    Check (Entry-Present) "the uninstall of a test identity leaves the hooks of other programs"
    Check (-not (Test-Path (Join-Path $Local 'tts'))) 'its own downloads still go'
  }

  'running' {
    Install
    Plant
    $app = Start-Process -FilePath (Join-Path $InstallDir $Exe) -PassThru
    # Reading the handle keeps it, so that the exit time is still there once the process is gone.
    $null = $app.Handle
    # The app has to be up, with its WebView2 profile open: that is what would hold the cache files if the hook ran with it still open.
    $cache = Join-Path $Local 'EBWebView\Default\Cache'
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline -and -not ((Get-Process -Name 'ade-test' -ErrorAction SilentlyContinue) -and (Test-Path $cache))) { Start-Sleep -Seconds 2 }
    Check ([bool](Get-Process -Name 'ade-test' -ErrorAction SilentlyContinue)) 'the app is open before the uninstall'
    Check (Test-Path $cache) 'its WebView2 cache exists before the uninstall (without it this phase proves nothing)'
    $env:ADE_UNLINK_AGENTS_FOR_TEST = '1'
    # Passive: the template closes the app without asking (interactively it asks, and Cancel stops before the hook; the question is the hook's
    # first line, which uninstall.rs pins).
    $code = Uninstall @('/P')
    $env:ADE_UNLINK_AGENTS_FOR_TEST = $null
    Check ($code -eq 0) "the uninstaller exited 0 (was $code)"
    Check (-not (Get-Process -Name 'ade-test' -ErrorAction SilentlyContinue)) 'the app is closed'
    # The order, proved by the clock: the hook rewrote settings.json (ADE's entry went), and the app had already exited by then. The cache
    # being gone is not proof of it on its own: Chromium opens its files with delete sharing, and Rust removes them the POSIX way.
    $null = $app.WaitForExit(30000)
    Check $app.HasExited 'the app we started has exited'
    $rewritten = (Get-Item $Settings).LastWriteTime
    $exited = if ($app.HasExited) { $app.ExitTime } else { [DateTime]::MaxValue }
    Check ($exited -le $rewritten) "the app exited ($($exited.ToString('o'))) before the hook rewrote settings.json ($($rewritten.ToString('o')))"
    Check (-not (Test-Path $cache)) 'the WebView2 cache is gone'
    Check (-not (Test-Path (Join-Path $Local 'tts'))) 'the voices are gone'
    Check (-not (Entry-Present)) "ADE's entry is out of settings.json"
    Check (Other-Kept) "the other program's entry is still in settings.json"
  }

  'update' {
    Install
    Plant
    $env:ADE_UNLINK_AGENTS_FOR_TEST = '1'
    # The new version over the old, the way the updater runs it.
    Install @('/S', '/UPDATE')
    Check-Untouched 'after the new setup over the old'
    # The old uninstaller started with /UPDATE, as a reinstall can start it.
    $code = Uninstall @('/S', '/UPDATE')
    Check ($code -eq 0) "the uninstaller with /UPDATE exited 0 (was $code)"
    Check-Untouched 'after the uninstaller with /UPDATE'
    Check (Test-Path (Join-Path $Roaming 'keep.txt')) 'the data folder is untouched'
    # Leave the runner clean: a real uninstall.
    Uninstall @('/S') | Out-Null
    $env:ADE_UNLINK_AGENTS_FOR_TEST = $null
  }

  'secrets' {
    Install
    # keyring's Windows target is `<name>.<service>`; the index is what names what to delete.
    $name = 'testkey'
    $target = "$name.$Id.secrets"
    Write-Text (Join-Path $Roaming 'secrets-index.json') ('{"keys":[{"name":"' + $name + '","env":"TEST_API_KEY","agents":[],"createdMs":1}]}')
    cmdkey /generic:$target /user:$name /pass:not-a-real-secret | Out-Null
    $before = (cmdkey /list:$target | Out-String)
    Check ($before -match [regex]::Escape($target)) 'planted: the entry is in the Credential Manager'
    $run = Start-Process -FilePath (Join-Path $InstallDir $Exe) -ArgumentList '--delete-secrets' -Wait -PassThru
    Check ($run.ExitCode -eq 0) "--delete-secrets exited 0 (was $($run.ExitCode))"
    $after = (cmdkey /list:$target | Out-String)
    Check (-not ($after -match [regex]::Escape($target))) 'the entry is gone from the Credential Manager'
    Check (Test-Path (Join-Path $Roaming 'secrets-index.json')) 'the index is left to the folder removal'
    cmdkey /delete:$target 2>$null | Out-Null
    Uninstall @('/S') | Out-Null
  }
}

Clear-Planted
Finish
