#!/usr/bin/env bash
# ==============================================================================
# scripts/deploy_contract.sh
#
# Automated wrapper to deploy, upgrade, and manage Soroban contracts.
#
# KEY COMMANDS:
#   deploy              — Deploy PaymentRouter only (legacy)
#   deploy-proxy        — Deploy PaymentRouter + PaymentProxy wired together
#   upgrade-proxy-logic — Point proxy at a new logic contract address
#   upgrade             — Upgrade PaymentRouter WASM in-place via its timelock
#   build               — Compile and optimize WASM only
#
# Run with --help for full usage.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Ensure Node.js is available
if ! command -v node &> /dev/null; then
  echo "❌ Error: Node.js is required but not installed or not in PATH."
  exit 1
fi

# Execute Node.js deployment script forwarding all arguments
exec node "${SCRIPT_DIR}/deploy.js" "$@"
