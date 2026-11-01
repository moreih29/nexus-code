#!/usr/bin/env bash
# nexus-code claude wrapper - injects hooks and session tracking inside the app PTY.
#
# 앱 내부 PTY에서 실행될 때만 --settings(hooks JSON)를 주입한다.
# 앱 외부에서는 실제 claude 바이너리로 그대로 passthrough한다.

set -euo pipefail

# 1) 실제 claude 바이너리 탐색.
#   - 자신이 위치한 디렉터리는 건너뜀 (자기 자신 재호출 방지).
#   - 다른 인앱 wrapper(우리/cmux 등)도 magic 헤더 코멘트로 식별해 skip한다.
#     이 검사가 없으면 cmux 와 우리 wrapper 가 함께 PATH 에 있을 때 서로를
#     "진짜 claude" 로 오인해 무한 exec 루프에 빠진다.
find_real_claude() {
  local self_dir
  if [[ -n "${NEXUS_WRAPPER_SELF_DIR:-}" ]]; then
    self_dir="$NEXUS_WRAPPER_SELF_DIR"
  else
    self_dir="$(cd "$(dirname "$0")" && pwd)"
  fi
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
#    Git Bash on Windows sees the agent's AF_UNIX socket as a plain file.
socket_exists() {
  [[ -S "$1" ]] && return 0
  [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]] && [[ -e "$1" ]]
}
IN_APP=0
if [[ "${NEXUS_IN_APP:-0}" == "1" && -n "${NEXUS_AGENT_SOCKET:-}" ]] && socket_exists "${NEXUS_AGENT_SOCKET}"; then
  IN_APP=1
fi

REAL_CLAUDE="$(find_real_claude)" || { echo "claude not found in PATH" >&2; exit 127; }

# 3) 앱 외부: 변경 없이 passthrough.
if [[ "$IN_APP" == "0" ]]; then
  exec "$REAL_CLAUDE" "$@"
fi

# 4) NEXUS_AGENT_BIN 의무 확인.
#    미설정 시: stderr 경고 + settings 주입 없이 진짜 claude passthrough (hook 비활성화 fallback).
if [[ -z "${NEXUS_AGENT_BIN:-}" ]]; then
  echo "nexus-code: NEXUS_AGENT_BIN is not set; hook injection skipped" >&2
  exec "$REAL_CLAUDE" "$@"
fi

# 5) The hooks settings JSON.
#    command 필드에 리터럴 ${NEXUS_AGENT_BIN}을 기록한다 — exec 시점(claude hook 실행)에 셸이 확장한다.
#    wrapper 실행 시점에 경로를 확장하지 않으므로 JSON-escape 처리가 불필요하다.
SETTINGS_JSON="$(cat <<'SETTINGS_EOF'
{
  "preferredNotifChannel": "notifications_disabled",
  "hooks": {
    "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook session-start","timeout":10,"async":true},{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" cli agent-context","timeout":10}]}],
    "UserPromptSubmit": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook user-prompt-submit","timeout":10,"async":true}]}],
    "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook pre-tool-use","timeout":5,"async":true}]}],
    "PostToolUse": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook post-tool-use","timeout":5,"async":true}]}],
    "PostToolUseFailure": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook post-tool-use-failure","timeout":5,"async":true}]}],
    "SubagentStop": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook subagent-stop","timeout":5,"async":true}]}],
    "Notification": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook notification","timeout":10,"async":true}]}],
    "Stop": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook stop","timeout":10,"async":true}]}],
    "SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook session-end","timeout":5,"async":true}]}],
    "PermissionRequest": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook permission-request","timeout":120}]}],
    "WorktreeCreate": [{"hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" cli worktree claude-create -","timeout":300}]}],
    "WorktreeRemove": [{"hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" cli worktree claude-remove -","timeout":300}]}]
  }
}
SETTINGS_EOF
)"

# 6) The settings file claude reads. exec leaves nothing behind to delete a
#    file per launch, so every launch shares one, named after its content: a
#    launch of another version of this wrapper gets its own. A launch writes
#    it only when it is missing or differs, through a rename, so a concurrent
#    launch reads either no file or the whole one; one that loses the rename
#    to another still finds the file it needs.
write_settings() {
  [[ -n "${HOME:-}" ]] || return 1
  local dir="$HOME/.nexus-code" sum file tmp
  mkdir -p "$dir" 2>/dev/null || return 1
  sum="$(printf '%s' "$SETTINGS_JSON" | cksum | cut -d ' ' -f 1)" || return 1
  file="$dir/claude-settings-$sum.json"
  if [[ "$(cat "$file" 2>/dev/null)" != "$SETTINGS_JSON" ]]; then
    tmp="$(mktemp "$dir/claude-settings.XXXXXX")" || return 1
    printf '%s\n' "$SETTINGS_JSON" > "$tmp" && mv -f "$tmp" "$file" 2>/dev/null
    rm -f "$tmp"
    [[ "$(cat "$file" 2>/dev/null)" == "$SETTINGS_JSON" ]] || return 1
  fi
  printf '%s' "$file"
}
if ! SETTINGS_FILE="$(write_settings)"; then
  echo "nexus-code: cannot write claude's hooks settings; hook injection skipped" >&2
  exec "$REAL_CLAUDE" "$@"
fi

# 7) (테스트 전용) NEXUS_CAPTURE_SETTINGS_TO가 지정된 경우 settings 파일을 해당 경로로 복사.
if [[ -n "${NEXUS_CAPTURE_SETTINGS_TO:-}" ]]; then
  cp "$SETTINGS_FILE" "$NEXUS_CAPTURE_SETTINGS_TO"
fi

# 8) Runs claude with the hooks. No --session-id: claude refuses one with
#    --continue or --resume, and nothing reads it.
exec "$REAL_CLAUDE" --settings "$SETTINGS_FILE" "$@"
