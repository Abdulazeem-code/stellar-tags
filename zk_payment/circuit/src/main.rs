use ark_bls12_381::{Bls12_381, Fr};
use ark_ff::{BigInteger, Field, PrimeField};
use ark_groth16::Groth16;
use ark_r1cs_std::{
    alloc::AllocVar,
    eq::EqGadget,
    fields::{fp::FpVar, FieldVar},
    prelude::ToBitsGadget,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::CanonicalSerialize;
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

const ROUNDS: u32 = 91;
const COMMITMENT_DOMAIN: u64 = 1;
const NULLIFIER_DOMAIN: u64 = 2;

#[derive(Clone)]
struct PaymentCircuit {
    amount: Option<Fr>,
    recipient: Option<Fr>,
    secret: Option<Fr>,
    commitment: Option<Fr>,
    nullifier: Option<Fr>,
}

fn round_constant(round: u32) -> Fr {
    let mut hash = Sha256::new();
    hash.update(b"stellar-tags-zk-payment-mimc-v1");
    hash.update(round.to_be_bytes());
    Fr::from_be_bytes_mod_order(&hash.finalize())
}

fn permute(mut value: Fr) -> Fr {
    for round in 0..ROUNDS {
        let x = value + round_constant(round);
        let x2 = x.square();
        let x4 = x2.square();
        value = x4 * x2 * x;
    }
    value
}

fn hash_payment(amount: Fr, recipient: Fr, secret: Fr) -> Fr {
    let state = permute(amount + Fr::from(COMMITMENT_DOMAIN));
    let state = permute(state + recipient);
    permute(state + secret)
}

fn hash_nullifier(secret: Fr) -> Fr {
    permute(secret + Fr::from(NULLIFIER_DOMAIN))
}

fn permute_var(mut value: FpVar<Fr>) -> FpVar<Fr> {
    for round in 0..ROUNDS {
        let x = value + round_constant(round);
        let x2 = &x * &x;
        let x4 = &x2 * &x2;
        value = x4 * x2 * x;
    }
    value
}

impl ConstraintSynthesizer<Fr> for PaymentCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let amount = FpVar::new_witness(cs.clone(), || {
            self.amount.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let recipient = FpVar::new_witness(cs.clone(), || {
            self.recipient.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let secret = FpVar::new_witness(cs.clone(), || {
            self.secret.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let commitment = FpVar::new_input(cs.clone(), || {
            self.commitment.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let nullifier = FpVar::new_input(cs.clone(), || {
            self.nullifier.ok_or(SynthesisError::AssignmentMissing)
        })?;

        let amount_bits = amount.to_bits_le()?;
        for bit in amount_bits.iter().skip(64) {
            bit.enforce_equal(&ark_r1cs_std::boolean::Boolean::FALSE)?;
        }
        let inverse = FpVar::new_witness(cs.clone(), || {
            self.amount
                .and_then(|value| value.inverse())
                .ok_or(SynthesisError::AssignmentMissing)
        })?;
        (&amount * inverse).enforce_equal(&FpVar::one())?;

        let commitment_state = permute_var(amount + Fr::from(COMMITMENT_DOMAIN));
        let commitment_state = permute_var(commitment_state + recipient);
        permute_var(commitment_state + secret.clone()).enforce_equal(&commitment)?;
        permute_var(secret + Fr::from(NULLIFIER_DOMAIN)).enforce_equal(&nullifier)?;
        Ok(())
    }
}

fn serialize<T: CanonicalSerialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    value.serialize_uncompressed(&mut bytes).unwrap();
    bytes
}

fn scalar_bytes(value: Fr) -> [u8; 32] {
    let bytes = value.into_bigint().to_bytes_be();
    let mut output = [0u8; 32];
    output[32 - bytes.len()..].copy_from_slice(&bytes);
    output
}

fn main() {
    let amount = Fr::from(25_000_000u64);
    let recipient = Fr::from_be_bytes_mod_order(b"recipient:G_SAMPLE_PRIVATE_DESTINATION");
    let secret = Fr::from_be_bytes_mod_order(b"test-only-payment-secret");
    let commitment = hash_payment(amount, recipient, secret);
    let nullifier = hash_nullifier(secret);
    let circuit = PaymentCircuit {
        amount: Some(amount),
        recipient: Some(recipient),
        secret: Some(secret),
        commitment: Some(commitment),
        nullifier: Some(nullifier),
    };

    let mut setup_rng = ChaCha20Rng::from_seed([7u8; 32]);
    let parameters = Groth16::<Bls12_381>::generate_random_parameters_with_reduction(
        circuit.clone(),
        &mut setup_rng,
    )
    .unwrap();
    let mut proof_rng = ChaCha20Rng::from_seed([9u8; 32]);
    let proof = Groth16::<Bls12_381>::create_random_proof_with_reduction(
        circuit,
        &parameters,
        &mut proof_rng,
    )
    .unwrap();

    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
    fs::create_dir_all(&output).unwrap();
    let mut verification_key = Vec::new();
    verification_key.extend_from_slice(&serialize(&parameters.vk.alpha_g1));
    verification_key.extend_from_slice(&serialize(&parameters.vk.beta_g2));
    verification_key.extend_from_slice(&serialize(&parameters.vk.gamma_g2));
    verification_key.extend_from_slice(&serialize(&parameters.vk.delta_g2));
    let ic_len = u32::try_from(parameters.vk.gamma_abc_g1.len()).unwrap();
    verification_key.extend_from_slice(&ic_len.to_be_bytes());
    for point in &parameters.vk.gamma_abc_g1 {
        verification_key.extend_from_slice(&serialize(point));
    }
    fs::write(output.join("verification_key.bin"), verification_key).unwrap();

    let mut proof_bytes = Vec::new();
    proof_bytes.extend_from_slice(&serialize(&proof.a));
    proof_bytes.extend_from_slice(&serialize(&proof.b));
    proof_bytes.extend_from_slice(&serialize(&proof.c));
    fs::write(output.join("proof.bin"), proof_bytes).unwrap();
    let mut public_inputs = Vec::new();
    public_inputs.extend_from_slice(&scalar_bytes(commitment));
    public_inputs.extend_from_slice(&scalar_bytes(nullifier));
    fs::write(output.join("public_inputs.bin"), public_inputs).unwrap();
}
