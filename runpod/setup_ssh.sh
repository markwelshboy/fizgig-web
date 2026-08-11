#!/usr/bin/env bash

setup_fizgig_ssh() {
  local pub="${SSH_PUBLIC_KEY:-${PUBLIC_KEY:-}}"
  local authorized="/root/.ssh/authorized_keys"

  if [[ -n "$pub" ]]; then
    echo "[ssh] Installing SSH_PUBLIC_KEY/PUBLIC_KEY..."
    mkdir -p /root/.ssh
    printf '%s\n' "$pub" > "$authorized"
  elif [[ -s "$authorized" ]]; then
    echo "[ssh] Using existing Runpod authorized_keys."
  else
    echo "[ssh] No SSH_PUBLIC_KEY/PUBLIC_KEY or existing authorized_keys; skipping sshd."
    return 0
  fi

  if ! command -v sshd >/dev/null 2>&1; then
    echo "[ssh] openssh-server not installed; cannot start sshd." >&2
    return 1
  fi

  mkdir -p /run/sshd /var/run/sshd /root/.ssh
  chown root:root /root /root/.ssh "$authorized" 2>/dev/null || true
  chmod 0700 /root /root/.ssh
  chmod 0600 "$authorized"
  chmod 0755 /run/sshd /var/run/sshd

  cat > /etc/ssh/sshd_config.d/90-fizgig-web.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
EOF

  if [[ ! -f /etc/ssh/ssh_host_ed25519_key && ! -f /etc/ssh/ssh_host_rsa_key ]]; then
    echo "[ssh] Generating SSH host keys..."
    ssh-keygen -A
  fi

  /usr/sbin/sshd
  echo "[ssh] sshd started with key-only root login."
}

setup_fizgig_ssh
