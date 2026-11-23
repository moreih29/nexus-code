#!/usr/bin/env bash
# nexus-code claude wrapper - injects hooks and session tracking inside the app PTY.

set -euo pipefail

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
    if head -n 5 "$cand" 2>/dev/null \
        | grep -qE 'nexus-code claude wrapper|cmux claude wrapper'; then
      continue
    fi
    printf '%s' "$cand"
    return 0
  done
  return 1
}

socket_exists() {
  [[ -S "$1" ]] && return 0
  [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]] && [[ -e "$1" ]]
}
IN_APP=0
if [[ "${NEXUS_IN_APP:-0}" == "1" && -n "${NEXUS_AGENT_SOCKET:-}" ]] && socket_exists "${NEXUS_AGENT_SOCKET}"; then
  IN_APP=1
fi

NESTED=0
if [[ "$IN_APP" == "1" && -n "${NEXUS_TAB_ID:-}" && "${NEXUS_CLAUDE_TAB_ID:-}" == "$NEXUS_TAB_ID" ]]; then
  NESTED=1
  IN_APP=0
fi

is_print() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --) return 1 ;;
      -p|--print) return 0 ;;
    esac
  done
  return 1
}

if [[ -n "${NEXUS_CLAUDE_PROGRAM:-}" ]]; then
  REAL_CLAUDE="$NEXUS_CLAUDE_PROGRAM"
  unset NEXUS_CLAUDE_PROGRAM
else
  REAL_CLAUDE="$(find_real_claude)" || { echo "claude not found in PATH" >&2; exit 127; }
fi

if [[ "$NESTED" == "1" && "${NEXUS_AGENT_PRINT_RUN:-}" == "1" && -n "${NEXUS_AGENT_BIN:-}" && -x "${NEXUS_AGENT_BIN}" ]] && is_print "$@"; then
  exec "$NEXUS_AGENT_BIN" print-run "$REAL_CLAUDE" "$@"
fi

if [[ "$IN_APP" == "0" ]]; then
  exec "$REAL_CLAUDE" "$@"
fi

if [[ -z "${NEXUS_AGENT_BIN:-}" ]]; then
  echo "nexus-code: NEXUS_AGENT_BIN is not set; hook injection skipped" >&2
  exec "$REAL_CLAUDE" "$@"
fi

SETTINGS_JSON="$(cat <<'SETTINGS_EOF'
{
  "preferredNotifChannel": "notifications_disabled",
  "hooks": {
    "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook session-start","timeout":10,"async":true},{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" cli agent-context --launch=\"${NEXUS_CHAT_INSTRUCTION_LAUNCH}\" --profile=\"${NEXUS_TERMINAL_PROFILE_ID}\" -","timeout":10}]}],
    "UserPromptSubmit": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook user-prompt-submit","timeout":10,"async":true},{"type":"command","command":"if [ -n \"${NEXUS_CHAT_INSTRUCTION_LAUNCH}\" ]; then \"${NEXUS_AGENT_BIN}\" cli agent-context --launch=\"${NEXUS_CHAT_INSTRUCTION_LAUNCH}\" -; fi","timeout":10}]}],
    "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook pre-tool-use","timeout":5,"async":true}]},{"matcher":"SendMessage","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook send-message","timeout":5}]}],
    "PostToolUse": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook post-tool-use","timeout":5,"async":true}]}],
    "PostToolUseFailure": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook post-tool-use-failure","timeout":5,"async":true}]}],
    "SubagentStart": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook subagent-start","timeout":5,"async":true}]}],
    "SubagentStop": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook subagent-stop","timeout":5,"async":true}]}],
    "Notification": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook notification","timeout":10,"async":true}]}],
    "Stop": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook stop","timeout":10,"async":true}]}],
    "StopFailure": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook stop-failure","timeout":10,"async":true}]}],
    "SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook session-end","timeout":5,"async":true}]}],
    "PermissionRequest": [{"matcher":"","hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" hook permission-request","timeout":3620}]}],
    "WorktreeCreate": [{"hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" cli worktree claude-create -","timeout":300}]}],
    "WorktreeRemove": [{"hooks":[{"type":"command","command":"\"${NEXUS_AGENT_BIN}\" cli worktree claude-remove -","timeout":300}]}]
  }
}
SETTINGS_EOF
)"

MODEL_PICKER="${NEXUS_CLAUDE_MODEL_PICKER:-}"
unset NEXUS_CLAUDE_MODEL_PICKER
if [[ -n "$MODEL_PICKER" ]]; then
  SETTINGS_JSON="${SETTINGS_JSON%\}}"',"modelPicker":'"${MODEL_PICKER}}"
fi

write_settings() {
  [[ -n "${HOME:-}" ]] || return 1
  local dir="${NEXUS_CODE_HOME:-$HOME/.nexus-code}" sum file tmp
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
  if [[ -z "$MODEL_PICKER" ]]; then
    echo "nexus-code: cannot write claude's hooks settings; hook injection skipped" >&2
    exec "$REAL_CLAUDE" "$@"
  fi
  SETTINGS_FILE="$SETTINGS_JSON"
fi

if [[ -n "${NEXUS_CAPTURE_SETTINGS_TO:-}" && "$SETTINGS_FILE" != "$SETTINGS_JSON" ]]; then
  cp "$SETTINGS_FILE" "$NEXUS_CAPTURE_SETTINGS_TO"
fi

NEXUS_CLAUDE_PRINT=0
if is_print "$@"; then
  NEXUS_CLAUDE_PRINT=1
fi
export NEXUS_CLAUDE_PRINT

export NEXUS_CLAUDE_TAB_ID="${NEXUS_TAB_ID:-}"
exec "$REAL_CLAUDE" --settings "$SETTINGS_FILE" "$@"
