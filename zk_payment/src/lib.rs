#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::bls12_381::{Bls12381Fr, Bls12381G1Affine, Bls12381G2Affine},
    panic_with_error, Env, Vec,
};

#[derive(Clone)]
#[contracttype]
pub struct VerificationKey {
    pub alpha: Bls12381G1Affine,
    pub beta: Bls12381G2Affine,
    pub gamma: Bls12381G2Affine,
    pub delta: Bls12381G2Affine,
    pub ic: Vec<Bls12381G1Affine>,
}

#[derive(Clone)]
#[contracttype]
pub struct Proof {
    pub a: Bls12381G1Affine,
    pub b: Bls12381G2Affine,
    pub c: Bls12381G1Affine,
}

#[contractevent(topics = ["zkpay"])]
pub struct PaymentVerified {
    #[topic]
    pub commitment: Bls12381Fr,
    pub nullifier: Bls12381Fr,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    VerificationKey,
    Nullifier(Bls12381Fr),
    Payment(Bls12381Fr),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    MalformedVerifyingKey = 2,
    InvalidProof = 3,
    NullifierUsed = 4,
}

#[contract]
pub struct ZkPayment;

#[contractimpl]
impl ZkPayment {
    pub fn __constructor(env: Env, verification_key: VerificationKey) {
        if verification_key.ic.len() != 3 {
            panic_with_error!(&env, Error::MalformedVerifyingKey);
        }
        env.storage()
            .instance()
            .set(&DataKey::VerificationKey, &verification_key);
    }

    pub fn verify(
        env: Env,
        proof: Proof,
        commitment: Bls12381Fr,
        nullifier: Bls12381Fr,
    ) -> Result<bool, Error> {
        let verification_key: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .ok_or(Error::NotInitialized)?;
        Self::verify_proof(&env, &verification_key, &proof, &commitment, &nullifier)
    }

    pub fn submit(
        env: Env,
        proof: Proof,
        commitment: Bls12381Fr,
        nullifier: Bls12381Fr,
    ) -> Result<(), Error> {
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            return Err(Error::NullifierUsed);
        }

        let verification_key: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .ok_or(Error::NotInitialized)?;
        if !Self::verify_proof(&env, &verification_key, &proof, &commitment, &nullifier)? {
            return Err(Error::InvalidProof);
        }

        env.storage().persistent().set(&nullifier_key, &());
        let payment_key = DataKey::Payment(commitment.clone());
        env.storage().persistent().set(&payment_key, &());
        let max_ttl = env.storage().max_ttl();
        env.storage()
            .persistent()
            .extend_ttl(&nullifier_key, max_ttl, max_ttl);
        env.storage()
            .persistent()
            .extend_ttl(&payment_key, max_ttl, max_ttl);
        PaymentVerified {
            commitment,
            nullifier,
        }
        .publish(&env);
        Ok(())
    }

    pub fn payment_exists(env: Env, commitment: Bls12381Fr) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Payment(commitment))
    }

    pub fn nullifier_used(env: Env, nullifier: Bls12381Fr) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    fn verify_proof(
        env: &Env,
        verification_key: &VerificationKey,
        proof: &Proof,
        commitment: &Bls12381Fr,
        nullifier: &Bls12381Fr,
    ) -> Result<bool, Error> {
        if verification_key.ic.len() != 3 {
            return Err(Error::MalformedVerifyingKey);
        }

        let bls = env.crypto().bls12_381();
        let mut vk_x = verification_key.ic.get(0).unwrap();
        let commitment_term = bls.g1_mul(&verification_key.ic.get(1).unwrap(), commitment);
        vk_x = bls.g1_add(&vk_x, &commitment_term);
        let nullifier_term = bls.g1_mul(&verification_key.ic.get(2).unwrap(), nullifier);
        vk_x = bls.g1_add(&vk_x, &nullifier_term);

        let lhs = soroban_sdk::vec![
            env,
            -proof.a.clone(),
            verification_key.alpha.clone(),
            vk_x,
            proof.c.clone()
        ];
        let rhs = soroban_sdk::vec![
            env,
            proof.b.clone(),
            verification_key.beta.clone(),
            verification_key.gamma.clone(),
            verification_key.delta.clone()
        ];
        Ok(bls.pairing_check(lhs, rhs))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        crypto::bls12_381::{G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE},
        Bytes, U256,
    };

    const VK_BYTES: &[u8] = include_bytes!("../tests/fixtures/verification_key.bin");
    const PROOF_BYTES: &[u8] = include_bytes!("../tests/fixtures/proof.bin");
    const PUBLIC_INPUTS: &[u8] = include_bytes!("../tests/fixtures/public_inputs.bin");

    fn g1(env: &Env, bytes: &[u8]) -> Bls12381G1Affine {
        let array: [u8; G1_SERIALIZED_SIZE] = bytes.try_into().unwrap();
        Bls12381G1Affine::from_array(env, &array)
    }

    fn g2(env: &Env, bytes: &[u8]) -> Bls12381G2Affine {
        let array: [u8; G2_SERIALIZED_SIZE] = bytes.try_into().unwrap();
        Bls12381G2Affine::from_array(env, &array)
    }

    fn fr(env: &Env, bytes: &[u8]) -> Bls12381Fr {
        let array: [u8; 32] = bytes.try_into().unwrap();
        Bls12381Fr::from_u256(U256::from_be_bytes(env, &Bytes::from_array(env, &array)))
    }

    fn fixture(env: &Env) -> (VerificationKey, Proof, Bls12381Fr, Bls12381Fr) {
        let mut offset = 0;
        let alpha = g1(env, &VK_BYTES[offset..offset + G1_SERIALIZED_SIZE]);
        offset += G1_SERIALIZED_SIZE;
        let beta = g2(env, &VK_BYTES[offset..offset + G2_SERIALIZED_SIZE]);
        offset += G2_SERIALIZED_SIZE;
        let gamma = g2(env, &VK_BYTES[offset..offset + G2_SERIALIZED_SIZE]);
        offset += G2_SERIALIZED_SIZE;
        let delta = g2(env, &VK_BYTES[offset..offset + G2_SERIALIZED_SIZE]);
        offset += G2_SERIALIZED_SIZE;
        let ic_len = u32::from_be_bytes(VK_BYTES[offset..offset + 4].try_into().unwrap());
        offset += 4;
        let mut ic = Vec::new(env);
        for _ in 0..ic_len {
            ic.push_back(g1(env, &VK_BYTES[offset..offset + G1_SERIALIZED_SIZE]));
            offset += G1_SERIALIZED_SIZE;
        }
        assert_eq!(offset, VK_BYTES.len());

        let mut proof_offset = 0;
        let a = g1(
            env,
            &PROOF_BYTES[proof_offset..proof_offset + G1_SERIALIZED_SIZE],
        );
        proof_offset += G1_SERIALIZED_SIZE;
        let b = g2(
            env,
            &PROOF_BYTES[proof_offset..proof_offset + G2_SERIALIZED_SIZE],
        );
        proof_offset += G2_SERIALIZED_SIZE;
        let c = g1(
            env,
            &PROOF_BYTES[proof_offset..proof_offset + G1_SERIALIZED_SIZE],
        );
        proof_offset += G1_SERIALIZED_SIZE;
        assert_eq!(proof_offset, PROOF_BYTES.len());

        (
            VerificationKey {
                alpha,
                beta,
                gamma,
                delta,
                ic,
            },
            Proof { a, b, c },
            fr(env, &PUBLIC_INPUTS[..32]),
            fr(env, &PUBLIC_INPUTS[32..]),
        )
    }

    fn client<'a>(env: &'a Env, verification_key: &VerificationKey) -> ZkPaymentClient<'a> {
        let contract_id = env.register(ZkPayment, (verification_key,));
        ZkPaymentClient::new(env, &contract_id)
    }

    #[test]
    fn verifies_the_payment_circuit() {
        let env = Env::default();
        let (verification_key, proof, commitment, nullifier) = fixture(&env);
        let client = client(&env, &verification_key);

        assert!(client.verify(&proof, &commitment, &nullifier));
    }

    #[test]
    fn records_state_only_after_a_valid_proof() {
        let env = Env::default();
        let (verification_key, proof, commitment, nullifier) = fixture(&env);
        let client = client(&env, &verification_key);
        let invalid_commitment = Bls12381Fr::from_u256(U256::from_u32(&env, 1));

        assert!(client
            .try_submit(&proof, &invalid_commitment, &nullifier)
            .is_err());
        assert!(!client.payment_exists(&invalid_commitment));
        assert!(!client.nullifier_used(&nullifier));

        client.submit(&proof, &commitment, &nullifier);
        assert!(client.payment_exists(&commitment));
        assert!(client.nullifier_used(&nullifier));
    }

    #[test]
    fn rejects_a_reused_nullifier() {
        let env = Env::default();
        let (verification_key, proof, commitment, nullifier) = fixture(&env);
        let client = client(&env, &verification_key);

        client.submit(&proof, &commitment, &nullifier);
        assert!(client.try_submit(&proof, &commitment, &nullifier).is_err());
    }
}
