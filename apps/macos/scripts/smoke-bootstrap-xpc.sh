#!/bin/sh
set -eu

app_path=${1:?usage: smoke-bootstrap-xpc.sh '/path/to/Round Table.app'}
smoke_mode=${2:-live}
case "$smoke_mode" in
  live) expected=live ;;
  security) expected=security ;;
  workspace) expected=workspace ;;
  orchestration) expected=orchestration ;;
  *) exit 2 ;;
esac
executable_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")
executable="$app_path/Contents/MacOS/$executable_name"
xpc_executable="$app_path/Contents/XPCServices/RoundTableHostRuntimeBootstrap.xpc/Contents/MacOS/RoundTableHostRuntimeBootstrap"
test -x "$executable"
test -x "$xpc_executable"
if pgrep -f "$xpc_executable" >/dev/null 2>&1; then
  exit 1
fi

result_dir=$(mktemp -d "${TMPDIR:-/tmp}/roundtable-xpc-smoke.XXXXXX")
result_path="$result_dir/result"
cleanup() {
  if [ -n "${app_pid:-}" ]; then kill "$app_pid" 2>/dev/null || true; fi
  rm -rf "$result_dir"
}
trap cleanup EXIT HUP INT TERM

ROUNDTABLE_BOOTSTRAP_XPC_SMOKE="$smoke_mode" "$executable" >"$result_path" &
app_pid=$!
remaining=100
while kill -0 "$app_pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
  sleep 0.1
  remaining=$((remaining - 1))
done
if kill -0 "$app_pid" 2>/dev/null; then
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  app_pid=
  exit 1
fi
wait "$app_pid"
app_pid=
test "$(cat "$result_path")" = "$expected"

remaining=50
while pgrep -f "$xpc_executable" >/dev/null 2>&1 && [ "$remaining" -gt 0 ]; do
  sleep 0.1
  remaining=$((remaining - 1))
done
if pgrep -f "$xpc_executable" >/dev/null 2>&1; then
  exit 1
fi
