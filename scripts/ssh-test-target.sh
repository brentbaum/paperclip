#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${CONTAINER_NAME:-paperclip-ssh-test-target}"
IMAGE_NAME="${IMAGE_NAME:-paperclip/ssh-test-target:local}"
SSH_PORT="${SSH_PORT:-2222}"
SSH_USER="${SSH_USER:-brewuser}"
WORKER_JS_PATH="${WORKER_JS_PATH:-$ROOT_DIR/packages/remote-worker/dist/worker.js}"
TEST_KEY_DIR="${TEST_KEY_DIR:-/tmp/paperclip-ssh-test-target}"
TEST_KEY_PATH="${TEST_KEY_PATH:-$TEST_KEY_DIR/id_ed25519}"
PUBKEY_PATH="${PUBKEY_PATH:-$TEST_KEY_PATH.pub}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|status|ssh>

Environment overrides:
  CONTAINER_NAME   (default: $CONTAINER_NAME)
  IMAGE_NAME       (default: $IMAGE_NAME)
  SSH_PORT         (default: $SSH_PORT)
  SSH_USER         (default: $SSH_USER)
  TEST_KEY_DIR     (default: $TEST_KEY_DIR)
  TEST_KEY_PATH    (default: $TEST_KEY_PATH)
  PUBKEY_PATH      (default: $PUBKEY_PATH)
  WORKER_JS_PATH   (default: $WORKER_JS_PATH)
EOF
}

ensure_worker() {
  if [[ -f "$WORKER_JS_PATH" ]]; then
    return
  fi
  echo "[ssh-test-target] building remote worker"
  (cd "$ROOT_DIR" && pnpm --filter @paperclipai/remote-worker build)
}

ensure_test_key() {
  mkdir -p "$TEST_KEY_DIR"
  chmod 700 "$TEST_KEY_DIR"
  if [[ -f "$TEST_KEY_PATH" && -f "$PUBKEY_PATH" ]]; then
    return
  fi
  echo "[ssh-test-target] generating test keypair at $TEST_KEY_PATH"
  ssh-keygen -q -t ed25519 -N "" -f "$TEST_KEY_PATH"
}

start() {
  ensure_test_key
  ensure_worker

  echo "[ssh-test-target] building image $IMAGE_NAME"
  (cd "$ROOT_DIR" && docker build -t "$IMAGE_NAME" -f docker/ssh-test-target/Dockerfile .)

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  echo "[ssh-test-target] starting container $CONTAINER_NAME on localhost:$SSH_PORT"
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "$SSH_PORT:22" \
    -v "$PUBKEY_PATH:/tmp/authorized_key:ro" \
    -v "$WORKER_JS_PATH:/tmp/worker.js:ro" \
    "$IMAGE_NAME" >/dev/null

  echo "[ssh-test-target] ready"
  echo "  ssh -i $TEST_KEY_PATH -p $SSH_PORT $SSH_USER@127.0.0.1 'echo ok'"
}

stop() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  echo "[ssh-test-target] stopped $CONTAINER_NAME"
}

status() {
  docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
}

ssh_cmd() {
  exec ssh -i "$TEST_KEY_PATH" -p "$SSH_PORT" "$SSH_USER@127.0.0.1"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    start) start ;;
    stop) stop ;;
    status) status ;;
    ssh) ssh_cmd ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
