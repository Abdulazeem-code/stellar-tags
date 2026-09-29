#!/usr/bin/env bash
#
# Generates TypeScript bindings for the payment_router Soroban contract and
# writes them to packages/types.
#
# The bindings are derived from the contract ABI (spec) embedded in the WASM,
# so the contract is built first and `contract bindings typescript` is run
# against the resulting artifact. Generated files are checked into the repo so
# CI and the frontend never need the CLI installed — run this script whenever
# the contract's public interface changes and commit the result.
#
# Requirements:
#   - cargo with the wasm32-unknown-unknown target installed (to build the contract)
#   - the stellar (or soroban) CLI: https://github.com/stellar/stellar-cli
#
# You can point the script at a specific CLI binary with the STELLAR_CLI env
# var, e.g.:
#   STELLAR_CLI=/opt/stellar-cli/bin/stellar ./scripts/generate-bindings.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$ROOT/payment_router"
PACKAGE_DIR="$ROOT/packages/types"
PACKAGE_NAME="@stellar-tags/payment-router"
WASM_REL="target/wasm32-unknown-unknown/release/payment_router.wasm"

# --- 1. Locate the CLI ------------------------------------------------------
CLI="${STELLAR_CLI:-}"
if [[ -z "$CLI" ]]; then
  if command -v stellar >/dev/null 2>&1; then
    CLI="stellar"
  elif command -v soroban >/dev/null 2>&1; then
    CLI="soroban"
  else
    echo "error: neither 'stellar' nor 'soroban' CLI found on PATH." >&2
    echo "       Install it from https://github.com/stellar/stellar-cli or set STELLAR_CLI." >&2
    exit 1
  fi
fi

echo "Using CLI: $CLI"

# --- 2. Build the contract WASM ---------------------------------------------
echo "Building payment_router contract (wasm32-unknown-unknown, release)..."
cargo build --manifest-path "$CONTRACT_DIR/Cargo.toml" --target wasm32-unknown-unknown --release

WASM="$CONTRACT_DIR/$WASM_REL"
if [[ ! -f "$WASM" ]]; then
  echo "error: expected WASM artifact not found at $WASM" >&2
  exit 1
fi

# --- 3. Generate bindings into a temp dir -----------------------------------
# The CLI names the package after the output directory, so generate into a
# temp dir with the desired name and move the result into place.
TMP_ROOT="$(mktemp -d)"
TMP_OUT="$TMP_ROOT/payment-router"
trap 'rm -rf "$TMP_ROOT"' EXIT

echo "Generating TypeScript bindings..."
"$CLI" contract bindings typescript \
  --wasm "$WASM" \
  --output-dir "$TMP_OUT" \
  --overwrite

# --- 4. Move into packages/types --------------------------------------------
rm -rf "$PACKAGE_DIR"
mkdir -p "$(dirname "$PACKAGE_DIR")"
cp -R "$TMP_OUT" "$PACKAGE_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT

# --- 5. Normalize package metadata ------------------------------------------
# The generated package.json points at a compiled dist/ that only exists after
# `tsc`. Point it at the checked-in TS source so Vite (and other bundlers) can
# consume the bindings directly with no build step.
node - "$PACKAGE_DIR/package.json" "$PACKAGE_NAME" <<'EOF'
const fs = require("fs");
const [pkgPath, name] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.name = name;
pkg.description =
  "Auto-generated TypeScript client for the stellar-tags payment_router " +
  "Soroban contract. Generated from the contract ABI by " +
  "scripts/generate-bindings.sh \u2014 do not edit by hand.";
pkg.exports = "./src/index.ts";
pkg.main = "./src/index.ts";
pkg.types = "./src/index.ts";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
EOF

# --- 6. Inject network metadata ----------------------------------------------
# Generated-from-WASM bindings have no network context, so the CLI cannot emit
# the `networks` constant. Inject it (idempotently) so consumers get the
# contract ID and passphrase from the shared package.
node - "$PACKAGE_DIR/src/index.ts" "$PACKAGE_NAME" <<'EOF'
const fs = require("fs");
const [filePath, name] = process.argv.slice(2);
let src = fs.readFileSync(filePath, "utf8");
if (!src.includes("export const networks")) {
  const networks = `\n/**\n * Known deployments of the payment_router contract. The WASM-based generator\n * cannot emit these (it has no network context), so scripts/generate-bindings.sh\n * injects them after generation.\n */\nexport const networks = {\n  testnet: {\n    networkPassphrase: "Test SDF Network ; September 2015",\n    contractId: "CDNQ7OMHIFOLZHOKWQLOGDW7CF3DRMKXJC6OULNGNBWF4O4NO2NEIGER",\n  },\n} as const;\n`;
  const marker = 'window.Buffer = window.Buffer || Buffer;\n}';
  const idx = src.indexOf(marker);
  if (idx !== -1) {
    src = src.slice(0, idx + marker.length) + networks + src.slice(idx + marker.length);
  } else {
    src += networks;
  }
  fs.writeFileSync(filePath, src);
}
EOF

# The generated README references the temp-dir package name; swap it for the
# real scoped name so the checked-in docs stay accurate (keeping the
# illustrative output-dir path un-scoped).
sed -i "s|\bpayment-router\b|$PACKAGE_NAME|g" "$PACKAGE_DIR/README.md"
sed -i "s|\./path/to/$PACKAGE_NAME|./path/to/payment-router|g" "$PACKAGE_DIR/README.md"

echo "Done. Bindings written to $PACKAGE_DIR"
