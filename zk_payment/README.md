# ZK payment contract

This Soroban contract verifies a payment proof without receiving the private
amount or recipient identifier. It records a commitment only when the proof is
valid and blocks reuse of the proof's nullifier.

See [the circuit and usage guide](../docs/zk-private-payments.md) for the input
rules, setup warning, and test commands.
