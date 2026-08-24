use super::types::{
    DataKey, Error, Escrow, InstanceDataKey, ListingRevisionRecord, Prompt, Purchase,
    PurchaseDispute, UpgradeProposal,
};
use soroban_sdk::{token, Address, BytesN, Env, String, Vec};

pub const DAY_IN_LEDGERS: u32 = 17280;
pub const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
/// Hard cap on any single page of discovery-index results, independent of
/// market size (#83). A `limit` of `0` or greater than this is clamped down.
pub const MAX_PAGE_SIZE: u32 = 50;

fn clamp_limit(limit: u32) -> u32 {
    if limit == 0 {
        MAX_PAGE_SIZE
    } else {
        limit.min(MAX_PAGE_SIZE)
    }
}

fn ensure(condition: bool, error: Error) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(error)
    }
}

/// Instance-scoped storage for contract-level configuration.
/// Uses `env.storage().instance()` — no TTL, survives upgrades.
pub struct InstanceStorage;

impl InstanceStorage {
    pub fn get_prompt_counter(env: &Env) -> u64 {
        let key = InstanceDataKey::PromptCounter;
        env.storage().instance().get(&key).unwrap_or(0)
    }

    pub fn save_prompt_counter(env: &Env, count: u64) {
        let key = InstanceDataKey::PromptCounter;
        env.storage().instance().set(&key, &count);
    }

    pub fn set_fee_percentage(env: &Env, fee_percentage: &u32) {
        let key = InstanceDataKey::FeePercentage;
        env.storage().instance().set(&key, fee_percentage);
    }

    pub fn get_fee_percentage(env: &Env) -> u32 {
        let key = InstanceDataKey::FeePercentage;
        env.storage().instance().get(&key).unwrap_or(0)
    }

    pub fn set_fee_wallet(env: &Env, fee_wallet: &Address) {
        let key = InstanceDataKey::FeeWallet;
        env.storage().instance().set(&key, fee_wallet);
    }

    pub fn get_fee_wallet(env: &Env) -> Option<Address> {
        env.storage().instance().get(&InstanceDataKey::FeeWallet)
    }

    pub fn set_xlm_address(env: &Env, xlm_address: &Address) {
        let key = InstanceDataKey::XlmAddress;
        env.storage().instance().set(&key, xlm_address);
    }

    pub fn get_xlm_address(env: &Env) -> Option<Address> {
        env.storage().instance().get(&InstanceDataKey::XlmAddress)
    }

    pub fn get_stellar_asset_contract(
        env: &'_ Env,
    ) -> Result<token::StellarAssetClient<'_>, Error> {
        let contract_id = Self::get_xlm_address(env).ok_or(Error::XlmAddressNotSet)?;
        Ok(token::StellarAssetClient::new(env, &contract_id))
    }

    pub fn set_reentrancy_guard(env: &Env) -> Result<(), Error> {
        let key = InstanceDataKey::Reentrancy;
        let already_set = env
            .storage()
            .instance()
            .get::<_, bool>(&key)
            .unwrap_or(false);
        ensure(!already_set, Error::ReentrancyGuard)?;
        env.storage().instance().set(&key, &true);
        Ok(())
    }

    pub fn clear_reentrancy_guard(env: &Env) {
        let key = InstanceDataKey::Reentrancy;
        env.storage().instance().set(&key, &false);
    }

    pub fn get_referral_percentage(env: &Env) -> u32 {
        let key = InstanceDataKey::ReferralPercentage;
        env.storage().instance().get(&key).unwrap_or(0)
    }

    pub fn set_pause_status(env: &Env, is_paused: bool) {
        let key = InstanceDataKey::IsPaused;
        env.storage().instance().set(&key, &is_paused);
    }

    pub fn is_paused(env: &Env) -> bool {
        let key = InstanceDataKey::IsPaused;
        env.storage().instance().get(&key).unwrap_or(false)
    }

    pub fn set_reviewer_threshold(env: &Env, threshold: u32) {
        let key = InstanceDataKey::ReviewerThreshold;
        env.storage().instance().set(&key, &threshold);
    }

    pub fn get_reviewer_threshold(env: &Env) -> u32 {
        let key = InstanceDataKey::ReviewerThreshold;
        env.storage().instance().get(&key).unwrap_or(1)
    }

    pub fn get_upgrade_threshold(env: &Env) -> u32 {
        let key = InstanceDataKey::UpgradeThreshold;
        env.storage().instance().get(&key).unwrap_or(0)
    }

    pub fn set_upgrade_threshold(env: &Env, threshold: u32) {
        let key = InstanceDataKey::UpgradeThreshold;
        env.storage().instance().set(&key, &threshold);
    }

    pub fn get_upgrade_epoch(env: &Env) -> u32 {
        let key = InstanceDataKey::UpgradeEpoch;
        env.storage().instance().get(&key).unwrap_or(0)
    }

    pub fn increment_upgrade_epoch(env: &Env) -> Result<u32, Error> {
        let next = Self::get_upgrade_epoch(env)
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        env.storage()
            .instance()
            .set(&InstanceDataKey::UpgradeEpoch, &next);
        Ok(next)
    }

    pub fn get_current_wasm_hash(env: &Env) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get(&InstanceDataKey::CurrentWasmHash)
    }

    pub fn set_current_wasm_hash(env: &Env, hash: &BytesN<32>) {
        env.storage()
            .instance()
            .set(&InstanceDataKey::CurrentWasmHash, hash);
    }

    pub fn get_previous_wasm_hash(env: &Env) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get(&InstanceDataKey::PreviousWasmHash)
    }

    pub fn set_previous_wasm_hash(env: &Env, hash: &BytesN<32>) {
        env.storage()
            .instance()
            .set(&InstanceDataKey::PreviousWasmHash, hash);
    }

    pub fn get_schema_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&InstanceDataKey::SchemaVersion)
            .unwrap_or(0)
    }

    pub fn set_schema_version(env: &Env, version: u32) {
        env.storage()
            .instance()
            .set(&InstanceDataKey::SchemaVersion, &version);
    }

    /// Returns the next free upgrade-proposal id and persists the counter.
    pub fn next_upgrade_proposal_id(env: &Env) -> Result<u32, Error> {
        let key = InstanceDataKey::UpgradeProposalCounter;
        let id: u32 = env.storage().instance().get(&key).unwrap_or(0);
        let next = id.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        env.storage().instance().set(&key, &next);
        Ok(id)
    }
}

/// Persistent storage for prompt, purchase, and user-index records.
/// Each entry is subject to TTL management via `extend_key_ttl`.
pub struct Storage;

impl Storage {
    pub fn extend_key_ttl(env: &Env, key: &DataKey) {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(
                key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
    }

    pub fn save_prompt(env: &Env, prompt: &Prompt) -> Result<(), Error> {
        let key = DataKey::Prompt(prompt.id);
        env.storage().persistent().set(&key, prompt);
        Self::extend_key_ttl(env, &key);
        Self::extend_key_ttl(env, &DataKey::PromptFeePolicyVersion(prompt.id));

        let next_prompt_id = prompt.id.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        InstanceStorage::save_prompt_counter(env, next_prompt_id);
        Ok(())
    }

    pub fn get_prompt(env: &Env, prompt_id: u64) -> Option<Prompt> {
        let key = DataKey::Prompt(prompt_id);
        if let Some(prompt) = env.storage().persistent().get(&key) {
            Self::extend_key_ttl(env, &key);
            Self::extend_key_ttl(env, &DataKey::PromptFeePolicyVersion(prompt_id));
            Some(prompt)
        } else {
            None
        }
    }

    pub fn require_prompt(env: &Env, prompt_id: u64) -> Result<Prompt, Error> {
        Self::get_prompt(env, prompt_id).ok_or(Error::PromptNotFound)
    }

    pub fn update_prompt(env: &Env, prompt: &Prompt) {
        let key = DataKey::Prompt(prompt.id);
        env.storage().persistent().set(&key, prompt);
        Self::extend_key_ttl(env, &key);
        Self::extend_key_ttl(env, &DataKey::PromptFeePolicyVersion(prompt.id));
    }

    /// The fee-policy version `prompt_id` is pinned to. Defaults to `0` (the
    /// pre-governance baseline) if the listing predates fee-policy
    /// versioning or its pin has never been set (#82).
    pub fn get_prompt_fee_policy_version(env: &Env, prompt_id: u64) -> u32 {
        let key = DataKey::PromptFeePolicyVersion(prompt_id);
        let version = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        version.unwrap_or(0)
    }

    pub fn set_prompt_fee_policy_version(env: &Env, prompt_id: u64, version: u32) {
        let key = DataKey::PromptFeePolicyVersion(prompt_id);
        env.storage().persistent().set(&key, &version);
        Self::extend_key_ttl(env, &key);
    }

    /// Look up an activated fee-policy record by version, if it has been
    /// materialized (#82). Version `0` is not written eagerly — see
    /// `contract::resolve_fee_policy` for the synthesized baseline.
    pub fn get_fee_policy(env: &Env, version: u32) -> Option<FeePolicy> {
        let key = DataKey::FeePolicyHistory(version);
        let policy = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        policy
    }

    pub fn save_fee_policy(env: &Env, policy: &FeePolicy) {
        let key = DataKey::FeePolicyHistory(policy.version);
        env.storage().persistent().set(&key, policy);
        Self::extend_key_ttl(env, &key);
    }

    // --- Discovery-index primitives (#83) -----------------------------
    //
    // Each index (Active / Creator / Buyer / Category / Tag) is a doubly
    // linked list of `IndexNode`s keyed by `DataKey::IndexNode(scope, id)`,
    // with head/tail/count bookkeeping in `DataKey::IndexMeta(scope)`.
    // Insertion appends at the tail (oldest-first, matching the previous
    // Vec-based indexes' order), and both insert/remove/paginate are O(1)
    // per hop — no single call ever touches more than a bounded window of
    // storage entries, independent of how large the market grows. These
    // indexes are rebuildable discovery state, never a source of
    // authorization: every auth check reads canonical `Prompt`/`Purchase`
    // fields directly (see contract.rs), never index membership.

    fn get_index_meta(env: &Env, scope: &IndexScope) -> IndexMeta {
        env.storage()
            .persistent()
            .get(&DataKey::IndexMeta(scope.clone()))
            .unwrap_or(IndexMeta {
                head: None,
                tail: None,
                count: 0,
            })
    }

    fn save_index_meta(env: &Env, scope: &IndexScope, meta: &IndexMeta) {
        let key = DataKey::IndexMeta(scope.clone());
        env.storage().persistent().set(&key, meta);
        Self::extend_key_ttl(env, &key);
    }

    fn get_index_node(env: &Env, scope: &IndexScope, id: u64) -> Option<IndexNode> {
        let key = DataKey::IndexNode(scope.clone(), id);
        let node = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        node
    }

    fn save_index_node(env: &Env, scope: &IndexScope, id: u64, node: &IndexNode) {
        let key = DataKey::IndexNode(scope.clone(), id);
        env.storage().persistent().set(&key, node);
        Self::extend_key_ttl(env, &key);
    }

    /// Idempotent O(1) append. No-op if `id` is already present in `scope`,
    /// which is what makes migration and re-indexing safe to re-run and
    /// prevents stale/duplicate entries.
    pub fn index_insert(env: &Env, scope: &IndexScope, id: u64) {
        if Self::get_index_node(env, scope, id).is_some() {
            return;
        }
        let mut meta = Self::get_index_meta(env, scope);
        if let Some(old_tail) = meta.tail {
            if let Some(mut old_tail_node) = Self::get_index_node(env, scope, old_tail) {
                old_tail_node.next = Some(id);
                Self::save_index_node(env, scope, old_tail, &old_tail_node);
            }
        }
        let node = IndexNode {
            prev: meta.tail,
            next: None,
        };
        meta.tail = Some(id);
        if meta.head.is_none() {
            meta.head = Some(id);
        }
        meta.count = meta.count.saturating_add(1);
        Self::save_index_node(env, scope, id, &node);
        Self::save_index_meta(env, scope, &meta);
    }

    /// Idempotent O(1) unlink. No-op if `id` is absent from `scope`.
    pub fn index_remove(env: &Env, scope: &IndexScope, id: u64) {
        let node = match Self::get_index_node(env, scope, id) {
            Some(node) => node,
            None => return,
        };
        let mut meta = Self::get_index_meta(env, scope);

        match node.prev {
            Some(prev_id) => {
                if let Some(mut prev_node) = Self::get_index_node(env, scope, prev_id) {
                    prev_node.next = node.next;
                    Self::save_index_node(env, scope, prev_id, &prev_node);
                }
            }
            None => meta.head = node.next,
        }
        match node.next {
            Some(next_id) => {
                if let Some(mut next_node) = Self::get_index_node(env, scope, next_id) {
                    next_node.prev = node.prev;
                    Self::save_index_node(env, scope, next_id, &next_node);
                }
            }
            None => meta.tail = node.prev,
        }
        meta.count = meta.count.saturating_sub(1);
        env.storage()
            .persistent()
            .remove(&DataKey::IndexNode(scope.clone(), id));
        Self::save_index_meta(env, scope, &meta);
    }

    /// Bounded, cursor-paginated walk of `scope`, oldest-first. `cursor` must
    /// be `None` (start from the beginning) or an id previously returned by
    /// this function; any other value (fabricated, or an id since removed
    /// from this index) is rejected with `Error::InvalidCursor` rather than
    /// silently resyncing, so pagination never omits or duplicates entries
    /// across calls. Every call performs at most `2 * limit + 1` storage
    /// reads, independent of the index's total size.
    pub fn index_page(
        env: &Env,
        scope: &IndexScope,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<(Vec<u64>, Option<u64>), Error> {
        let limit = clamp_limit(limit);
        let mut walk = match cursor {
            None => Self::get_index_meta(env, scope).head,
            Some(after) => {
                let node = Self::get_index_node(env, scope, after).ok_or(Error::InvalidCursor)?;
                node.next
            }
        };

        let mut ids = Vec::new(env);
        let mut last_id: Option<u64> = None;
        while let Some(id) = walk {
            if ids.len() >= limit {
                break;
            }
            ids.push_back(id);
            last_id = Some(id);
            walk = Self::get_index_node(env, scope, id).and_then(|node| node.next);
        }

        let next_cursor = if walk.is_some() { last_id } else { None };
        Ok((ids, next_cursor))
    }

    /// Resolves a bounded page of ids from `scope` into full `Prompt`
    /// records, filtering out listings that have since expired (matching
    /// the previous `get_all_prompts` behavior). Cost is bounded by `limit`,
    /// not by market size.
    fn materialize_page(
        env: &Env,
        scope: &IndexScope,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        let (ids, next_cursor) = Self::index_page(env, scope, cursor, limit)?;
        let now = env.ledger().timestamp();
        let mut prompts = Vec::new(env);
        for index in 0..ids.len() {
            let id = ids.get(index).unwrap();
            if let Some(prompt) = Self::get_prompt(env, id) {
                if prompt.expires_at == 0 || prompt.expires_at >= now {
                    prompts.push_back(prompt);
                }
            }
        }
        Ok(PromptPage {
            prompts,
            next_cursor,
        })
    }

    pub fn get_active_prompts_page(
        env: &Env,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Self::materialize_page(env, &IndexScope::Active, cursor, limit)
    }

    pub fn get_prompts_by_creator_page(
        env: &Env,
        creator: &Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Self::materialize_page(env, &IndexScope::Creator(creator.clone()), cursor, limit)
    }

    pub fn get_prompts_by_buyer_page(
        env: &Env,
        buyer: &Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Self::materialize_page(env, &IndexScope::Buyer(buyer.clone()), cursor, limit)
    }

    pub fn get_prompts_by_category_page(
        env: &Env,
        category: &String,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Self::materialize_page(env, &IndexScope::Category(category.clone()), cursor, limit)
    }

    pub fn get_prompts_by_tag_page(
        env: &Env,
        tag: &String,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Self::materialize_page(env, &IndexScope::Tag(tag.clone()), cursor, limit)
    }

    /// Inserts a newly created (or migrated) prompt into every discovery
    /// index derived from its canonical fields: Active (if `active`),
    /// Creator, Category, and one entry per tag. Idempotent, so it also
    /// backs `migrate_prompt_indexes_page`.
    pub fn sync_discovery_indexes(env: &Env, prompt: &Prompt) {
        if prompt.active {
            Self::index_insert(env, &IndexScope::Active, prompt.id);
        }
        Self::index_insert(env, &IndexScope::Creator(prompt.creator.clone()), prompt.id);
        Self::index_insert(
            env,
            &IndexScope::Category(prompt.category.clone()),
            prompt.id,
        );
        for index in 0..prompt.tags.len() {
            let tag = prompt.tags.get(index).unwrap();
            Self::index_insert(env, &IndexScope::Tag(tag), prompt.id);
        }
    }

    /// Moves a listing in or out of the Active index when its sale status
    /// changes.
    pub fn set_active_index(env: &Env, prompt_id: u64, active: bool) {
        if active {
            Self::index_insert(env, &IndexScope::Active, prompt_id);
        } else {
            Self::index_remove(env, &IndexScope::Active, prompt_id);
        }
    }

    /// Moves a listing between Category buckets when `revise_listing`
    /// changes its category, preventing stale entries under the old value.
    pub fn reindex_category(
        env: &Env,
        prompt_id: u64,
        old_category: &String,
        new_category: &String,
    ) {
        if old_category != new_category {
            Self::index_remove(env, &IndexScope::Category(old_category.clone()), prompt_id);
            Self::index_insert(env, &IndexScope::Category(new_category.clone()), prompt_id);
        }
    }

    pub fn index_buyer_add(env: &Env, buyer: &Address, prompt_id: u64) {
        Self::index_insert(env, &IndexScope::Buyer(buyer.clone()), prompt_id);
    }

    pub fn index_buyer_remove(env: &Env, buyer: &Address, prompt_id: u64) {
        Self::index_remove(env, &IndexScope::Buyer(buyer.clone()), prompt_id);
    }

    /// Extends TTL for a bounded batch of prompt ids `[cursor, cursor +
    /// limit)`, along with their listing-revision snapshots and discovery-
    /// index nodes. Returns the cursor to resume from, or `None` once every
    /// prompt has been covered. Replaces the old unbounded `extend_all_ttl`.
    pub fn extend_ttl_page(env: &Env, cursor: Option<u64>, limit: u32) -> Option<u64> {
        let limit = clamp_limit(limit);
        let total = InstanceStorage::get_prompt_counter(env);
        let mut id = cursor.unwrap_or(0);
        let mut processed = 0u32;

        while id < total && processed < limit {
            let key = DataKey::Prompt(id);
            if env.storage().persistent().has(&key) {
                Self::extend_key_ttl(env, &key);
                if let Some(prompt) = Self::get_prompt(env, id) {
                    for revision in 0..=prompt.revision {
                        let rev_key = DataKey::ListingRevision(id, revision);
                        if env.storage().persistent().has(&rev_key) {
                            Self::extend_key_ttl(env, &rev_key);
                        }
                    }
                    if prompt.active {
                        Self::extend_key_ttl(env, &DataKey::IndexNode(IndexScope::Active, id));
                    }
                    Self::extend_key_ttl(
                        env,
                        &DataKey::IndexNode(IndexScope::Creator(prompt.creator.clone()), id),
                    );
                    Self::extend_key_ttl(
                        env,
                        &DataKey::IndexNode(IndexScope::Category(prompt.category.clone()), id),
                    );
                    for tag_index in 0..prompt.tags.len() {
                        let tag = prompt.tags.get(tag_index).unwrap();
                        Self::extend_key_ttl(env, &DataKey::IndexNode(IndexScope::Tag(tag), id));
                    }
                }
            }
            id += 1;
            processed += 1;
        }

        if id >= total {
            None
        } else {
            Some(id)
        }
    }

    /// Resumable, idempotent reindex of prompt ids `[cursor, cursor +
    /// limit)` into the Active/Creator/Category/Tag indexes, derived purely
    /// from canonical `Prompt` fields. Returns the cursor to resume from, or
    /// `None` once complete.
    pub fn migrate_prompt_indexes_page(env: &Env, cursor: Option<u64>, limit: u32) -> Option<u64> {
        let limit = clamp_limit(limit);
        let total = InstanceStorage::get_prompt_counter(env);
        let mut id = cursor.unwrap_or(0);
        let mut processed = 0u32;

        while id < total && processed < limit {
            if let Some(prompt) = Self::get_prompt(env, id) {
                Self::sync_discovery_indexes(env, &prompt);
            }
            id += 1;
            processed += 1;
        }

        if id >= total {
            None
        } else {
            Some(id)
        }
    }

    /// Resumable, idempotent migration of one buyer's legacy
    /// `DataKey::BuyerPrompts` list (the old unbounded Vec index) into the
    /// new Buyer discovery index, processing up to `limit` entries starting
    /// at `cursor`. Deletes the legacy key once fully drained.
    pub fn migrate_buyer_index_page(
        env: &Env,
        buyer: &Address,
        cursor: Option<u32>,
        limit: u32,
    ) -> Option<u32> {
        let limit = clamp_limit(limit);
        let key = DataKey::BuyerPrompts(buyer.clone());
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env));
        let total = ids.len();
        let mut index = cursor.unwrap_or(0);
        let mut processed = 0u32;

        while index < total && processed < limit {
            let prompt_id = ids.get(index).unwrap();
            Self::index_buyer_add(env, buyer, prompt_id);
            index += 1;
            processed += 1;
        }

        if index >= total {
            if env.storage().persistent().has(&key) {
                env.storage().persistent().remove(&key);
            }
            None
        } else {
            Some(index)
        }
    }

    pub fn get_purchase(env: &Env, prompt_id: u64, buyer: &Address) -> Option<Purchase> {
        let key = DataKey::Purchase(prompt_id, buyer.clone());
        let purchase = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        purchase
    }

    pub fn has_active_purchase(env: &Env, prompt_id: u64, buyer: &Address, now: u64) -> bool {
        Self::get_purchase(env, prompt_id, buyer)
            .map(|purchase| purchase.expires_at >= now)
            .unwrap_or(false)
    }

    pub fn save_purchase(env: &Env, purchase: &Purchase) {
        let key = DataKey::Purchase(purchase.prompt_id, purchase.owner.clone());
        env.storage().persistent().set(&key, purchase);
        Self::extend_key_ttl(env, &key);
    }

    pub fn remove_purchase(env: &Env, prompt_id: u64, owner: &Address) {
        let key = DataKey::Purchase(prompt_id, owner.clone());
        env.storage().persistent().remove(&key);
    }

    pub fn require_purchase(env: &Env, prompt_id: u64, owner: &Address) -> Result<Purchase, Error> {
        Self::get_purchase(env, prompt_id, owner).ok_or(Error::LicenseNotFound)
    }

    pub fn grant_purchase(
        env: &Env,
        prompt: &Prompt,
        buyer: &Address,
        paid_price: i128,
        expires_at: u64,
    ) {
        let key = DataKey::Purchase(prompt.id, buyer.clone());
        let purchase = Purchase {
            prompt_id: prompt.id,
            original_creator: prompt.creator.clone(),
            owner: buyer.clone(),
            original_price: paid_price,
            last_transfer_price: 0,
            transfer_count: 0,
            last_transferred_at: 0,
            expires_at,
        };
        env.storage().persistent().set(&key, &purchase);
        Self::extend_key_ttl(env, &key);
        Self::index_buyer_add(env, buyer, prompt.id);
    }

    pub fn save_dispute(env: &Env, dispute: &PurchaseDispute) {
        let key = DataKey::PurchaseDispute(dispute.prompt_id, dispute.buyer.clone());
        env.storage().persistent().set(&key, dispute);
        Self::extend_key_ttl(env, &key);
    }

    pub fn get_dispute(env: &Env, prompt_id: u64, buyer: &Address) -> Option<PurchaseDispute> {
        let key = DataKey::PurchaseDispute(prompt_id, buyer.clone());
        let dispute = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        dispute
    }

    pub fn require_dispute(
        env: &Env,
        prompt_id: u64,
        buyer: &Address,
    ) -> Result<PurchaseDispute, Error> {
        Self::get_dispute(env, prompt_id, buyer).ok_or(Error::DisputeNotFound)
    }

    pub fn save_escrow(env: &Env, escrow: &Escrow) {
        let key = DataKey::Escrow(escrow.prompt_id, escrow.buyer.clone());
        env.storage().persistent().set(&key, escrow);
        Self::extend_key_ttl(env, &key);
    }

    pub fn get_escrow(env: &Env, prompt_id: u64, buyer: &Address) -> Option<Escrow> {
        let key = DataKey::Escrow(prompt_id, buyer.clone());
        let escrow = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        escrow
    }

    pub fn require_escrow(env: &Env, prompt_id: u64, buyer: &Address) -> Result<Escrow, Error> {
        Self::get_escrow(env, prompt_id, buyer).ok_or(Error::EscrowNotFound)
    }

    pub fn get_reviewers(env: &Env) -> Vec<Address> {
        let key = DataKey::Reviewers;
        let reviewers = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        reviewers.unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_reviewers(env: &Env, reviewers: &Vec<Address>) {
        let key = DataKey::Reviewers;
        env.storage().persistent().set(&key, reviewers);
        Self::extend_key_ttl(env, &key);
    }

    pub fn get_upgrade_signers(env: &Env) -> Vec<Address> {
        let key = DataKey::UpgradeSigners;
        let signers = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        signers.unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_upgrade_signers(env: &Env, signers: &Vec<Address>) {
        let key = DataKey::UpgradeSigners;
        env.storage().persistent().set(&key, signers);
        Self::extend_key_ttl(env, &key);
    }

    pub fn save_upgrade_proposal(env: &Env, proposal: &UpgradeProposal) {
        let key = DataKey::UpgradeProposal(proposal.id);
        env.storage().persistent().set(&key, proposal);
        Self::extend_key_ttl(env, &key);
    }

    pub fn get_upgrade_proposal(env: &Env, proposal_id: u32) -> Option<UpgradeProposal> {
        let key = DataKey::UpgradeProposal(proposal_id);
        let proposal = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        proposal
    }

    pub fn require_upgrade_proposal(env: &Env, proposal_id: u32) -> Result<UpgradeProposal, Error> {
        Self::get_upgrade_proposal(env, proposal_id).ok_or(Error::UpgradeProposalUnavailable)
    }

    pub fn add_voucher(env: &Env, prompt_id: u64, hashed_code: &BytesN<32>, discount_bps: u32) {
        let key = DataKey::VoucherKey(prompt_id, hashed_code.clone());
        env.storage().persistent().set(&key, &discount_bps);
        Self::extend_key_ttl(env, &key);
    }

    pub fn remove_voucher(env: &Env, prompt_id: u64, hashed_code: &BytesN<32>) {
        let key = DataKey::VoucherKey(prompt_id, hashed_code.clone());
        env.storage().persistent().remove(&key);
    }

    pub fn get_voucher(env: &Env, prompt_id: u64, hashed_code: &BytesN<32>) -> Option<u32> {
        let key = DataKey::VoucherKey(prompt_id, hashed_code.clone());
        let discount = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        discount
    }

    pub fn save_listing_revision(env: &Env, record: &ListingRevisionRecord) {
        let key = DataKey::ListingRevision(record.prompt_id, record.revision);
        env.storage().persistent().set(&key, record);
        Self::extend_key_ttl(env, &key);
    }

    pub fn get_listing_revision(
        env: &Env,
        prompt_id: u64,
        revision: u32,
    ) -> Option<ListingRevisionRecord> {
        let key = DataKey::ListingRevision(prompt_id, revision);
        let record = env.storage().persistent().get(&key);
        if env.storage().persistent().has(&key) {
            Self::extend_key_ttl(env, &key);
        }
        record
    }
}
