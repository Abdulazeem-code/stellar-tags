#!/usr/bin/env bash
#
# Deploys the payment_router Soroban contract to the local standalone
# Stellar network started by docker-compose.test.yml.
#
# Prerequisites:
#   - Docker running with the standalone network up:
#       docker compose -f docker-compose.test.yml up -d stellar-standalone
#   - The `soroban` CLI installed (https://soroban.stellar.org/docs/reference/cli)
#   - Rust toolchain with the `wasm32-unknown-unknown` target:
#       rustup target add wasm32-unknown-unknown
#
# Outputs the deployed contract ID to stdout and writes it to
# tests/integration/.contract-id so the integration test can read it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTRACT_DIR="${ROOT_DIR}/payment_router"

# Standalone network RPC endpoint exposed by the quickstart container.
RPC_URL="${RPC_URL:-http://localhost:8000/rpc}"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"

# Well-known funded account on the standalone network (root account).
# The quickstart image funds this account with a large XLM balance.
FUNDED_SECRET="${FUNDED_SECRET:-SBFGFF27Y64ZUGFAIG5AMJGQODZZKV2OQOEF4QN2G2K6GZ2Y7QN6YQ4A}"

echo "==> Building payment_router contract (release wasm) ..."
cd "${CONTRACT_DIR}"
cargo build --release --target wasm32-unknown-unknown

WASM_PATH="${CONTRACT_DIR}/target/wasm32-unknown-unknown/release/payment_router.wasm"
if [ ! -f "${WASM_PATH}" ]; then
  echo "ERROR: wasm not found at ${WASM_PATH}" >&2
  exit 1
fi

echo "==> Deploying contract to standalone network ..."
CONTRACT_ID="$(
  soroban contract deploy \
    --wasm "${WASM_PATH}" \
    --source "${FUNDED_SECRET}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}"
)"

echo "Contract deployed: ${CONTRACT_ID}"
echo "${CONTRACT_ID}" > "${SCRIPT_DIR}/.contract-id"

echo "==> Done. Contract ID written to tests/integration/.contract-id"
