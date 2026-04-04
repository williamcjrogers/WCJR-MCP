#!/bin/bash
# Kill all openclaw/node processes and restart gateway with no auth
for pid in $(ls /proc/*/cmdline 2>/dev/null | grep -oP '\d+'); do
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
  if echo "$cmd" | grep -qi "openclaw.*gateway"; then
    kill $pid 2>/dev/null
    echo "Killed gateway PID $pid"
  fi
done

sleep 2

# Start fresh gateway
nohup openclaw gateway --port 18789 > /tmp/gateway.log 2>&1 &
echo "New gateway PID=$!"
sleep 3
tail -5 /tmp/gateway.log
echo "DONE"
