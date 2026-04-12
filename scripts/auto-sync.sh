#!/bin/bash
# UnityChat Auto-Sync (event-driven, zero polling)
#
# SSH + inotifywait on VPS watches git ref changes.
# When VPS commits+pushes, this script instantly pulls locally.
#
# Usage: bash scripts/auto-sync.sh
# Background: bash scripts/auto-sync.sh &

REPO="D:/_BACKUP_2.0/Code Projects/UnityChat"
VPS="root@178.104.160.182"
WATCH="/root/UnityChat/.git/refs/heads/"

cd "$REPO" || exit 1

echo "[auto-sync] Event-driven sync started (inotifywait on VPS)"
echo "[auto-sync] Press Ctrl+C to stop"

while true; do
    echo "[$(date +%H:%M:%S)] Waiting for VPS push..."

    # Block until the git ref file changes on VPS
    ssh -o ConnectTimeout=10 \
        -o ServerAliveInterval=30 \
        -o ServerAliveCountMax=3 \
        "$VPS" "inotifywait -qq -e moved_to $WATCH 2>/dev/null"

    EXIT=$?
    if [ $EXIT -ne 0 ]; then
        echo "[$(date +%H:%M:%S)] SSH disconnected (exit $EXIT), reconnecting..."
        sleep 3
        continue
    fi

    # Small delay for push to complete after commit
    sleep 2

    # Pull
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    git pull origin "$BRANCH" --ff-only --quiet 2>/dev/null
    if [ $? -eq 0 ]; then
        MSG=$(git log --oneline -1)
        echo "[$(date +%H:%M:%S)] Synced: $MSG"
    else
        echo "[$(date +%H:%M:%S)] Pull failed"
    fi
done
