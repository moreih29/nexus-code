# SSH fixture for Nexus remote-workspace integration tests.
#
# Contract (see tests/integration/ssh/_helpers/ssh-fixture.ts):
#   user      nexus-dev
#   password  nexus-dev
#   home      /home/nexus-dev
#   workspace /home/nexus-dev/workspace
#   sshd      listens on 22 inside the container
#
# Password authentication is enabled so the interactive auth path
# (SshAuthPromptHub) can be exercised end-to-end.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server \
      git \
      ca-certificates \
      zsh \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd --create-home --shell /bin/bash nexus-dev \
 && echo 'nexus-dev:nexus-dev' | chpasswd \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config \
 && ssh-keygen -A

# Seed a small directory tree so the remote directory picker has
# something to drill into during manual and integration testing.
RUN install -d -o nexus-dev -g nexus-dev \
      /home/nexus-dev/workspace \
      /home/nexus-dev/workspace/api \
      /home/nexus-dev/workspace/api/src \
      /home/nexus-dev/workspace/web \
      /home/nexus-dev/workspace/web/src \
      /home/nexus-dev/workspace/scripts \
      /home/nexus-dev/workspace/docs

EXPOSE 22

# -D: run in foreground, -e: log to stderr.
CMD ["/usr/sbin/sshd", "-D", "-e"]
