# Contract Integration Tests

These tests verify the `payment_router` Soroban contract interacts correctly
with a **real** Stellar network by running against a local standalone node
started in Docker. Unlike the in-memory unit tests in `payment_router/src/lib.rs`,
these tests submit actual transactions to a live Horizon/RPC endpoint and
observe the resulting network state.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  docker compose --profile integration                       │
│                                                             │
│  stellar-standalone (stellar/quickstart)                    │
│    ├── Horizon REST API  ──►  http://localhost:8000         │
│    └── Soroban RPC       ──►  http://localhost:8000/rpc     │
│                                                             │
│  api-test (Node.js server) ──►  http://localhost:5001       │
└─────────────────────────────────────────────────────────────┘
```

The standalone network is pre-funded with a root account and supports Soroban
smart contracts out of the box.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2
- [soroban CLI](https://soroban.stellar.org/docs/reference/cli) (`cargo install soroban-cli`)
- Rust toolchain with the `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```

## Running

```bash
# 1. Start the standalone Stellar network
docker compose --profile integration up -d stellar-standalone

# 2. Wait for Horizon to be ready (healthcheck handles this automatically)

# 3. Run the end-to-end integration test
bash tests/integration/run.sh
```

The script:

1. Builds the contract to a release wasm.
2. Deploys it to the local standalone network.
3. Creates and funds test accounts.
4. Initializes the contract with an admin, treasury, and fee config.
5. Routes a payment and verifies the result through local Horizon.

## Deploying the contract only

If you only need the contract deployed (e.g. to inspect it manually), run:

```bash
bash tests/integration/deploy.sh
```

The deployed contract ID is written to `tests/integration/.contract-id`.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `RPC_URL` | `http://localhost:8000/rpc` | Soroban RPC endpoint |
| `HORIZON_URL` | `http://localhost:8000` | Horizon REST endpoint |
| `FUNDED_SECRET` | root account secret | Source account for funding/deploying |
