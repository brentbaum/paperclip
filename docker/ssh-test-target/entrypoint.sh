#!/usr/bin/env bash
set -euo pipefail

AUTHORIZED_KEY_PATH="${AUTHORIZED_KEY_PATH:-/tmp/authorized_key}"
WORKER_SOURCE_PATH="${WORKER_SOURCE_PATH:-/tmp/worker.js}"
WORKER_DEST_PATH="/home/brewuser/paperclip-remote-worker/dist/worker.js"

# OpenSSH rejects locked accounts before checking keys, so unlock explicitly.
usermod -U brewuser >/dev/null 2>&1 || true
passwd -d brewuser >/dev/null 2>&1 || true

if [[ -f "$AUTHORIZED_KEY_PATH" ]]; then
  cp "$AUTHORIZED_KEY_PATH" /home/brewuser/.ssh/authorized_keys
  chown brewuser:brewuser /home/brewuser/.ssh/authorized_keys
  chmod 600 /home/brewuser/.ssh/authorized_keys
fi

if [[ -f "$WORKER_SOURCE_PATH" ]]; then
  cp "$WORKER_SOURCE_PATH" "$WORKER_DEST_PATH"
  chown brewuser:brewuser "$WORKER_DEST_PATH"
  chmod 755 "$WORKER_DEST_PATH"
fi

ssh-keygen -A

cat > /etc/ssh/sshd_config <<'EOF'
Port 22
Protocol 2
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
AllowUsers brewuser
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

exec /usr/sbin/sshd -D -e
