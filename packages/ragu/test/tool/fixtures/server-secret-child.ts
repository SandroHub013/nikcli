/**
 * Run as its own process by bash-server-secret.test.ts, with the server's credentials in its environment the way
 * ADE's `ragu serve` gets them. They have to be set before anything reads the flags, which a test in a running
 * `bun test` process cannot arrange. Prints what this process kept, and what each way of starting a child handed on.
 */
import "@/util/legacy-env-run"
import { Flag } from "@ragu/util/flag"
import { createWorkerEnv } from "@/cli/handlers/default"
import { BashTool } from "@/tool/bash"
import { Instance } from "@/project/instance"
import childProcess from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { makeToolContext, withProjectDirectory } from "../../helpers/tool-context"

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-server-secret-"))
await fs.mkdir(path.join(dir, ".git"), { recursive: true })
const printer = path.join(dir, "print-env.js")
await fs.writeFile(printer, "console.log(JSON.stringify(process.env))\n")

const asArray = [process.execPath, printer]
const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

const def = await withProjectDirectory(dir, () => BashTool.init())
const bash = await withProjectDirectory(dir, () =>
  def.executeAsync({ command: `bun print-env.js`, description: "print env" }, makeToolContext().ctx),
)

const report = {
  flag: { username: Flag.RAGU_SERVER_USERNAME, password: Flag.RAGU_SERVER_PASSWORD },
  worker: createWorkerEnv(),
  children: {
    processEnv: JSON.stringify(process.env),
    bashTool: bash.output,
    bunSpawn: await text(Bun.spawn(asArray, { stdout: "pipe" }).stdout),
    bunSpawnOptionsOnly: await text(Bun.spawn({ cmd: asArray, stdout: "pipe" }).stdout),
    bunSpawnSync: Bun.spawnSync(asArray, { stdout: "pipe" }).stdout.toString(),
    bunShell: await Bun.$`${process.execPath} ${printer}`.text(),
    childProcess: childProcess.spawnSync(process.execPath, [printer], { encoding: "utf8" }).stdout,
  },
  // A caller's own env still wins: the fix must not touch what a spawn asks for by itself.
  explicitEnv: await text(Bun.spawn(asArray, { stdout: "pipe", env: { ...process.env, ASKED_FOR: "yes" } }).stdout),
}

await Instance.disposeAll().catch(() => undefined)
await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
process.stdout.write(`REPORT:${JSON.stringify(report)}`)
process.exit(0)
