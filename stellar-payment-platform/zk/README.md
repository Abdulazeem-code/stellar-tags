# Confidential settlement range proofs

`rangeProof.circom` is a Groth16 circuit that proves a payment amount is inside
`(0, maxLimit)` without revealing the amount. The public signals are:

1. `commitment` — `Poseidon(amount, blinding)`
2. `maxLimit` — the exclusive upper bound used by the proof

The amount and blinding factor are private witnesses. The backend wrapper is
`src/services/zkProofService.js`.

## Usage

```js
const {
  generateRangeProof,
  verifyProof,
} = require('./src/services/zkProofService');

const proof = await generateRangeProof(25_000_000, {
  blinding: '123456789012345678',
});

// proof.proofHex holds the proof and public signals.
// proof.commitment is the value to submit on-chain.
const valid = await verifyProof(proof.proofHex, {
  commitment: proof.commitment,
});
```

`ZK_MAX_PAYMENT_AMOUNT` overrides the default exclusive upper bound
(`1_000_000_000_000`). `ZK_ARTIFACT_DIR`, `ZK_WASM_PATH`, `ZK_ZKEY_PATH` and
`ZK_VERIFICATION_KEY_PATH` can override the artifact locations.

## Artifacts

`artifacts/` contains the compiled circuit (`rangeProof.wasm`), the proving key
(`rangeProof_final.zkey`) and the verification key (`verification_key.json`).
The service loads these files lazily on first use and keeps the verification
curve in memory.

## Regenerating the artifacts

Install `circom2` and `snarkjs`, then run the following from this directory:

```sh
circom2 rangeProof.circom --r1cs --wasm --sym -l node_modules
snarkjs powersoftau new bn128 12 pot12_0000.ptau
snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau --name="stellar-tags" -e="local entropy"
snarkjs powersoftau prepare phase2 pot12_0001.ptau pot12_final.ptau
snarkjs groth16 setup rangeProof.r1cs pot12_final.ptau rangeProof_0000.zkey
snarkjs zkey contribute rangeProof_0000.zkey rangeProof_final.zkey --name="stellar-tags" -e="local entropy"
snarkjs zkey export verificationkey rangeProof_final.zkey verification_key.json
```

Copy `rangeProof_js/rangeProof.wasm`, `rangeProof_final.zkey` and
`verification_key.json` into `artifacts/`.

> The checked-in setup was generated locally for tests. It is not a production
> trusted setup and must not be used to protect real funds. A production
> deployment needs a multi-party ceremony, an audited circuit and a
> verification key that no single party could have back-doored.
