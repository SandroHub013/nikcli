import { describe, expect, it } from "bun:test"
import { Shell } from "@/shell/shell"

/**
 * Every command nikcli 1.401.0 sent through the bash tool during the benchmark sweep, with what
 * happened to it on Windows: `routedToPowerShellIn1401` is the dialect 1.401.0's marker set picked,
 * `powershellParseError` is PowerShell 5.1 refusing to parse the line, and `failed` is the tool
 * call reporting a non-zero exit.
 *
 * The fixture is the reason these two rules are written down: 1.401.0 sent 84 commands to
 * PowerShell and 41 of them came back unparsed, because its marker set fired on any `$var` and so
 * sent ordinary bash to PowerShell.
 */
type Recorded = {
  command: string
  /** `null` in the arm where PowerShell was not available, so no dialect was ever chosen. */
  routedToPowerShellIn1401: boolean | null
  failed: boolean
  powershellParseError: boolean
  source: string
}

const commands = (await Bun.file(new URL("fixtures/bash-commands.json", import.meta.url)).json()) as Recorded[]

/**
 * A `Verb-Noun` cmdlet standing where a command is expected.
 *
 * Written out here rather than imported from the implementation: the point of the test is the
 * rule, so the rule has to exist twice. The command-position requirement is what makes it a
 * cmdlet — `# out-of-order` inside an embedded Python file is prose, not a `Get-Item` call.
 */
const CMDLET_AT_COMMAND_POSITION =
  /(?:^|[\n;&|({=]|\b(?:then|do|else)\b)[ \t]*(?:Add|Backup|Block|Clear|Compare|Compress|Complete|Convert|Copy|Deny|Disable|Enter|Exit|Expand|Export|ForEach|Format|Get|Grant|Group|Hash|Import|Initialize|Install|Invoke|Join|Measure|Move|New|Out|Protect|Publish|Push|Read|Register|Remove|Rename|Request|Reset|Resolve|Restart|Resume|Revoke|Save|Search|Select|Set|Show|Sort|Split|Start|Step|Stop|Sync|Test|Trace|Unblock|Unlock|Unregister|Update|Use|Wait|Watch|Where|Write)-[A-Za-z]+/

/**
 * `powershellParseError` is a heuristic over the captured output, and it fires on one kind of
 * false positive: PowerShell 5.1 wraps a native command's stderr in an error record that carries
 * the same `+ CategoryInfo` framing a parse error does, so a line that ran fine still gets the
 * flag. This one prints `scratch cleaned` and only trips on `git status` reporting a missing repo.
 */
const PARSE_ERROR_FALSE_POSITIVES = [
  "cd 'C:\\sbx\\sandrobench\\nikcli\\ts-async-race\\r1\\workspace'; git status --short 2>&1;",
]

describe("Shell.dialect over the recorded benchmark commands", () => {
  it("loads the whole fixture", () => {
    expect(commands.length).toBe(744)
  })

  it("routes every command PowerShell 5.1 refused to parse to bash", () => {
    const misrouted = commands
      .filter((entry) => entry.powershellParseError)
      .filter((entry) => !PARSE_ERROR_FALSE_POSITIVES.some((prefix) => entry.command.startsWith(prefix)))
      .filter((entry) => Shell.dialect(entry.command) !== "bash")
      .map((entry) => entry.command)
    expect(misrouted).toEqual([])
  })

  it("routes every cmdlet command that PowerShell accepted to PowerShell", () => {
    const misrouted = commands
      .filter((entry) => !entry.powershellParseError)
      .filter((entry) => CMDLET_AT_COMMAND_POSITION.test(entry.command))
      .filter((entry) => Shell.dialect(entry.command) !== "powershell")
      .map((entry) => entry.command)
    expect(misrouted).toEqual([])
  })

  it("keeps `$env:` on PowerShell", () => {
    const misrouted = commands
      .filter((entry) => /\$env:/i.test(entry.command))
      .filter((entry) => Shell.dialect(entry.command) !== "powershell")
      .map((entry) => entry.command)
    expect(misrouted).toEqual([])
  })

  it("moves strictly away from PowerShell: nothing 1.401.0 sent to bash comes back", () => {
    const towards = commands
      .filter((entry) => entry.routedToPowerShellIn1401 === false)
      .filter((entry) => Shell.dialect(entry.command) === "powershell")
      .map((entry) => entry.command)
    expect(towards).toEqual([])
  })

  it("shrinks the PowerShell share of the recorded commands", () => {
    const before = commands.filter((entry) => entry.routedToPowerShellIn1401 === true).length
    const after = commands.filter((entry) => Shell.dialect(entry.command) === "powershell").length
    expect(before).toBe(84)
    expect(after).toBeLessThan(before)
  })
})

describe("Shell.dialect", () => {
  it("sends bash loops, heredocs and conditionals to bash", () => {
    for (const command of [
      'ls -la tests/ && echo "---" && for f in tests/*; do echo "--- $f ---"; cat "$f"; done',
      "cat > /tmp/probe.mjs <<'EOF'\nconsole.log(1)\nEOF",
      'for d in "$TEMP" .; do if touch "$d/.wt" 2>/dev/null; then echo WRITABLE; fi; done',
      'cd "$(pwd)" && python -c "print(1)"',
      'cd fixtures && for f in *.txt; do xxd "$f" | head -8; done',
    ])
      expect(Shell.dialect(command)).toBe("bash")
  })

  it("sends cmdlets, `$env:` and PowerShell-only parameters to PowerShell", () => {
    for (const command of [
      "Remove-Item -Path 'src\\analytics.py' -Force; Get-ChildItem -Recurse src | Select-Object FullName",
      '$env:PYTHONPATH="."; python ./tests/test_public.py -v',
      "Get-ChildItem -Path $env:APPDATA\\ruff -ErrorAction SilentlyContinue | Select-Object FullName",
      '$d = Join-Path $env:TEMP "argvchk"; New-Item -ItemType Directory -Force -Path $d | Out-Null; $d',
      '1..5 | ForEach-Object { node --test tests/ *> $null; "run ${_}: exit=$LASTEXITCODE" }',
      '$d = $env:TEMP; New-Item -ItemType Directory -Force -Path "$d\\qcheck" | Out-Null',
    ])
      expect(Shell.dialect(command)).toBe("powershell")
  })

  it("keeps a PowerShell line on PowerShell when a POSIX alias sits next to a cmdlet", () => {
    expect(Shell.dialect("node --test tests/ 2>&1 | tail -8; Get-ChildItem -Recurse -File")).toBe("powershell")
    expect(Shell.dialect("ls; Get-ChildItem -Path . -Filter '*.toml' -Recurse")).toBe("powershell")
  })

  it("keeps the constructs PowerShell also spells on PowerShell", () => {
    // `$(…)` is PowerShell's subexpression, and a real user writes it inside strings all day.
    for (const command of [
      'Write-Output "count: $($items.Count)"',
      "$x = $(Get-Location).Path; Write-Output $x",
      // `@{…}` hashtable literals look like a `VAR=val` prefix to anything scanning for `=`
      "Get-ChildItem | Select-Object @{Name='n'; Expression={$_.Length}}",
      "Write-Output @{a=1; b=2}.a",
    ])
      expect(Shell.dialect(command)).toBe("powershell")
  })

  it("keeps the constructs PowerShell also spells on bash when nothing says PowerShell", () => {
    for (const command of [
      'cd "$(pwd)" && python -c "print(1)"',
      'PYTHONPATH="$PWD" python x.py',
      "echo `date`",
      // `awk` field assignment: `$1` is a field, not a variable name, so this is not PowerShell
      "ls -l | awk '{$1=\"\"; print}'",
    ])
      expect(Shell.dialect(command)).toBe("bash")
  })

  it("does not read prose in a quoted program as a cmdlet", () => {
    expect(Shell.dialect('python -c "\n# out-of-order pairs\nprint(1)\n"')).toBe("bash")
    expect(Shell.dialect('echo "the set-up and the follow-up"')).toBe("bash")
  })

  it("defaults to bash, the dialect the tool is documented in", () => {
    expect(Shell.dialect('python "$TEMP/verify_order.py"')).toBe("bash")
    expect(Shell.dialect("where.exe node; node --version")).toBe("bash")
    expect(Shell.dialect("")).toBe("bash")
  })

  it("ignores the platform, so the classification is testable anywhere", () => {
    expect(Shell.isPowerShell("Get-ChildItem")).toBe(process.platform === "win32")
    expect(Shell.dialect("Get-ChildItem")).toBe("powershell")
  })
})
