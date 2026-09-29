// A stand-in for a browser: a process that stays until it is killed, with a `--user-data-dir` in its command line.
// With `--launcher` it is what Edge's `msedge.exe` is: it starts the real one (detached, alone in the world) and exits at once.
if (process.argv.includes("--launcher")) {
  Bun.spawn([process.execPath, process.argv[1], ...process.argv.slice(2).filter((a) => a !== "--launcher")], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  }).unref()
  process.exit(0)
}
setInterval(() => {}, 1000)
