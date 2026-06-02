# Stellar Tags

Stellar Tags is a payment platform that combines a Soroban smart contract, a Node.js server, and a React dashboard. It is structured as a small mono-repo so each piece can be developed and deployed independently while still working together as a single product.

## What is inside

- `payment-dashboard/` - React + Vite frontend dashboard.
- `stellar-payment-platform/` - Node.js server for API and business logic.
- `payment_router/` - Rust/Soroban contract.

## Key features

- Desired specific username
- Fast transfer
- Secured payment flows

## Repository structure

```
.
├── payment-dashboard/
├── payment_router/
└── stellar-payment-platform/
```

## Getting started

> These steps are split by module so you can run only what you need.

### Frontend dashboard

```bash
cd payment-dashboard
npm install
npm run dev
```

### Server

```bash
cd stellar-payment-platform
npm install
npm run dev
```

### Smart contract (Soroban)

```bash
cd payment_router
cargo build
```

## Tests

```bash
# frontend
cd payment-dashboard
npm test

# server
cd ../stellar-payment-platform
npm test

# contract
cd ../payment_router
cargo test
```

## Environment variables

None.

## Architecture notes

- The React dashboard provides the user interface.
- The Node.js server exposes APIs used by the dashboard.
- The Soroban contract handles on-chain payment routing logic.

## License

See [LICENSE](LICENSE).
