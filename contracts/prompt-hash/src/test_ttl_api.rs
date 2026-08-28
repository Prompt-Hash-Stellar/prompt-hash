use soroban_sdk::Env;

pub fn check(env: &Env) -> u32 {
    env.storage().instance().get_ttl()
}
