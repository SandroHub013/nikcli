#!/usr/bin/env bun
import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const sidecarConfig = getCurrentSidecar()

const runID = Bun.env.GITHUB_RUN_ID

// CI path: download the already-built CLI artifact from the current GitHub Actions run.
if (runID) {
  const dir = "src-tauri/target/ragu-binaries"
  await $`mkdir -p ${dir}`
  await $`gh run download ${runID} -n ragu-cli`.cwd(dir)
  await copyBinaryToSidecarFolder(windowsify(`${dir}/${sidecarConfig.ocBinary}/bin/ragu`))
  process.exit(0)
}

// Local path: build the CLI from source and copy it into the Tauri sidecars directory.
const binaryPath = windowsify(`../ragu/dist/${sidecarConfig.ocBinary}/bin/ragu`)
await $`cd ../ragu && bun run build --single`
await copyBinaryToSidecarFolder(binaryPath)
