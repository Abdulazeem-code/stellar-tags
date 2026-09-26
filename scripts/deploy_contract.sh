#!/usr/bin/env bash
# ==============================================================================
# scripts/deploy_contract.sh
#
# Automated wrapper script to deploy and upgrade the Soroban PaymentRouter contract.
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
