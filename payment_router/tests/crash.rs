#![cfg(test)]
use soroban_sdk::{Env, vec, Address, testutils::Address as _};
use payment_router::{PaymentRouter, PaymentRouterClient, Payment};

#[test]
fn test_fuzz_crash() {
    println!("1: env");
    let env = Env::default();
    env.mock_all_auths();

    println!("2: initialize");
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &100, &1000000, &1000000000000000);

    println!("3: sac mint");
    let token_admin = Address::generate(&env);
    let token_address = env.register_stellar_asset_contract(token_admin);
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
    let senders: Vec<Address> = (0..4).map(|_| Address::generate(&env)).collect();
    for sender in &senders {
        sac.mint(sender, &(i128::MAX / 4));
    }
    let recipients: Vec<Address> = (0..4).map(|_| Address::generate(&env)).collect();

    println!("4: create payments");
    let mut payments = vec![&env];
    payments.push_back(Payment {
        sender: senders[0].clone(),
        recipient: senders[1].clone(), // Changed from recipients[3]
        token_address: token_address.clone(),
        amount: 1099528363175,
    });
    payments.push_back(Payment {
        sender: senders[0].clone(),
        recipient: recipients[0].clone(), // 0 % 4 = 0
        token_address: token_address.clone(),
        amount: 0,
    });

    println!("5: calling try_route_payments");
    let res = client.try_route_payments(&payments);
    println!("Result: {:?}", res);
}
