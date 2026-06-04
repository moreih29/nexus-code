# SSH test fixture — Linux remote workspace target.
#
# Intentionally omits node/bun/python so the Phase 0/1 hypothesis (Go agent
# runs with zero host runtime prerequisites) stays honest. Only git + ripgrep
# are pre-installed because they are real tool dependencies for Phase 4/6.
FROM ubuntu:22.04

# AUTH_MODE: "key" (default) | "password" | "both"
ARG AUTH_MODE=key
ARG SSH_PUBKEY
ARG USER_PASSWORD=nexus-dev

# Single apt layer — minimal surface.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server \
      git \
      ripgrep \
      ca-certificates \
      curl \
      less \
 && rm -rf /var/lib/apt/lists/*

# sshd runtime dir + generate host keys at build time.
RUN mkdir -p /var/run/sshd \
 && ssh-keygen -A

# Auth policy: switch by AUTH_MODE. password and challenge-response only enabled
# in "password" / "both" so BatchMode=yes from the client fails fast otherwise.
RUN set -eux; \
    case "$AUTH_MODE" in \
      key)      PW=no;  CR=no  ;; \
      password) PW=yes; CR=no  ;; \
      both)     PW=yes; CR=no  ;; \
      *)        echo "FATAL: AUTH_MODE must be key|password|both, got $AUTH_MODE" >&2; exit 1 ;; \
    esac; \
    sed -ri \
      -e "s/^#?PasswordAuthentication.*/PasswordAuthentication ${PW}/" \
      -e 's/^#?PermitRootLogin.*/PermitRootLogin no/' \
      -e "s/^#?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication ${CR}/" \
      -e 's/^#?UsePAM.*/UsePAM no/' \
      /etc/ssh/sshd_config

# Non-root developer account. Password set only when AUTH_MODE allows it.
RUN set -eux; \
    useradd -m -s /bin/bash nexus-dev; \
    mkdir -p /home/nexus-dev/.ssh /home/nexus-dev/workspace; \
    case "$AUTH_MODE" in \
      key|both) \
        if [ -z "$SSH_PUBKEY" ]; then echo "FATAL: SSH_PUBKEY required for AUTH_MODE=$AUTH_MODE" >&2; exit 1; fi; \
        echo "$SSH_PUBKEY" > /home/nexus-dev/.ssh/authorized_keys; \
        chmod 600 /home/nexus-dev/.ssh/authorized_keys ;; \
    esac; \
    case "$AUTH_MODE" in \
      password|both) \
        echo "nexus-dev:${USER_PASSWORD}" | chpasswd ;; \
    esac; \
    chmod 700 /home/nexus-dev/.ssh; \
    chown -R nexus-dev:nexus-dev /home/nexus-dev

# Claude Code — TUI 동작 E2E 재현용 (SSH 끊김 시 원격 TUI 생존 관찰 등).
# native 자체완결 바이너리(~/.local/share/claude)라 node/bun 을 PATH 에
# 노출하지 않으므로 위의 "zero host runtime" 전제는 그대로 유지된다.
# 로그인 토큰은 이미지에 굽지 않는다 — compose 의 claude-config 볼륨
# (~/.claude) 에 1회 로그인으로 저장되어 컨테이너 재생성에도 유지된다.
RUN su - nexus-dev -c 'curl -fsSL https://claude.ai/install.sh | bash' \
 && ln -s /home/nexus-dev/.local/bin/claude /usr/local/bin/claude
# /usr/local/bin 심볼릭 링크: 설치 경로(~/.local/bin)는 ~/.profile 로만 PATH 에
# 잡혀 login shell 에서만 보인다. 앱 PTY 는 --rcfile 셔임의 non-login bash 라
# ~/.profile 을 읽지 않으므로, 셸 종류와 무관하게 항상 잡히는 시스템 경로에 건다.

EXPOSE 22

# -D: foreground (so it is PID 1), -e: log to stderr (visible via `docker logs`).
CMD ["/usr/sbin/sshd", "-D", "-e"]
