#!/bin/bash
# ragu-slack-tunnel.sh
# Script to manage tunnel for ragu slack integration
# Supports both cloudflared (default) and ngrok

# Use ngrok if USE_NGROK is set, otherwise default to cloudflared
USE_NGROK=${USE_NGROK:-0}
PORT=${PORT:-4096} # Default Ragu port

if [ "$USE_NGROK" = "1" ]; then
    echo "Starting ngrok tunnel for ragu server..."
    
    # Kill existing ngrok
    killall ngrok 2>/dev/null || true
    sleep 1

    # Start ngrok in background
    ngrok http $PORT --log=stdout > ngrok.log &
    
    # Wait for tunnel to establish
    sleep 3
    
    # Extract URL from API
    TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*ngrok.io' | head -1)
    
    if [ -z "$TUNNEL_URL" ]; then
        # Try finding ngrok-free.app domain as well
        TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*ngrok-free.app' | head -1)
    fi
    
    if [ -z "$TUNNEL_URL" ]; then
        echo "Error: Could not extract ngrok URL. Please check ngrok installation and logs."
        cat ngrok.log | tail -10
        exit 1
    fi
else
    # Default to cloudflared
    echo "Starting cloudflared tunnel for ragu server..."
    
    # Kill any existing cloudflared tunnel
    killall cloudflared 2>/dev/null || true
    sleep 1

    # Start tunnel and capture output (redirecting correctly)
    cloudflared tunnel --url http://localhost:$PORT > tunnel.log 2>&1 &
    
    # Wait for tunnel to establish
    sleep 5
    
    # Extract tunnel URL
    TUNNEL_URL=$(cat tunnel.log | grep -o 'https://[^[:space:]]*trycloudflare.com' | head -1)
    
    if [ -z "$TUNNEL_URL" ]; then
        echo "Error: Could not extract cloudflared URL. Please check logs."
        cat tunnel.log | tail -10
        exit 1
    fi
fi

echo ""
echo "✅ Tunnel created: $TUNNEL_URL"
echo ""

# Update RAGU_URL in Cloudflare Workers
echo "Updating RAGU_URL secret..."
 
echo "$TUNNEL_URL" | bunx wrangler secret put RAGU_URL --name ragu-slack || true

echo ""
echo "✅ RAGU_URL updated!"
echo ""
echo "To use ragu via Slack:"
echo "1. Keep this terminal running"
echo "2. Mention @ragu in Slack to start a conversation"
echo ""
echo "⚠️ NOTE: This URL will change if you restart this script"
echo "   For a permanent solution, consider:"
echo "   - Deploy ragu server on a VPS with static IP"
echo "   - Set up a named tunnel with Cloudflare Zero Trust or ngrok custom domain"

# Wait for background process to keep script alive
wait
