FROM oven/bun:1.4.2

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git openssh-server ripgrep && rm -rf /var/lib/apt/lists/*

# Copy root workspace files
COPY package.json bun.lock ./

# Copy patches required by bun install
COPY patches patches

# Copy only workspace manifests needed to resolve ragu dependencies
COPY packages/ragu/package.json packages/ragu/
COPY packages/script/package.json packages/script/
COPY packages/util/package.json packages/util/
COPY packages/sdk/js/package.json packages/sdk/js/
COPY packages/remote/package.json packages/remote/
COPY packages/plugin/package.json packages/plugin/
COPY packages/companion/package.json packages/companion/
COPY packages/discord/package.json packages/discord/
COPY packages/identity/package.json packages/identity/
COPY packages/auth/package.json packages/auth/
COPY packages/llm/package.json packages/llm/
COPY packages/http-recorder/package.json packages/http-recorder/
COPY packages/httpapi-codegen/package.json packages/httpapi-codegen/
COPY packages/simulation/package.json packages/simulation/
COPY packages/tui/package.json packages/tui/
COPY packages/tui-image/package.json packages/tui-image/
COPY packages/tui-math/package.json packages/tui-math/
COPY packages/terminal-control/package.json packages/terminal-control/
COPY packages/browser-control/package.json packages/browser-control/
COPY packages/computer-use/package.json packages/computer-use/
COPY github/package.json github/

# Stub webrenderer (native Rust build not required for the ragu binary)
RUN mkdir -p packages/webrenderer && \
    printf '{"name":"@opentui/webrenderer","version":"0.0.0","private":true}\n' > packages/webrenderer/package.json

# Install dependencies (resolves workspace:*)
RUN bun install

# Headless Chromium for @ragu/browser-control (the `browser` tool). Pinned
# to the exact playwright version browser-control depends on so the browser
# revision matches what gets bundled into the compiled ragu binary.
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN bunx --bun playwright@1.61.0 install --with-deps chromium

# Copy package sources required to build the ragu binary
COPY packages/ragu packages/ragu
COPY packages/script packages/script
COPY packages/util packages/util
COPY packages/sdk/js packages/sdk/js
COPY packages/remote packages/remote
COPY packages/plugin packages/plugin
COPY packages/companion packages/companion
COPY packages/identity packages/identity
COPY packages/auth packages/auth
COPY packages/llm packages/llm
COPY packages/http-recorder packages/http-recorder
COPY packages/httpapi-codegen packages/httpapi-codegen
COPY packages/simulation packages/simulation
COPY packages/tui packages/tui
COPY packages/tui-image packages/tui-image
COPY packages/tui-math packages/tui-math
COPY packages/terminal-control packages/terminal-control
COPY packages/browser-control packages/browser-control
COPY packages/computer-use packages/computer-use
COPY packages/native-control packages/native-control
COPY packages/native-ui-protocol packages/native-ui-protocol
COPY github github

# Build ragu binary for the current platform (linux-x64)
# RAGU_CHANNEL avoids git branch lookup in build script (no .git in Docker context)
ENV RAGU_CHANNEL=latest
ENV XDG_DATA_HOME=/data
ENV XDG_CACHE_HOME=/data/cache
ENV XDG_CONFIG_HOME=/data/config
ENV XDG_STATE_HOME=/data/state
# RAGU_VERSION must not be a literal here: pinned to 1.216.0 it kept stamping
# that version long after the repo moved on. `release: vX.Y.Z` rewrites every
# package.json before tagging, so packages/ragu/package.json is always the
# latest release — read it off the manifest already in this layer. Leaving the
# variable unset is not an option either: build.ts would then query npm for
# ragu-code@latest and stamp *patch + 1*, i.e. a version that does not exist yet.
RUN cd /app/packages/ragu && \
    RAGU_VERSION="$(bun -e 'console.log(require("./package.json").version)')" \
    bun run script/build.ts --single --skip-install && \
    set -- dist/*-linux-*/bin/ragu && cp "$1" /usr/local/bin/ragu && chmod +x /usr/local/bin/ragu

COPY packages/ragu/scripts/railway-entrypoint.sh /usr/local/bin/ragu-railway-entrypoint
RUN chmod +x /usr/local/bin/ragu-railway-entrypoint

ENV RAGU_SERVER_SSH_ENABLED=true
ENV RAGU_SERVER_SSH_PORT=2222
ENV RAGU_SERVER_SSH_HOST=0.0.0.0
# Configure one of these Railway variables to enable key-only SSH:
# RAGU_SSH_AUTHORIZED_KEYS="ssh-ed25519 AAAA..."
# RAGU_SSH_AUTHORIZED_KEYS_B64="<base64 authorized_keys>"

EXPOSE 4096 2222

ENTRYPOINT ["/usr/local/bin/ragu-railway-entrypoint"]

# Default to the mobile host without auto-pairing
CMD ["ragu", "mobile", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
