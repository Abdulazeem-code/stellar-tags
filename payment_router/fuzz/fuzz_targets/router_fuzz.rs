#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use payment_router::{ActionType, PaymentRouter, PaymentRouterClient};
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

const NUM_USERS: usize = 4;
const INITIAL_BALANCE: i128 = i128::MAX / 4;

#[derive(Debug, Arbitrary)]
enum FuzzAction {
    RoutePayment {
        sender_idx: u8,
        recipient_idx: u8,
        amount: i128,
    },
    QueueAction {
        action: FuzzTimelockAction,
    },
    ExecuteAction {
        nonce: u64,
    },
    CancelAction {
        nonce: u64,
    },
    EmergencyFreeze,
    Unfreeze,
    WithdrawRefund {
        user_idx: u8,
        amount: i128,
    },
    ClaimAllRefunds {
        user_idx: u8,
    },
    EmergencyWithdraw {
        amount: i128,
    },
    BlacklistAddress {
        user_idx: u8,
    },
    UnblacklistAddress {
        user_idx: u8,
    },
    SetPause {
        paused: bool,
    },
}

#[derive(Debug, Arbitrary)]
enum FuzzTimelockAction {
    SetFeeBps(i128),
    SetFeeConfig(i128, i128),
    SetMinLimit(i128),
}

#[derive(Debug, Arbitrary)]
struct FuzzInput {
    actions: Vec<FuzzAction>,
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    if client
        .try_initialize(&admin, &treasury, &100, &1_000_000, &1_000_000_000_000_000)
        .is_err()
    {
        return;
    }

    let token_admin = Address::generate(&env);
    let token_address = env.register_stellar_asset_contract(token_admin);
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);

    let users: Vec<Address> = (0..NUM_USERS).map(|_| Address::generate(&env)).collect();
    for user in &users {
        sac.mint(user, &INITIAL_BALANCE);
    }

    for action in input.actions.iter().take(20) {
        match action {
            FuzzAction::RoutePayment {
                sender_idx,
                recipient_idx,
                amount,
            } => {
                let sender = &users[*sender_idx as usize % users.len()];
                let recipient = &users[*recipient_idx as usize % users.len()];
                let _ = client.try_route_payment(sender, recipient, &token_address, &amount);
            }
            FuzzAction::QueueAction { action } => {
                let actual_action = match action {
                    FuzzTimelockAction::SetFeeBps(bps) => ActionType::SetFeeBps(*bps),
                    FuzzTimelockAction::SetFeeConfig(bps, cap) => {
                        ActionType::SetFeeConfig(*bps, *cap)
                    }
                    FuzzTimelockAction::SetMinLimit(limit) => ActionType::SetMinLimit(*limit),
                };
                let _ = client.try_queue_action(&actual_action);
            }
            FuzzAction::ExecuteAction { nonce } => {
                let _ = client.try_execute_action(&nonce);
            }
            FuzzAction::CancelAction { nonce } => {
                let _ = client.try_cancel_action(&nonce);
            }
            FuzzAction::EmergencyFreeze => {
                let _ = client.try_emergency_freeze();
            }
            FuzzAction::Unfreeze => {
                let _ = client.try_unfreeze();
            }
            FuzzAction::WithdrawRefund { user_idx, amount } => {
                let user = &users[*user_idx as usize % users.len()];
                let _ = client.try_withdraw_refund(user, &token_address, &amount);
            }
            FuzzAction::ClaimAllRefunds { user_idx } => {
                let user = &users[*user_idx as usize % users.len()];
                let _ = client.try_claim_all_refunds(user, &token_address);
            }
            FuzzAction::EmergencyWithdraw { amount } => {
                let _ = client.try_emergency_withdraw(&token_address, &amount);
            }
            FuzzAction::BlacklistAddress { user_idx } => {
                let user = &users[*user_idx as usize % users.len()];
                let _ = client.try_blacklist_address(user);
            }
            FuzzAction::UnblacklistAddress { user_idx } => {
                let user = &users[*user_idx as usize % users.len()];
                let _ = client.try_unblacklist_address(user);
            }
            FuzzAction::SetPause { paused } => {
                let _ = client.try_set_pause(&paused);
            }
        }
    }
});
