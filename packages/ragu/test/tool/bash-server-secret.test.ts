import { describe, expect, it } from "bun:test"
import path from "path"

const PASSWORD = "server-password-that-must-not-leak"
const USERNAME = "server-username-that-must-not-leak"
const OLD_PASSWORD = "old-name-password-that-must-not-leak"

type Report = {
  flag: { username?: string; password?: string }
  worker: Record<string, string>
  children: Record<string, string>
  explicitEnv: string
}

async function runChild(env: Record<string, string>): Promise<Report> {
  const proc = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixtures/server-secret-child.ts")], {
    cwd: path.join(import.meta.dir, "../.."),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const start = out.lastIndexOf("REPORT:")
  if (start < 0) throw new Error(`the child printed no report\n${out}\n${err}`)
  return JSON.parse(out.slice(start + "REPORT:".length))
}

describe("the server's credentials stay out of what its agents run", () => {
  it("a bash-tool child, and every other way of starting one, does not see them", async () => {
    const report = await runChild({
      RAGU_SERVER_PASSWORD: PASSWORD,
      RAGU_SERVER_USERNAME: USERNAME,
      NIKCLI_SERVER_PASSWORD: PASSWORD,
      NIKCLI_SERVER_USERNAME: USERNAME,
    })

    // The server still has them, or this would just be a server with no password.
    expect(report.flag).toEqual({ username: USERNAME, password: PASSWORD })

    for (const [name, seen] of Object.entries(report.children)) {
      expect(seen.length, `${name} printed nothing`).toBeGreaterThan(0)
      expect(seen.includes(PASSWORD), `${name} saw the password`).toBe(false)
      expect(seen.includes(USERNAME), `${name} saw the username`).toBe(false)
    }
    expect(report.explicitEnv).toContain(`"ASKED_FOR":"yes"`)
  }, 120_000)

  it("a password set only under the old name is still read, and still leaves the environment", async () => {
    const report = await runChild({ NIKCLI_SERVER_PASSWORD: OLD_PASSWORD })
    expect(report.flag.password).toBe(OLD_PASSWORD)
    for (const [name, seen] of Object.entries(report.children)) {
      expect(seen.includes(OLD_PASSWORD), `${name} saw the password`).toBe(false)
    }
  }, 120_000)

  it("the TUI's worker still gets them, or a server it listens with would have no password", async () => {
    const report = await runChild({ RAGU_SERVER_PASSWORD: PASSWORD, RAGU_SERVER_USERNAME: USERNAME })
    expect(report.worker.RAGU_SERVER_PASSWORD).toBe(PASSWORD)
    expect(report.worker.RAGU_SERVER_USERNAME).toBe(USERNAME)
  }, 120_000)
})
