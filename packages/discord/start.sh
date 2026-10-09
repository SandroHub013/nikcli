#!/bin/bash
# Start the Ragu Discord bot (Gateway websocket — no inbound tunnel).
exec bun run src/index.ts
