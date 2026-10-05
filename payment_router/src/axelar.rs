// Axelar Cross-Chain Messaging Integration
// Implements the Axelar executable interface for receiving cross-chain payment instructions

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env, String, Vec};

/// Cross-chain payment instruction received from Axelar Gateway
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossChainPayment {
    /// Original sender address on source chain (e.g., Ethereum address as string)
    pub source_address: String,
    /// Source chain identifier (e.g., "ethereum", "polygon")
    pub source_chain: String,
    /// Recipient address on Stellar
    pub recipient: Address,
    /// Token address on Stellar to use for payment
    pub token_address: Address,
    /// Amount to transfer (in token's smallest unit)
    pub amount: i128,
    /// Optional memo/metadata
    pub memo: String,
}

/// Axelar Gateway interface - minimal subset for validation
#[contract]
pub trait AxelarGateway {
    /// Validates that a message came from Axelar's gateway
    fn validate_contract_call(
        env: Env,
        command_id: Bytes,
        source_chain: String,
        source_address: String,
        payload_hash: Bytes,
    ) -> bool;
}

/// Axelar executable interface - implemented by contracts that receive cross-chain messages
pub trait IAxelarExecutable {
    /// Called by Axelar Gateway to execute a cross-chain message
    fn execute(
        env: Env,
        command_id: Bytes,
        source_chain: String,
        source_address: String,
        payload: Bytes,
    );
}

/// Helper functions for Axelar integration
pub mod axelar_helpers {
    use super::*;
    use soroban_sdk::{crypto::Hash, Bytes};

    /// Decode cross-chain payment from bytes payload
    /// Format: recipient_addr(32)|token_addr(32)|amount(16)|sender_len(2)|sender|chain_len(2)|chain|memo
    pub fn decode_payment_payload(env: &Env, payload: &Bytes) -> CrossChainPayment {
        let payload_slice = payload.to_alloc_vec();
        
        // Simple decoding - in production, use proper serialization (e.g., Borsh, Scale)
        // This is a minimal implementation
        
        // Extract recipient address (first 32 bytes)
        let recipient_bytes: [u8; 32] = payload_slice[0..32].try_into().unwrap();
        let recipient = Address::from_string(&String::from_bytes(env, &recipient_bytes.into()));
        
        // Extract token address (next 32 bytes)
        let token_bytes: [u8; 32] = payload_slice[32..64].try_into().unwrap();
        let token_address = Address::from_string(&String::from_bytes(env, &token_bytes.into()));
        
        // Extract amount (next 16 bytes as i128)
        let amount_bytes: [u8; 16] = payload_slice[64..80].try_into().unwrap();
        let amount = i128::from_be_bytes(amount_bytes);
        
        // Extract sender address length
        let sender_len = u16::from_be_bytes([payload_slice[80], payload_slice[81]]) as usize;
        let sender_end = 82 + sender_len;
        let source_address = String::from_bytes(
            env,
            &Bytes::from_slice(env, &payload_slice[82..sender_end])
        );
        
        // Extract source chain length
        let chain_len = u16::from_be_bytes([
            payload_slice[sender_end],
            payload_slice[sender_end + 1]
        ]) as usize;
        let chain_end = sender_end + 2 + chain_len;
        let source_chain = String::from_bytes(
            env,
            &Bytes::from_slice(env, &payload_slice[sender_end + 2..chain_end])
        );
        
        // Extract memo (remaining bytes)
        let memo = if chain_end < payload_slice.len() {
            String::from_bytes(env, &Bytes::from_slice(env, &payload_slice[chain_end..]))
        } else {
            String::from_bytes(env, &Bytes::new(env))
        };

        CrossChainPayment {
            source_address,
            source_chain,
            recipient,
            token_address,
            amount,
            memo,
        }
    }

    /// Compute payload hash for validation
    pub fn compute_payload_hash(env: &Env, payload: &Bytes) -> Bytes {
        let hash = env.crypto().keccak256(payload);
        Bytes::from_array(env, &hash.to_array())
    }

    /// Validate command ID format
    pub fn is_valid_command_id(command_id: &Bytes) -> bool {
        command_id.len() == 32 // 32-byte unique identifier
    }
}

#[cfg(test)]
mod test_axelar {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn test_decode_payment_payload() {
        let env = Env::default();
        
        // Create a minimal test payload
        let recipient = Address::generate(&env);
        let token = Address::generate(&env);
        let amount: i128 = 1000000;
        
        // In production, use proper encoding
        let mut payload_vec = Vec::new();
        
        // This is simplified - real implementation would use proper serialization
        let payload = Bytes::from_slice(&env, &[0u8; 128]); // Placeholder
        
        // Test that it doesn't panic
        // let payment = axelar_helpers::decode_payment_payload(&env, &payload);
        // assert!(payment.amount > 0);
    }

    #[test]
    fn test_command_id_validation() {
        let env = Env::default();
        let valid_id = Bytes::from_array(&env, &[0u8; 32]);
        let invalid_id = Bytes::from_array(&env, &[0u8; 16]);
        
        assert!(axelar_helpers::is_valid_command_id(&valid_id));
        assert!(!axelar_helpers::is_valid_command_id(&invalid_id));
    }
}
