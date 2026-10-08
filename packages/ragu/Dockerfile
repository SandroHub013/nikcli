FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add libgcc libstdc++ ripgrep tini

# Create a non-root user to run ragu. Numeric UID/GID keeps the image
# portable across base-image bumps. ragu writes its data under $HOME
# (XDG_DATA_HOME, XDG_CACHE_HOME, XDG_CONFIG_HOME), so we pre-create the
# layout and chown it before the USER switch.
RUN addgroup -g 1000 ragu && adduser -D -u 1000 -G ragu -h /home/ragu ragu \
    && mkdir -p /home/ragu/.local/share /home/ragu/.local/state \
                 /home/ragu/.cache /home/ragu/.config \
    && chown -R ragu:ragu /home/ragu
ENV HOME=/home/ragu

# Bun 1.4 ships a single x64 linux target — there is no separate baseline
# artifact any more, so the path is `linux-x64-musl`, not
# `linux-x64-baseline-musl` like the pre-1.4 builds used to emit.
FROM base AS build-amd64
COPY dist/ragu-code-linux-x64-musl/bin/ragu /usr/local/bin/ragu

FROM base AS build-arm64
COPY dist/ragu-code-linux-arm64-musl/bin/ragu /usr/local/bin/ragu

ARG TARGETARCH
FROM build-${TARGETARCH}

# Drop privileges: ragu runs as UID 1000, never as root. tini forwards
# SIGTERM/SIGINT to the entrypoint so the container stops cleanly.
USER ragu
RUN ragu --version
ENTRYPOINT ["/sbin/tini", "--", "ragu"]
