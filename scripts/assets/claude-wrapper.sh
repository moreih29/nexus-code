#!/usr/bin/env bash
# nexus-code claude wrapper - injects hooks and session tracking inside the app PTY.
#
# 앱 내부 PTY에서 실행될 때만 --settings(hooks JSON) + --session-id 를 주입한다.
# 앱 외부에서는 실제 claude 바이너리로 그대로 passthrough한다.

set -euo pipefail

# 1) 실제 claude 바이너리 탐색.
#   - 자신이 위치한 디렉터리는 건너뜀 (자기 자신 재호출 방지).
#   - 다른 인앱 wrapper(우리/cmux 등)도 magic 헤더 코멘트로 식별해 skip한다.
#     이 검사가 없으면 cmux 와 우리 wrapper 가 함께 PATH 에 있을 때 서로를
#     "진짜 claude" 로 오인해 무한 exec 루프에 빠진다.
find_real_claude() {
  local self_dir
  self_dir="$(cd "$(dirname "$0")" && pwd)"
  local IFS=:
  for d in $PATH; do
    [[ "$d" == "$self_dir" ]] && continue
    local cand="$d/claude"
    [[ -x "$cand" ]] || continue
    # 첫 5 줄 안에 알려진 wrapper 헤더 문자열이 있으면 이 후보는 wrapper 다.
    # 진짜 claude 바이너리는 binary 라 grep 매칭이 발생하지 않는다.
    if head -n 5 "$cand" 2>/dev/null \
        | grep -qE 'nexus-code claude wrapper|cmux claude wrapper'; then
      continue
    fi
    printf '%s' "$cand"
    return 0
  done
  return 1
}

# 2) 인앱 여부 감지: NEXUS_IN_APP=1 이고 NEXUS_AGENT_SOCKET 소켓이 존재할 때만 주입 모드.
IN_APP=0
if [[ "${NEXUS_IN_APP:-0}" == "1" && -n "${NEXUS_AGENT_SOCKET:-}" && -S "${NEXUS_AGENT_SOCKET}" ]]; then
  IN_APP=1
fi

REAL_CLAUDE="$(find_real_claude)" || { echo "claude not found in PATH" >&2; exit 127; }

# 3) 앱 외부: 변경 없이 passthrough.
if [[ "$IN_APP" == "0" ]]; then
  exec "$REAL_CLAUDE" "$@"
fi

# 4) hook 바이너리 경로 결정 — NEXUS_AGENT_BIN(main이 주입) 또는 래퍼 인접 경로 탐색.
HOOK_BIN="${NEXUS_AGENT_BIN:-}"
if [[ -z "$HOOK_BIN" || ! -x "$HOOK_BIN" ]]; then
  # 래퍼 위치 기준으로 상위 디렉터리의 agent-* 실행 파일 탐색
  for cand in "$(dirname "$0")/../agent-"*; do
    [[ -x "$cand" ]] && HOOK_BIN="$cand" && break
  done
fi
if [[ -z "$HOOK_BIN" ]]; then
  # hook 바이너리 없음 — claude 기능 저하 없이 passthrough.
  exec "$REAL_CLAUDE" "$@"
fi

# 5) 임시 settings JSON 파일 생성. hook 명령 경로는 큰따옴표로 감싸 공백 대응.
SETTINGS_FILE="$(mktemp -t nexus-claude-settings.XXXXXX.json)"
trap 'rm -f "$SETTINGS_FILE"' EXIT

# HOOK_BIN의 backslash와 큰따옴표를 JSON-escape한 뒤 따옴표로 감싼다.
ESCAPED_HOOK_BIN=$(printf '%s' "$HOOK_BIN" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
HOOK_CMD_PREFIX="\\\"$ESCAPED_HOOK_BIN\\\" hook"

cat > "$SETTINGS_FILE" <<EOF
{
  "preferredNotifChannel": "notifications_disabled",
  "hooks": {
    "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX session-start","timeout":10}]}],
    "UserPromptSubmit": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX user-prompt-submit","timeout":10}]}],
    "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX pre-tool-use","timeout":5,"async":true}]}],
    "Notification": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX notification","timeout":10}]}],
    "Stop": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX stop","timeout":10}]}],
    "SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX session-end","timeout":5}]}],
    "PermissionRequest": [{"matcher":"","hooks":[{"type":"command","command":"$HOOK_CMD_PREFIX permission-request","timeout":120}]}]
  }
}
EOF

# 6) (테스트 전용) NEXUS_CAPTURE_SETTINGS_TO가 지정된 경우 settings 파일을 해당 경로로 복사.
if [[ -n "${NEXUS_CAPTURE_SETTINGS_TO:-}" ]]; then
  cp "$SETTINGS_FILE" "$NEXUS_CAPTURE_SETTINGS_TO"
fi

# 7) 새 세션 UUID 생성 후 실제 claude 실행.
SESSION_ID="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "")"
if [[ -n "$SESSION_ID" ]]; then
  exec "$REAL_CLAUDE" --session-id "$SESSION_ID" --settings "$SETTINGS_FILE" "$@"
else
  exec "$REAL_CLAUDE" --settings "$SETTINGS_FILE" "$@"
fi
