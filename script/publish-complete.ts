#!/usr/bin/env bun

import { Script } from "@ragu/script"
import { $ } from "bun"

if (!Script.preview) {
  await $`gh release edit v${Script.version} --draft=false`
}

await $`bun install`

// Download all platform archives needed for registries (homebrew, etc.)
// These must match the naming convention used by release-github.ts
await $`mkdir -p dist`
await $`gh release download v${Script.version} --pattern "ragu-code-linux-*64*.tar.gz" --pattern "ragu-code-darwin-*64*.zip" -D dist`

await import(`../packages/ragu/script/publish-registries.ts`)
