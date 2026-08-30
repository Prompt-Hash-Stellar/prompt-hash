use crate::contract::{PromptHashContract, PromptHashContractClient};
use crate::ttl_policy::PERSISTENT_BUMP_AMOUNT;
use crate::types::DataKey;
use soroban_sdk::testutils::{storage::Persistent, Address as _};
use soroban_sdk::{Address, Env};

#[test]
fn test_extend_ttl_policy() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_wallet = Address::generate(&env);
    let xlm_sac = Address::generate(&env);
    let contract_id = env.register(PromptHashContract, (&admin, &fee_wallet, &xlm_sac));
    let client = PromptHashContractClient::new(&env, &contract_id);

    let reviewer = Address::generate(&env);

    // Add a Reviewer key to test persistent TTL extending
    client.add_reviewer(&admin, &reviewer);

    let key = DataKey::Reviewers;
    // Using `extend_ttl` directly on the client to bump it according to policy.
    client.extend_ttl(&key);

    // The key gets bumped from the current ledger up to PERSISTENT_BUMP_AMOUNT
    let ttl = env.as_contract(&contract_id, || env.storage().persistent().get_ttl(&key));
    assert_eq!(ttl, PERSISTENT_BUMP_AMOUNT);
}
