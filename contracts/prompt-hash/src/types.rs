use soroban_sdk::{contracterror, contracttype, Address, Bytes, BytesN, Env, String, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Unauthorized = 1,
    PromptNotFound = 2,
    CreatorCannotBuy = 3,
    PromptInactive = 4,
    AlreadyPurchased = 5,
    InvalidPrice = 6,
    InvalidFeePercentage = 7,
    InvalidTitleLength = 8,
    InvalidCategoryLength = 9,
    InvalidPreviewLength = 10,
    InvalidEncryptedPromptLength = 11,
    InvalidWrappedKeyLength = 12,
    InvalidImageUrlLength = 13,
    InvalidIvLength = 14,
    FeeWalletNotSet = 15,
    XlmAddressNotSet = 16,
    ArithmeticOverflow = 17,
    ReentrancyGuard = 18,
    ContractIsPaused = 19,
    ReferrerCannotBeBuyerOrCreator = 20,
    InvalidPaymentAmount = 21,
    InvalidVoucher = 22,
    InvalidReferralPercentage = 23,
    InvalidDiscountPercentage = 24,
    MaxSupplyReached = 25,
    InvalidAsset = 26,
    InvalidSplits = 27,
    ListingExpired = 28,
    LicenseNotFound = 29,
    InvalidLicenseTransfer = 30,
    RevisionFieldsUnchanged = 31,
    DuplicateSplitRecipient = 32,
    TooManySplits = 33,
    FeeExceedsMaximum = 34,
    DisputeAlreadyOpen = 35,
    DisputeNotFound = 36,
    DisputeResolved = 37,
    ConflictOfInterest = 38,
    InvalidEscrowState = 39,
    EscrowNotFound = 40,
    NotAReviewer = 41,
    DuplicateVote = 42,
    DisputeNotExpired = 43,
    DisputeExpired = 44,
    AppealWindowExpired = 45,
    ReviewerThresholdNotMet = 46,
    /// Pagination cursor does not correspond to a live entry in the requested
    /// index (fabricated, already-consumed, or removed since it was issued).
    InvalidCursor = 47,
    /// Caller-supplied id batch exceeds `MAX_PAGE_SIZE` (#83).
    TooManyIds = 48,
}

/// Instance storage keys — contract-level configuration stored in
/// `env.storage().instance()`. These have no TTL and survive upgrades.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstanceDataKey {
    PromptCounter,
    FeePercentage,
    FeeWallet,
    XlmAddress,
    Reentrancy,
    ReferralPercentage,
    IsPaused,
    ReviewerThreshold,
    /// Currently active fee-policy version (#82). Defaults to `0` — the
    /// pre-governance baseline read from `FeePercentage`/`ReferralPercentage`.
    FeePolicyVersion,
    /// A proposed fee-policy change awaiting its timelock (#82).
    PendingFeePolicy,
}

/// Persistent storage keys — per-prompt and per-user data stored in
/// `env.storage().persistent()`. Each entry is subject to TTL management.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Prompt(u64),
    /// Legacy unbounded buyer index (#83). No longer written; retained only
    /// as the read source for `migrate_buyer_index_page`, which drains and
    /// then deletes each buyer's entry.
    BuyerPrompts(Address),
    Purchase(u64, Address),
    VoucherKey(u64, BytesN<32>),
    ListingRevision(u64, u32),
    PurchaseDispute(u64, Address),
    Escrow(u64, Address),
    Reviewers,
    /// Head/tail/count for a discovery-index doubly linked list (#83).
    IndexMeta(IndexScope),
    /// One node of a discovery-index doubly linked list, keyed by prompt id (#83).
    IndexNode(IndexScope, u64),
}

/// Discovery-index dimensions maintained as bounded, cursor-paginated linked
/// lists (#83). These are rebuildable from canonical `Prompt` state — they
/// never gate authorization, which always checks `Prompt`/`Purchase` fields
/// directly.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexScope {
    Active,
    Creator(Address),
    Buyer(Address),
    Category(String),
    Tag(String),
}

/// One entry of a discovery-index doubly linked list. Insertion appends at
/// the tail so pagination yields oldest-first, matching the previous
/// Vec-based indexes' order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexNode {
    pub prev: Option<u64>,
    pub next: Option<u64>,
}

/// List-level bookkeeping for a discovery index.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexMeta {
    pub head: Option<u64>,
    pub tail: Option<u64>,
    pub count: u64,
}

/// A bounded page of prompts from a discovery index, plus the cursor to
/// fetch the next page. `next_cursor` is `None` once the index is exhausted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptPage {
    pub prompts: Vec<Prompt>,
    pub next_cursor: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open,
    Refunded,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeReason {
    InvalidEncryptedPayload,
    MissingMetadata,
    FailedIntegrityVerification,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurchaseDispute {
    pub prompt_id: u64,
    pub buyer: Address,
    pub reason: DisputeReason,
    pub opened_at: u64,
    pub resolved_at: u64,
    pub status: DisputeStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Purchase {
    pub prompt_id: u64,
    pub original_creator: Address,
    pub owner: Address,
    pub original_price: i128,
    pub last_transfer_price: i128,
    pub transfer_count: u32,
    pub last_transferred_at: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EscrowState {
    Pending = 0,
    Fulfilled = 1,
    Disputed = 2,
    Released = 3,
    Refunded = 4,
    Rejected = 5,
    Expired = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub prompt_id: u64,
    pub buyer: Address,
    pub creator: Address,
    pub asset: Address,
    pub price: i128,
    pub fee_percentage: u32,
    pub fee_wallet: Address,
    pub referral_percentage: u32,
    pub referrer: Option<Address>,
    pub splits: Vec<Split>,
    pub content_hash: BytesN<32>,
    pub created_at: u64,
    pub dispute_window_expiry: u64,
    pub state: EscrowState,
    pub dispute_opened_at: u64,
    pub resolution_deadline: u64,
    pub evidence_hashes: Vec<BytesN<32>>,
    pub voters: Vec<Address>,
    pub votes_for_refund: u32,
    pub votes_for_reject: u32,
    pub is_appealed: bool,
    pub dispute_resolved_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PricingConfig {
    pub price: i128,
    pub asset: Address,
}

/// A versioned snapshot of the platform's fee/referral rates (#82).
/// Listings pin to a specific version at creation (and re-pin on
/// `update_splits`) so that a later admin fee change can never retroactively
/// alter — or brick — an already-listed prompt's economics.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicy {
    pub version: u32,
    pub fee_bps: u32,
    pub referral_bps: u32,
    /// Ledger timestamp the policy became active (0 for the synthesized
    /// pre-governance baseline, version 0).
    pub effective_at: u64,
}

/// Result of `preview_purchase` — computed with the exact same allocation
/// function `buy_prompt` uses, against the listing's pinned fee policy, so
/// preview and execution can never diverge (#82).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurchasePreview {
    pub policy_version: u32,
    pub fee_amount: i128,
    pub referral_amount: i128,
    /// Parallel to the listing's `splits`, in the same order.
    pub split_amounts: Vec<i128>,
    pub creator_amount: i128,
}

/// A single revenue-split entry stored inside a prompt.
/// `bps` is the share of the full payment (in basis points) paid to `recipient`
/// before the creator receives the remainder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Split {
    pub recipient: Address,
    pub bps: u32,
}

/// Full listing configuration passed to create_prompt.
/// Bundles pricing, optional expiry, and optional revenue splits into a single
/// parameter so the function stays within Soroban's 10-parameter limit.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingConfig {
    pub price: i128,
    pub asset: Address,
    /// Unix timestamp after which the listing can no longer be purchased.
    /// `0` means the listing never expires.
    pub expires_at: u64,
    /// Optional co-creator revenue splits (empty Vec = no splits).
    pub splits: Vec<Split>,
    /// Search tags used for marketplace discovery. Tags should be lowercase kebab-case.
    pub tags: Vec<String>,
    /// Maximum number of licenses that can be sold (0 = unlimited).
    pub max_supply: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Prompt {
    pub id: u64,
    pub creator: Address,
    pub image_url: String,
    pub title: String,
    pub category: String,
    pub preview_text: String,
    pub encrypted_prompt: String,
    pub encryption_iv: String,
    pub wrapped_key: String,
    pub content_hash: BytesN<32>,
    pub price_stroops: i128,
    pub asset: Address,
    pub active: bool,
    pub sales_count: u64,
    pub max_supply: u64,
    /// Unix timestamp after which the listing can no longer be purchased.
    /// `0` means the listing never expires.
    pub expires_at: u64,
    /// Optional co-creator revenue splits applied against the full payment.
    pub splits: Vec<Split>,
    /// Monotonically increasing revision counter. Starts at 0 on creation and
    /// increments by 1 on each successful `revise_listing` call (#226).
    pub revision: u32,
    /// Search tags used for marketplace discovery. Tags should be lowercase kebab-case.
    pub tags: Vec<String>,
}

/// Snapshot of the mutable listing fields captured before a revision (#226).
/// Stored under `DataKey::ListingRevision(prompt_id, old_revision)` so
/// buyers can verify what metadata was in effect when they purchased.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListingRevisionRecord {
    pub prompt_id: u64,
    pub revision: u32,
    pub title: String,
    pub category: String,
    pub preview_text: String,
    pub image_url: String,
    pub price_stroops: i128,
    pub revised_at: u64,
}

pub trait PromptHashTrait {
    fn __constructor(
        env: Env,
        admin: Address,
        fee_wallet: Address,
        xlm_sac: Address,
    ) -> Result<(), Error>;

    #[allow(clippy::too_many_arguments)]
    fn create_prompt(
        env: Env,
        creator: Address,
        image_url: String,
        title: String,
        category: String,
        preview_text: String,
        encrypted_prompt: String,
        encryption_iv: String,
        wrapped_key: String,
        content_hash: BytesN<32>,
        listing: ListingConfig,
    ) -> Result<u64, Error>;

    fn set_prompt_sale_status(
        env: Env,
        creator: Address,
        prompt_id: u64,
        active: bool,
    ) -> Result<(), Error>;

    fn set_prompt_max_supply(
        env: Env,
        creator: Address,
        prompt_id: u64,
        max_supply: u64,
    ) -> Result<(), Error>;

    fn update_prompt_price(
        env: Env,
        creator: Address,
        prompt_id: u64,
        price_stroops: i128,
    ) -> Result<(), Error>;

    fn buy_prompt(
        env: Env,
        buyer: Address,
        prompt_id: u64,
        referrer: Option<Address>,
        payment_amount_stroops: i128,
        voucher: Option<Bytes>,
    ) -> Result<(), Error>;

    fn lease_prompt(
        env: Env,
        buyer: Address,
        prompt_id: u64,
        lease_duration_secs: u64,
    ) -> Result<(), Error>;

    /// Push the expiry date of a listing forward. `new_expires_at` must be
    /// strictly greater than the current ledger timestamp.
    fn extend_listing(
        env: Env,
        creator: Address,
        prompt_id: u64,
        new_expires_at: u64,
    ) -> Result<(), Error>;

    /// Purchase multiple prompts atomically in a single transaction.
    /// `prompt_ids` and `payment_amounts` must have equal length.
    /// An optional `referrer` applies to every prompt in the batch.
    /// If any individual purchase fails the entire transaction reverts.
    fn buy_prompts_bulk(
        env: Env,
        buyer: Address,
        prompt_ids: Vec<u64>,
        payment_amounts: Vec<i128>,
        referrer: Option<Address>,
    ) -> Result<(), Error>;

    fn transfer_license(
        env: Env,
        seller: Address,
        prompt_id: u64,
        new_buyer: Address,
        resale_price: i128,
    ) -> Result<(), Error>;

    /// Update the mutable metadata fields of an existing listing.
    ///
    /// The old title, category, preview_text, image_url, and price_stroops are
    /// preserved as a `ListingRevisionRecord` keyed on the pre-change revision
    /// number. Existing `Purchase` records remain valid — revision does not
    /// affect access rights (#226).
    #[allow(clippy::too_many_arguments)]
    fn revise_listing(
        env: Env,
        creator: Address,
        prompt_id: u64,
        title: String,
        category: String,
        preview_text: String,
        image_url: String,
        price_stroops: i128,
    ) -> Result<u32, Error>;

    fn get_listing_revision(
        env: Env,
        prompt_id: u64,
        revision: u32,
    ) -> Result<ListingRevisionRecord, Error>;

    fn update_splits(
        env: Env,
        creator: Address,
        prompt_id: u64,
        new_splits: Vec<Split>,
    ) -> Result<(), Error>;

    fn has_access(env: Env, user: Address, prompt_id: u64) -> Result<bool, Error>;
    fn get_prompt(env: Env, prompt_id: u64) -> Result<Prompt, Error>;

    /// Cursor-paginated listing of currently-active prompts. `cursor` is the
    /// last id returned by a previous call (or `None` to start from the
    /// oldest listing); `limit` is clamped to `MAX_PAGE_SIZE`. Every call
    /// does bounded work independent of total market size (#83).
    fn get_active_prompts_page(
        env: Env,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error>;
    fn get_prompts_by_category_page(
        env: Env,
        category: String,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error>;
    fn get_prompts_by_tag_page(
        env: Env,
        tag: String,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error>;
    fn open_dispute(
        env: Env,
        buyer: Address,
        prompt_id: u64,
        reason: DisputeReason,
    ) -> Result<(), Error>;
    fn resolve_dispute(
        env: Env,
        admin: Address,
        prompt_id: u64,
        buyer: Address,
        refund: bool,
    ) -> Result<(), Error>;
    fn get_dispute(env: Env, prompt_id: u64, buyer: Address) -> Result<PurchaseDispute, Error>;
    fn get_prompts_by_creator_page(
        env: Env,
        creator: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error>;
    fn get_prompts_by_buyer_page(
        env: Env,
        buyer: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error>;
    fn set_fee_percentage(env: Env, new_fee_percentage: u32) -> Result<(), Error>;
    fn set_fee_wallet(env: Env, new_fee_wallet: Address) -> Result<(), Error>;
    fn get_fee_percentage(env: Env) -> u32;
    fn get_fee_wallet(env: Env) -> Option<Address>;
    fn set_referral_percentage(env: Env, new_referral_percentage: u32) -> Result<(), Error>;
    fn get_referral_percentage(env: Env) -> u32;
    // New platform fee governance API
    fn update_platform_fee(env: Env, admin: Address, new_fee: u32) -> Result<(), Error>;
    fn get_platform_fee(env: Env) -> u32;

    /// Activate a previously proposed fee-policy change once its timelock has
    /// elapsed (#82). Permissionless: anyone may call it, but it only takes
    /// effect once `env.ledger().timestamp() >= pending.effective_at`.
    /// Returns the newly activated policy version.
    fn activate_pending_fee_policy(env: Env) -> Result<u32, Error>;
    /// The fee-policy change currently awaiting its timelock, if any.
    fn get_pending_fee_policy(env: Env) -> Option<FeePolicy>;
    /// Look up a historical (or the synthesized baseline) fee policy by
    /// version number.
    fn get_fee_policy(env: Env, version: u32) -> FeePolicy;
    /// The fee-policy version currently active for new listings.
    fn get_current_fee_policy_version(env: Env) -> u32;
    /// The fee-policy version a specific listing is pinned to.
    fn get_prompt_fee_policy_version(env: Env, prompt_id: u64) -> Result<u32, Error>;

    /// Compute the exact fee/referral/split/creator breakdown for a
    /// hypothetical purchase, using the listing's pinned fee policy — the
    /// same allocation function `buy_prompt` executes, so preview and
    /// execution can never diverge (#82).
    fn preview_purchase(
        env: Env,
        prompt_id: u64,
        payment_amount_stroops: i128,
        has_referrer: bool,
    ) -> Result<PurchasePreview, Error>;
    fn set_pause_status(env: Env, paused: bool) -> Result<(), Error>;
    fn is_paused(env: Env) -> bool;
    fn add_voucher(
        env: Env,
        creator: Address,
        prompt_id: u64,
        hashed_code: BytesN<32>,
        discount_bps: u32,
    ) -> Result<(), Error>;
    fn remove_voucher(
        env: Env,
        creator: Address,
        prompt_id: u64,
        hashed_code: BytesN<32>,
    ) -> Result<(), Error>;
    fn get_xlm_sac(env: Env) -> Option<Address>;

    /// Fetch multiple prompts by ID in a single call. Returns only prompts
    /// that exist — missing IDs are silently skipped.
    fn get_prompts_by_ids(env: Env, prompt_ids: Vec<u64>) -> Result<Vec<Prompt>, Error>;

    fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error>;
    fn extend_ttl(env: Env, key: DataKey) -> Result<(), Error>;
    /// Extend TTL for a bounded batch of prompts (and their listing
    /// revisions and discovery-index nodes), starting at `cursor` (or the
    /// beginning if `None`). Returns the cursor to resume from, or `None`
    /// once every prompt has been covered. Replaces the old unbounded
    /// `extend_all_ttl`, which iterated the entire market in one call and
    /// risked exceeding the CPU budget on `upgrade` as the market grew (#83).
    fn extend_ttl_page(env: Env, cursor: Option<u64>, limit: u32) -> Result<Option<u64>, Error>;

    /// Resumable, idempotent reindex of a bounded batch of prompts
    /// (starting at `cursor`, or the beginning if `None`) into the Active,
    /// Creator, Category, and Tag discovery indexes from their canonical
    /// `Prompt` fields. Safe to call repeatedly, including after an
    /// interruption — already-indexed entries are no-ops. Returns the
    /// cursor to resume from, or `None` once complete (#83).
    fn migrate_prompt_indexes_page(
        env: Env,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<Option<u64>, Error>;

    /// Resumable, idempotent migration of one buyer's legacy `BuyerPrompts`
    /// list into the new Buyer discovery index, processing up to `limit`
    /// entries starting at `cursor` (or the beginning if `None`). Deletes
    /// the legacy entry once fully drained. Returns the cursor to resume
    /// from, or `None` once complete (#83).
    fn migrate_buyer_index_page(
        env: Env,
        buyer: Address,
        cursor: Option<u32>,
        limit: u32,
    ) -> Result<Option<u32>, Error>;

    // Dispute and Escrow resolution methods
    fn submit_evidence(
        env: Env,
        party: Address,
        prompt_id: u64,
        buyer: Address,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error>;

    fn vote_on_dispute(
        env: Env,
        reviewer: Address,
        prompt_id: u64,
        buyer: Address,
        refund: bool,
    ) -> Result<(), Error>;

    fn appeal_resolution(
        env: Env,
        party: Address,
        prompt_id: u64,
        buyer: Address,
    ) -> Result<(), Error>;

    fn resolve_appealed_dispute(
        env: Env,
        admin: Address,
        prompt_id: u64,
        buyer: Address,
        refund: bool,
    ) -> Result<(), Error>;

    fn release_funds_early(env: Env, buyer: Address, prompt_id: u64) -> Result<(), Error>;

    fn resolve_escrow_timeout(env: Env, prompt_id: u64, buyer: Address) -> Result<(), Error>;

    fn resolve_dispute_timeout(env: Env, prompt_id: u64, buyer: Address) -> Result<(), Error>;

    fn add_reviewer(env: Env, admin: Address, reviewer: Address) -> Result<(), Error>;

    fn remove_reviewer(env: Env, admin: Address, reviewer: Address) -> Result<(), Error>;

    fn set_reviewer_threshold(env: Env, admin: Address, threshold: u32) -> Result<(), Error>;

    fn get_reviewer_threshold(env: Env) -> u32;

    fn get_reviewers(env: Env) -> Vec<Address>;

    fn get_escrow(env: Env, prompt_id: u64, buyer: Address) -> Result<Escrow, Error>;
}
