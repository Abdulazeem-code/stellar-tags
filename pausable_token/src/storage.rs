use soroban_sdk::{contracttype, Address, BytesN, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Initialized,
    Paused,
    Name,
    Symbol,
    Decimals,
    TotalSupply,
    Balance(Address),
    Frozen(Address),
    Allowance(Address, Address),
    PermitNonce(Address),
}

/// Packs an allowance amount (i128, 16 bytes) and expiration ledger (u32, 4 bytes)
/// into a compact 20-byte big-endian byte array using zero-copy / slice copy operations.
pub fn pack_allowance(env: &Env, amount: i128, expiration_ledger: u32) -> BytesN<20> {
    let mut packed = [0u8; 20];
    let amount_bytes = amount.to_be_bytes();
    let exp_bytes = expiration_ledger.to_be_bytes();
    packed[0..16].copy_from_slice(&amount_bytes);
    packed[16..20].copy_from_slice(&exp_bytes);
    BytesN::from_array(env, &packed)
}

/// Unpacks a 20-byte big-endian byte array into `(amount: i128, expiration_ledger: u32)`.
pub fn unpack_allowance(packed: &BytesN<20>) -> (i128, u32) {
    let arr = packed.to_array();
    let mut amount_bytes = [0u8; 16];
    let mut exp_bytes = [0u8; 4];
    amount_bytes.copy_from_slice(&arr[0..16]);
    exp_bytes.copy_from_slice(&arr[16..20]);
    let amount = i128::from_be_bytes(amount_bytes);
    let expiration_ledger = u32::from_be_bytes(exp_bytes);
    (amount, expiration_ledger)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pack_unpack_basic() {
        let env = Env::default();
        let amount = 1000i128;
        let expiration = 50000u32;
        let packed = pack_allowance(&env, amount, expiration);
        assert_eq!(packed.to_array().len(), 20);
        let (unpacked_amount, unpacked_exp) = unpack_allowance(&packed);
        assert_eq!(unpacked_amount, amount);
        assert_eq!(unpacked_exp, expiration);
    }

    #[test]
    fn test_pack_unpack_max_values() {
        let env = Env::default();
        let amount = i128::MAX;
        let expiration = u32::MAX;
        let packed = pack_allowance(&env, amount, expiration);
        let (unpacked_amount, unpacked_exp) = unpack_allowance(&packed);
        assert_eq!(unpacked_amount, i128::MAX);
        assert_eq!(unpacked_exp, u32::MAX);
    }

    #[test]
    fn test_pack_unpack_zero_values() {
        let env = Env::default();
        let amount = 0i128;
        let expiration = 0u32;
        let packed = pack_allowance(&env, amount, expiration);
        let (unpacked_amount, unpacked_exp) = unpack_allowance(&packed);
        assert_eq!(unpacked_amount, 0);
        assert_eq!(unpacked_exp, 0);
    }

    #[test]
    fn test_property_roundtrip_fuzz() {
        let env = Env::default();
        let test_cases = [
            (0i128, 0u32),
            (1i128, 1u32),
            (i128::MAX, u32::MAX),
            (i128::MIN, 0u32),
            (-1i128, u32::MAX),
            (1234567890123456789i128, 999999u32),
            (-9876543210987654321i128, 12345u32),
        ];

        for (amount, expiration) in test_cases {
            let packed = pack_allowance(&env, amount, expiration);
            let (u_amount, u_exp) = unpack_allowance(&packed);
            assert_eq!(
                u_amount, amount,
                "Amount mismatch for amount={amount}, exp={expiration}"
            );
            assert_eq!(
                u_exp, expiration,
                "Expiration mismatch for amount={amount}, exp={expiration}"
            );
        }
    }
}
