#!/usr/bin/env bash
# hivedesk launcher for Linux. It checks for Node.js 20 or newer, then runs
# the latest hivedesk with npx. It installs nothing else by itself.
# Source: https://github.com/kwy404/hivedesk (MIT)

NODE_URL="https://nodejs.org/en/download"

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then gio open "$1" >/dev/null 2>&1 &
  fi
}

need_node() {
  echo
  echo "hivedesk needs Node.js 20 or newer: it runs the crew and the local server."
  echo "$1"
  echo "Opening the official download page: $NODE_URL"
  echo "Install Node.js (the LTS version is fine), then run this launcher again."
  open_url "$NODE_URL"
  echo
  read -r -p "Press Enter to close." _
  exit 1
}

if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  need_node "Node.js was not found on this computer."
fi

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$major" ] || [ "$major" -lt 20 ]; then
  need_node "This computer has Node.js $(node -v 2>/dev/null), which is too old."
fi

echo "Node.js $(node -v) found. Starting hivedesk..."
npx --yes hivedesk@latest "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "hivedesk stopped with code $status. Run 'npx hivedesk --doctor' to check your setup."
  read -r -p "Press Enter to close." _
fi
exit $status
