use super::events::Events;
use super::storage::{InstanceStorage, Storage, MAX_PAGE_SIZE};
use super::types::{
    DataKey, DisputeReason, DisputeStatus, Error, Escrow, EscrowState, FeePolicy,
    FEE_POLICY_TIMELOCK_SECS, ListingConfig, ListingRevisionRecord, Prompt, PromptHashTrait,
    PromptPage, PurchaseDispute, PurchasePreview, Split, UpgradeProposal,
};
use soroban_sdk::{contract, contractimpl, token, Address, Bytes, BytesN, Env, String, Vec};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::{default_impl, only_owner};

const DEFAULT_FEE_BPS: u32 = 500;
const ROYALTY_BPS: u32 = 500;
const MAX_BPS: u32 = 10_000;
const MAX_PLATFORM_FEE: u32 = 1_000;
const MAX_TITLE_LEN: u32 = 120;
const MAX_CATEGORY_LEN: u32 = 40;
const MAX_PREVIEW_LEN: u32 = 280;
const MAX_ENCRYPTED_PROMPT_LEN: u32 = 4096;
const MAX_WRAPPED_KEY_LEN: u32 = 256;
const MAX_IMAGE_URL_LEN: u32 = 512;
const MAX_IV_LEN: u32 = 64;
const LEASE_PRICE_BPS: u32 = 4_000;
const MAX_ACCESS_EXPIRY: u64 = u64::MAX;
const MAX_SPLITS: u32 = 10;
const MAX_TAGS: u32 = 8;
const MAX_TAG_LEN: u32 = 32;
/// Minimum public delay between an upgrade proposal's creation and the
/// earliest it may execute (#84). Proposers may set a longer delay, never a
/// shorter one.
const MIN_UPGRADE_TIMELOCK_SECS: u64 = 2 * 24 * 60 * 60;
const MAX_UPGRADE_SIGNERS: u32 = 20;

#[contract]
pub struct PromptHashContract;

#[contractimpl]
impl PromptHashTrait for PromptHashContract {
    fn __constructor(
        env: Env,
        admin: Address,
        fee_wallet: Address,
        xlm_sac: Address,
    ) -> Result<(), Error> {
        ownable::set_owner(&env, &admin);
        InstanceStorage::set_fee_wallet(&env, &fee_wallet);
        InstanceStorage::set_fee_percentage(&env, &DEFAULT_FEE_BPS);
        InstanceStorage::set_xlm_address(&env, &xlm_sac);
        InstanceStorage::set_pause_status(&env, false);
        env.storage().instance().extend_ttl(
            crate::ttl_policy::PERSISTENT_LIFETIME_THRESHOLD,
            crate::ttl_policy::PERSISTENT_BUMP_AMOUNT,
        );
        Ok(())
    }

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
    ) -> Result<u64, Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        validate_prompt_fields(
            &image_url,
            &title,
            &category,
            &preview_text,
            &encrypted_prompt,
            &encryption_iv,
            &wrapped_key,
            listing.price,
        )?;

        token::Client::new(&env, &listing.asset).decimals();

        if listing.expires_at != 0 {
            ensure(
                listing.expires_at > env.ledger().timestamp(),
                Error::InvalidPrice,
            )?;
        }

        validate_splits(&env, &listing.splits)?;
        validate_no_duplicate_recipients(&listing.splits)?;
        ensure(listing.splits.len() <= MAX_SPLITS, Error::TooManySplits)?;
        validate_tags(&listing.tags)?;

        let prompt_id = InstanceStorage::get_prompt_counter(&env);
        InstanceStorage::save_prompt_counter(&env, prompt_id + 1);
        let prompt = Prompt {
            id: prompt_id,
            creator: creator.clone(),
            image_url,
            title,
            category,
            preview_text,
            encrypted_prompt,
            encryption_iv,
            wrapped_key,
            content_hash,
            price_stroops: listing.price,
            asset: listing.asset.clone(),
            active: true,
            sales_count: 0,
            max_supply: listing.max_supply,
            expires_at: listing.expires_at,
            splits: listing.splits,
            revision: 0,
            tags: listing.tags,
        };

        Storage::save_prompt(&env, &prompt)?;
        Storage::set_prompt_fee_policy_version(
            &env,
            prompt_id,
            InstanceStorage::get_current_fee_policy_version(&env),
        );
        Storage::sync_discovery_indexes(&env, &prompt);
        Events::emit_prompt_created(&env, prompt_id, creator, listing.price, listing.asset);
        Ok(prompt_id)
    }

    fn set_prompt_sale_status(
        env: Env,
        creator: Address,
        prompt_id: u64,
        active: bool,
    ) -> Result<(), Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;

        prompt.active = active;
        Storage::update_prompt(&env, &prompt);
        Storage::set_active_index(&env, prompt_id, active);
        Events::emit_prompt_sale_status_updated(&env, prompt_id, active);
        Ok(())
    }

    fn set_prompt_max_supply(
        env: Env,
        creator: Address,
        prompt_id: u64,
        max_supply: u64,
    ) -> Result<(), Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;
        prompt.max_supply = max_supply;
        Storage::update_prompt(&env, &prompt);
        Ok(())
    }

    fn update_prompt_price(
        env: Env,
        creator: Address,
        prompt_id: u64,
        price_stroops: i128,
    ) -> Result<(), Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        ensure(price_stroops > 0, Error::InvalidPrice)?;

        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;
        prompt.price_stroops = price_stroops;

        Storage::update_prompt(&env, &prompt);
        Events::emit_prompt_price_updated(&env, prompt_id, price_stroops);
        Ok(())
    }

    fn buy_prompt(
        env: Env,
        buyer: Address,
        prompt_id: u64,
        referrer: Option<Address>,
        payment_amount_stroops: i128,
        voucher: Option<Bytes>,
    ) -> Result<(), Error> {
        buyer.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        execute_buy(
            &env,
            &buyer,
            prompt_id,
            &referrer,
            payment_amount_stroops,
            voucher,
        )
    }

    fn lease_prompt(
        env: Env,
        buyer: Address,
        prompt_id: u64,
        lease_duration_secs: u64,
    ) -> Result<(), Error> {
        buyer.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        let now = env.ledger().timestamp();

        ensure(prompt.active, Error::PromptInactive)?;
        ensure(prompt.creator != buyer, Error::CreatorCannotBuy)?;
        ensure(lease_duration_secs > 0, Error::InvalidPrice)?;
        ensure(
            !Storage::has_active_purchase(&env, prompt_id, &buyer, now),
            Error::AlreadyPurchased,
        )?;

        if prompt.expires_at != 0 {
            ensure(prompt.expires_at >= now, Error::ListingExpired)?;
        }

        InstanceStorage::set_reentrancy_guard(&env)?;

        let fee_wallet = InstanceStorage::get_fee_wallet(&env).ok_or(Error::FeeWalletNotSet)?;
        let this_contract = env.current_contract_address();
        // Reads the live *current* policy (not this listing's pin) — lease
        // has no splits/referral and can never go negative, so unlike buy
        // there's no bricking risk in tracking the live rate (#82).
        let fee_percentage = current_fee_policy(&env).fee_bps;

        let lease_price = prompt
            .price_stroops
            .checked_mul(LEASE_PRICE_BPS as i128)
            .ok_or(Error::ArithmeticOverflow)?
            / MAX_BPS as i128;
        ensure(lease_price > 0, Error::InvalidPrice)?;

        // Lease has no referral cut or co-creator splits, so it's called
        // with an empty split list — sharing the same arithmetic engine as
        // buy/resale without changing lease's deduction menu (#82).
        let no_splits: Vec<Split> = Vec::new(&env);
        let allocation = allocate_payment(&env, lease_price, fee_percentage, None, &no_splits)?;
        let fee_amount = allocation.fee;
        let seller_amount = allocation.creator_amount;

        let asset_client = token::StellarAssetClient::new(&env, &prompt.asset);
        asset_client.transfer_from(&this_contract, &buyer, &prompt.creator, &seller_amount);
        if fee_amount > 0 {
            asset_client.transfer_from(&this_contract, &buyer, &fee_wallet, &fee_amount);
        }

        prompt.sales_count = prompt
            .sales_count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        let expires_at = now
            .checked_add(lease_duration_secs)
            .ok_or(Error::ArithmeticOverflow)?;
        Storage::update_prompt(&env, &prompt);
        Storage::grant_purchase(&env, &prompt, &buyer, lease_price, expires_at);
        InstanceStorage::clear_reentrancy_guard(&env);
        Events::emit_prompt_purchased(&env, prompt_id, buyer, prompt.creator, lease_price, None);
        Ok(())
    }

    fn extend_listing(
        env: Env,
        creator: Address,
        prompt_id: u64,
        new_expires_at: u64,
    ) -> Result<(), Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;

        let now = env.ledger().timestamp();
        ensure(new_expires_at > now, Error::InvalidPrice)?;

        prompt.expires_at = new_expires_at;
        Storage::update_prompt(&env, &prompt);
        Events::emit_listing_extended(&env, prompt_id, new_expires_at);
        Ok(())
    }

    fn buy_prompts_bulk(
        env: Env,
        buyer: Address,
        prompt_ids: Vec<u64>,
        payment_amounts: Vec<i128>,
        referrer: Option<Address>,
    ) -> Result<(), Error> {
        buyer.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        ensure(
            prompt_ids.len() == payment_amounts.len(),
            Error::InvalidPrice,
        )?;

        for i in 0..prompt_ids.len() {
            let prompt_id = prompt_ids.get(i).unwrap();
            let payment_amount = payment_amounts.get(i).unwrap();
            execute_buy(&env, &buyer, prompt_id, &referrer, payment_amount, None)?;
        }
        Ok(())
    }

    fn transfer_license(
        env: Env,
        seller: Address,
        prompt_id: u64,
        new_buyer: Address,
        resale_price: i128,
    ) -> Result<(), Error> {
        seller.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        ensure(resale_price > 0, Error::InvalidPaymentAmount)?;
        ensure(seller != new_buyer, Error::InvalidLicenseTransfer)?;
        new_buyer.require_auth();

        let prompt = Storage::require_prompt(&env, prompt_id)?;
        let now = env.ledger().timestamp();
        let mut purchase = Storage::require_purchase(&env, prompt_id, &seller)?;
        ensure(purchase.owner == seller, Error::Unauthorized)?;
        ensure(purchase.expires_at >= now, Error::LicenseNotFound)?;
        ensure(
            !Storage::has_active_purchase(&env, prompt_id, &new_buyer, now),
            Error::AlreadyPurchased,
        )?;

        InstanceStorage::set_reentrancy_guard(&env)?;

        let this_contract = env.current_contract_address();
        let asset_client = token::StellarAssetClient::new(&env, &prompt.asset);
        // Resale has no platform-fee cut or splits — only the fixed creator
        // royalty — so it's called with an empty split list, sharing the
        // same arithmetic engine as buy/lease without adding a new
        // deduction category to resales (#82).
        let no_splits: Vec<Split> = Vec::new(&env);
        let allocation = allocate_payment(&env, resale_price, ROYALTY_BPS, None, &no_splits)?;
        let royalty_amount = allocation.fee;
        let seller_amount = allocation.creator_amount;

        if royalty_amount > 0 {
            asset_client.transfer_from(
                &this_contract,
                &new_buyer,
                &purchase.original_creator,
                &royalty_amount,
            );
        }
        if seller_amount > 0 {
            asset_client.transfer_from(&this_contract, &new_buyer, &seller, &seller_amount);
        }

        Storage::remove_purchase(&env, prompt_id, &seller);
        Storage::index_buyer_remove(&env, &seller, prompt_id);
        purchase.owner = new_buyer.clone();
        purchase.last_transfer_price = resale_price;
        purchase.transfer_count = purchase
            .transfer_count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        purchase.last_transferred_at = now;
        Storage::save_purchase(&env, &purchase);
        Storage::index_buyer_add(&env, &new_buyer, prompt_id);
        InstanceStorage::clear_reentrancy_guard(&env);

        Events::emit_license_transferred(
            &env,
            prompt_id,
            seller,
            new_buyer,
            purchase.original_creator,
            resale_price,
            royalty_amount,
        );
        Ok(())
    }

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
    ) -> Result<u32, Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;

        ensure(price_stroops > 0, Error::InvalidPrice)?;
        validate_len(&image_url, MAX_IMAGE_URL_LEN, Error::InvalidImageUrlLength)?;
        validate_len(&title, MAX_TITLE_LEN, Error::InvalidTitleLength)?;
        validate_len(&category, MAX_CATEGORY_LEN, Error::InvalidCategoryLength)?;
        validate_len(&preview_text, MAX_PREVIEW_LEN, Error::InvalidPreviewLength)?;

        let snapshot = ListingRevisionRecord {
            prompt_id,
            revision: prompt.revision,
            title: prompt.title.clone(),
            category: prompt.category.clone(),
            preview_text: prompt.preview_text.clone(),
            image_url: prompt.image_url.clone(),
            price_stroops: prompt.price_stroops,
            revised_at: env.ledger().timestamp(),
        };
        Storage::save_listing_revision(&env, &snapshot);

        prompt.title = title;
        prompt.preview_text = preview_text;
        prompt.image_url = image_url;
        prompt.price_stroops = price_stroops;
        prompt.revision = prompt
            .revision
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;

        let old_category = prompt.category.clone();
        prompt.category = category;
        Storage::reindex_category(&env, prompt_id, &old_category, &prompt.category);

        Storage::update_prompt(&env, &prompt);
        Events::emit_listing_revised(&env, prompt_id, prompt.revision);
        Ok(prompt.revision)
    }

    fn get_listing_revision(
        env: Env,
        prompt_id: u64,
        revision: u32,
    ) -> Result<ListingRevisionRecord, Error> {
        Storage::require_prompt(&env, prompt_id)?;
        Storage::get_listing_revision(&env, prompt_id, revision).ok_or(Error::PromptNotFound)
    }

    fn update_splits(
        env: Env,
        creator: Address,
        prompt_id: u64,
        new_splits: Vec<Split>,
    ) -> Result<(), Error> {
        creator.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;

        validate_splits(&env, &new_splits)?;
        validate_no_duplicate_recipients(&new_splits)?;
        ensure(new_splits.len() <= MAX_SPLITS, Error::TooManySplits)?;

        prompt.splits = new_splits;
        Storage::update_prompt(&env, &prompt);
        // Re-pin to the currently active fee policy: touching splits is the
        // creator's explicit acceptance of the current rates (#82).
        Storage::set_prompt_fee_policy_version(
            &env,
            prompt_id,
            InstanceStorage::get_current_fee_policy_version(&env),
        );
        Events::emit_splits_updated(&env, prompt_id);
        Ok(())
    }

    fn has_access(env: Env, user: Address, prompt_id: u64) -> Result<bool, Error> {
        let prompt = Storage::require_prompt(&env, prompt_id)?;
        if prompt.creator == user {
            return Ok(true);
        }
        let now = env.ledger().timestamp();
        if !Storage::has_active_purchase(&env, prompt_id, &user, now) {
            return Ok(false);
        }
        if let Some(escrow) = Storage::get_escrow(&env, prompt_id, &user) {
            match escrow.state {
                EscrowState::Disputed | EscrowState::Refunded => Ok(false),
                _ => Ok(true),
            }
        } else {
            Ok(true)
        }
    }

    fn get_prompt(env: Env, prompt_id: u64) -> Result<Prompt, Error> {
        Storage::require_prompt(&env, prompt_id)
    }

    fn get_active_prompts_page(
        env: Env,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Storage::get_active_prompts_page(&env, cursor, limit)
    }

    fn get_prompts_by_category_page(
        env: Env,
        category: String,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        validate_len(&category, MAX_CATEGORY_LEN, Error::InvalidCategoryLength)?;
        Storage::get_prompts_by_category_page(&env, &category, cursor, limit)
    }

    fn get_prompts_by_tag_page(
        env: Env,
        tag: String,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        validate_len(&tag, MAX_TAG_LEN, Error::InvalidCategoryLength)?;
        Storage::get_prompts_by_tag_page(&env, &tag, cursor, limit)
    }

    fn open_dispute(
        env: Env,
        buyer: Address,
        prompt_id: u64,
        reason: DisputeReason,
    ) -> Result<(), Error> {
        buyer.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let now = env.ledger().timestamp();
        Storage::require_purchase(&env, prompt_id, &buyer)?;
        
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(escrow.state == EscrowState::Pending, Error::InvalidEscrowState)?;
        ensure(now <= escrow.dispute_window_expiry, Error::DisputeExpired)?;

        escrow.state = EscrowState::Disputed;
        escrow.dispute_opened_at = now;
        escrow.resolution_deadline = now.checked_add(14 * 24 * 60 * 60).ok_or(Error::ArithmeticOverflow)?;
        Storage::save_escrow(&env, &escrow);

        // Also create/update legacy PurchaseDispute for backward compatibility
        let dispute = PurchaseDispute {
            prompt_id,
            buyer: buyer.clone(),
            reason,
            opened_at: now,
            resolved_at: 0,
            status: DisputeStatus::Open,
        };
        Storage::save_dispute(&env, &dispute);

        Events::emit_dispute_opened(&env, prompt_id, buyer);
        Ok(())
    }

    fn resolve_dispute(
        env: Env,
        admin: Address,
        prompt_id: u64,
        buyer: Address,
        refund: bool,
    ) -> Result<(), Error> {
        admin.require_auth();
        let owner = ownable::get_owner(&env).ok_or(Error::Unauthorized)?;
        ensure(owner == admin, Error::Unauthorized)?;
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;

        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        if escrow.state == EscrowState::Refunded
            || escrow.state == EscrowState::Released
            || escrow.state == EscrowState::Rejected
            || escrow.state == EscrowState::Expired
        {
            return Err(Error::DisputeResolved);
        }
        ensure(escrow.state == EscrowState::Disputed, Error::InvalidEscrowState)?;

        execute_resolution_transfer(&env, &mut escrow, refund)?;
        escrow.state = if refund { EscrowState::Refunded } else { EscrowState::Released };
        escrow.dispute_resolved_at = env.ledger().timestamp();
        Storage::save_escrow(&env, &escrow);

        // Also update legacy PurchaseDispute for backward compatibility
        if let Some(mut dispute) = Storage::get_dispute(&env, prompt_id, &buyer) {
            dispute.resolved_at = env.ledger().timestamp();
            dispute.status = if refund { DisputeStatus::Refunded } else { DisputeStatus::Rejected };
            Storage::save_dispute(&env, &dispute);
        }

        Events::emit_dispute_resolved(&env, prompt_id, buyer, refund);
        Ok(())
    }

    fn get_dispute(env: Env, prompt_id: u64, buyer: Address) -> Result<PurchaseDispute, Error> {
        Storage::require_dispute(&env, prompt_id, &buyer)
    }

    fn get_prompts_by_creator_page(
        env: Env,
        creator: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Storage::get_prompts_by_creator_page(&env, &creator, cursor, limit)
    }

    fn get_prompts_by_buyer_page(
        env: Env,
        buyer: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PromptPage, Error> {
        Storage::get_prompts_by_buyer_page(&env, &buyer, cursor, limit)
    }

    #[only_owner]
    fn set_fee_percentage(env: Env, new_fee_percentage: u32) -> Result<(), Error> {
        propose_fee_change(&env, Some(new_fee_percentage), None)
    }

    #[only_owner]
    fn set_fee_wallet(env: Env, new_fee_wallet: Address) -> Result<(), Error> {
        InstanceStorage::set_fee_wallet(&env, &new_fee_wallet);
        Events::emit_fee_wallet_updated(&env, new_fee_wallet);
        Ok(())
    }

    fn get_fee_percentage(env: Env) -> u32 {
        current_fee_policy(&env).fee_bps
    }

    fn get_fee_wallet(env: Env) -> Option<Address> {
        InstanceStorage::get_fee_wallet(&env)
    }

    #[only_owner]
    fn update_platform_fee(env: Env, admin: Address, new_fee: u32) -> Result<(), Error> {
        admin.require_auth();
        let owner = ownable::get_owner(&env).ok_or(Error::Unauthorized)?;
        ensure(owner == admin, Error::Unauthorized)?;
        propose_fee_change(&env, Some(new_fee), None)
    }

    fn get_platform_fee(env: Env) -> u32 {
        current_fee_policy(&env).fee_bps
    }

    /// Activate a previously proposed fee/referral change once its timelock
    /// has elapsed (#82). Permissionless: the values were already fixed and
    /// made public at proposal time, so anyone may trigger the state
    /// transition once it's due — there's nothing to gain by front-running.
    fn activate_pending_fee_policy(env: Env) -> Result<u32, Error> {
        let pending =
            InstanceStorage::get_pending_fee_policy(&env).ok_or(Error::FeeWalletNotSet)?;
        let now = env.ledger().timestamp();
        ensure(
            now >= pending.effective_at,
            Error::InvalidPrice,
        )?;

        let current_version = InstanceStorage::get_current_fee_policy_version(&env);
        if Storage::get_fee_policy(&env, current_version).is_none() {
            // Freeze the pre-governance baseline exactly once, before it is
            // ever superseded, so listings still pinned to it keep reading
            // the values that were live before any governed change (#82).
            let baseline = FeePolicy {
                version: current_version,
                fee_bps: InstanceStorage::get_fee_percentage(&env),
                referral_bps: InstanceStorage::get_referral_percentage(&env),
                effective_at: 0,
            };
            Storage::save_fee_policy(&env, &baseline);
        }

        let activated = FeePolicy {
            version: pending.version,
            fee_bps: pending.fee_bps,
            referral_bps: pending.referral_bps,
            effective_at: now,
        };
        Storage::save_fee_policy(&env, &activated);
        InstanceStorage::set_current_fee_policy_version(&env, activated.version);
        InstanceStorage::clear_pending_fee_policy(&env);

        Events::emit_fee_policy_activated(
            &env,
            activated.version,
            activated.fee_bps,
            activated.referral_bps,
        );
        Ok(activated.version)
    }

    fn get_pending_fee_policy(env: Env) -> Option<FeePolicy> {
        InstanceStorage::get_pending_fee_policy(&env)
    }

    fn get_fee_policy(env: Env, version: u32) -> FeePolicy {
        resolve_fee_policy(&env, version)
    }

    fn get_current_fee_policy_version(env: Env) -> u32 {
        InstanceStorage::get_current_fee_policy_version(&env)
    }

    fn get_prompt_fee_policy_version(env: Env, prompt_id: u64) -> Result<u32, Error> {
        Storage::require_prompt(&env, prompt_id)?;
        Ok(Storage::get_prompt_fee_policy_version(&env, prompt_id))
    }

    fn preview_purchase(
        env: Env,
        prompt_id: u64,
        payment_amount_stroops: i128,
        has_referrer: bool,
    ) -> Result<PurchasePreview, Error> {
        let prompt = Storage::require_prompt(&env, prompt_id)?;
        let policy_version = Storage::get_prompt_fee_policy_version(&env, prompt_id);
        let policy = resolve_fee_policy(&env, policy_version);
        let referral_bps = if has_referrer {
            Some(policy.referral_bps)
        } else {
            None
        };
        let allocation = allocate_payment(
            &env,
            payment_amount_stroops,
            policy.fee_bps,
            referral_bps,
            &prompt.splits,
        )?;
        Ok(PurchasePreview {
            policy_version,
            fee_amount: allocation.fee,
            referral_amount: allocation.referral,
            split_amounts: allocation.split_amounts,
            creator_amount: allocation.creator_amount,
        })
    }

    fn get_xlm_sac(env: Env) -> Option<Address> {
        InstanceStorage::get_xlm_address(&env)
    }

    fn get_prompts_by_ids(env: Env, prompt_ids: Vec<u64>) -> Result<Vec<Prompt>, Error> {
        ensure(prompt_ids.len() <= MAX_PAGE_SIZE, Error::MaxSupplyReached)?;
        let mut prompts = Vec::new(&env);
        for i in 0..prompt_ids.len() {
            let id = prompt_ids.get(i).unwrap();
            if let Ok(prompt) = Storage::require_prompt(&env, id) {
                prompts.push_back(prompt);
            }
        }
        Ok(prompts)
    }

    #[only_owner]
    fn set_pause_status(env: Env, paused: bool) -> Result<(), Error> {
        InstanceStorage::set_pause_status(&env, paused);
        Events::emit_contract_paused_state_changed(&env, paused);
        Ok(())
    }

    fn is_paused(env: Env) -> bool {
        InstanceStorage::is_paused(&env)
    }

    #[only_owner]
    fn set_referral_percentage(env: Env, new_referral_percentage: u32) -> Result<(), Error> {
        propose_fee_change(&env, None, Some(new_referral_percentage))
    }

    fn get_referral_percentage(env: Env) -> u32 {
        current_fee_policy(&env).referral_bps
    }

    fn add_voucher(
        env: Env,
        creator: Address,
        prompt_id: u64,
        hashed_code: BytesN<32>,
        discount_bps: u32,
    ) -> Result<(), Error> {
        creator.require_auth();
        ensure(discount_bps <= MAX_BPS, Error::InvalidDiscountPercentage)?;
        let prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;

        Storage::add_voucher(&env, prompt_id, &hashed_code, discount_bps);
        Events::emit_voucher_added(&env, prompt_id, hashed_code, discount_bps);
        Ok(())
    }

    fn remove_voucher(
        env: Env,
        creator: Address,
        prompt_id: u64,
        hashed_code: BytesN<32>,
    ) -> Result<(), Error> {
        creator.require_auth();
        let prompt = Storage::require_prompt(&env, prompt_id)?;
        ensure(prompt.creator == creator, Error::Unauthorized)?;

        Storage::remove_voucher(&env, prompt_id, &hashed_code);
        Events::emit_voucher_removed(&env, prompt_id, hashed_code);
        Ok(())
    }

    #[only_owner]
    fn add_upgrade_signer(env: Env, signer: Address) -> Result<(), Error> {
        let mut signers = Storage::get_upgrade_signers(&env);
        ensure(
            signers.len() < MAX_UPGRADE_SIGNERS,
            Error::UpgradeSignerConfigInvalid,
        )?;
        for s in signers.iter() {
            ensure(s != signer, Error::UpgradeSignerConfigInvalid)?;
        }
        signers.push_back(signer.clone());
        Storage::save_upgrade_signers(&env, &signers);
        Events::emit_upgrade_signer_added(&env, signer);
        Ok(())
    }

    #[only_owner]
    fn remove_upgrade_signer(env: Env, signer: Address) -> Result<(), Error> {
        let mut signers = Storage::get_upgrade_signers(&env);
        let mut index = 0;
        let mut found = false;
        while index < signers.len() {
            if signers.get(index).unwrap() == signer {
                signers.remove(index);
                found = true;
            } else {
                index += 1;
            }
        }
        ensure(found, Error::UpgradeSignerConfigInvalid)?;
        Storage::save_upgrade_signers(&env, &signers);
        Events::emit_upgrade_signer_removed(&env, signer);
        Ok(())
    }

    #[only_owner]
    fn set_upgrade_threshold(env: Env, threshold: u32) -> Result<(), Error> {
        ensure(threshold > 0, Error::UpgradeSignerConfigInvalid)?;
        InstanceStorage::set_upgrade_threshold(&env, threshold);
        Events::emit_upgrade_threshold_updated(&env, threshold);
        Ok(())
    }

    fn get_upgrade_signers(env: Env) -> Vec<Address> {
        Storage::get_upgrade_signers(&env)
    }

    fn get_upgrade_threshold(env: Env) -> u32 {
        InstanceStorage::get_upgrade_threshold(&env)
    }

    fn get_upgrade_epoch(env: Env) -> u32 {
        InstanceStorage::get_upgrade_epoch(&env)
    }

    fn get_current_wasm_hash(env: Env) -> Option<BytesN<32>> {
        InstanceStorage::get_current_wasm_hash(&env)
    }

    fn get_previous_wasm_hash(env: Env) -> Option<BytesN<32>> {
        InstanceStorage::get_previous_wasm_hash(&env)
    }

    fn get_schema_version(env: Env) -> u32 {
        InstanceStorage::get_schema_version(&env)
    }

    fn compute_migration_hash(
        env: Env,
        target_wasm_hash: BytesN<32>,
        schema_version: u32,
    ) -> BytesN<32> {
        build_migration_hash(&env, &target_wasm_hash, schema_version)
    }

    fn verify_upgrade_invariants(env: Env) -> Result<(), Error> {
        check_upgrade_invariants(&env)
    }

    #[allow(clippy::too_many_arguments)]
    fn propose_upgrade(
        env: Env,
        proposer: Address,
        target_wasm_hash: BytesN<32>,
        schema_version: u32,
        migration_hash: BytesN<32>,
        earliest_execution_time: u64,
        expiry_time: u64,
        is_rollback: bool,
    ) -> Result<u32, Error> {
        proposer.require_auth();
        ensure_upgrade_signer(&env, &proposer)?;
        check_upgrade_invariants(&env)?;

        let now = env.ledger().timestamp();
        ensure(
            earliest_execution_time
                >= now
                    .checked_add(MIN_UPGRADE_TIMELOCK_SECS)
                    .ok_or(Error::ArithmeticOverflow)?,
            Error::UpgradeBindingMismatch,
        )?;
        ensure(
            expiry_time > earliest_execution_time,
            Error::UpgradeBindingMismatch,
        )?;

        let current_schema_version = InstanceStorage::get_schema_version(&env);
        verify_schema_transition(is_rollback, schema_version, current_schema_version)?;

        if is_rollback {
            let previous = InstanceStorage::get_previous_wasm_hash(&env);
            ensure(
                previous == Some(target_wasm_hash.clone()),
                Error::UpgradeBindingMismatch,
            )?;
        }

        let expected_hash = build_migration_hash(&env, &target_wasm_hash, schema_version);
        ensure(
            expected_hash == migration_hash,
            Error::UpgradeBindingMismatch,
        )?;

        let id = InstanceStorage::next_upgrade_proposal_id(&env)?;
        let proposal = UpgradeProposal {
            id,
            proposer: proposer.clone(),
            target_wasm_hash: target_wasm_hash.clone(),
            expected_current_wasm_hash: InstanceStorage::get_current_wasm_hash(&env),
            contract_id: env.current_contract_address(),
            network_id: env.ledger().network_id(),
            epoch: InstanceStorage::get_upgrade_epoch(&env),
            schema_version,
            migration_hash: migration_hash.clone(),
            is_rollback,
            earliest_execution_time,
            expiry_time,
            created_at: now,
            approvals: Vec::new(&env),
            executed: false,
            cancelled: false,
        };
        Storage::save_upgrade_proposal(&env, &proposal);

        Events::emit_upgrade_proposed(
            &env,
            id,
            proposer,
            target_wasm_hash,
            schema_version,
            migration_hash,
            earliest_execution_time,
            expiry_time,
            is_rollback,
        );
        Ok(id)
    }

    fn approve_upgrade(env: Env, signer: Address, proposal_id: u32) -> Result<(), Error> {
        signer.require_auth();
        ensure_upgrade_signer(&env, &signer)?;

        let mut proposal = Storage::require_upgrade_proposal(&env, proposal_id)?;
        ensure(
            !proposal.executed && !proposal.cancelled,
            Error::UpgradeProposalUnavailable,
        )?;
        let now = env.ledger().timestamp();
        ensure(
            now <= proposal.expiry_time,
            Error::UpgradeProposalUnavailable,
        )?;

        for approver in proposal.approvals.iter() {
            ensure(approver != signer, Error::UpgradeProposalUnavailable)?;
        }
        proposal.approvals.push_back(signer.clone());
        let approvals_count = proposal.approvals.len();
        Storage::save_upgrade_proposal(&env, &proposal);

        Events::emit_upgrade_approved(&env, proposal_id, signer, approvals_count);
        Ok(())
    }

    fn cancel_upgrade(env: Env, caller: Address, proposal_id: u32) -> Result<(), Error> {
        caller.require_auth();
        let mut proposal = Storage::require_upgrade_proposal(&env, proposal_id)?;
        ensure(
            !proposal.executed && !proposal.cancelled,
            Error::UpgradeProposalUnavailable,
        )?;

        let owner = ownable::get_owner(&env);
        let is_owner = owner.as_ref() == Some(&caller);
        ensure(caller == proposal.proposer || is_owner, Error::Unauthorized)?;

        proposal.cancelled = true;
        Storage::save_upgrade_proposal(&env, &proposal);

        Events::emit_upgrade_cancelled(&env, proposal_id, caller);
        Ok(())
    }

    fn execute_upgrade(env: Env, caller: Address, proposal_id: u32) -> Result<(), Error> {
        caller.require_auth();
        let mut proposal = Storage::require_upgrade_proposal(&env, proposal_id)?;
        ensure(
            !proposal.executed && !proposal.cancelled,
            Error::UpgradeProposalUnavailable,
        )?;

        let now = env.ledger().timestamp();
        ensure(
            now >= proposal.earliest_execution_time,
            Error::UpgradeProposalUnavailable,
        )?;
        ensure(
            now <= proposal.expiry_time,
            Error::UpgradeProposalUnavailable,
        )?;

        ensure(
            proposal.contract_id == env.current_contract_address(),
            Error::UpgradeBindingMismatch,
        )?;
        ensure(
            proposal.network_id == env.ledger().network_id(),
            Error::UpgradeBindingMismatch,
        )?;
        ensure(
            proposal.expected_current_wasm_hash == InstanceStorage::get_current_wasm_hash(&env),
            Error::UpgradeBindingMismatch,
        )?;
        ensure(
            proposal.epoch == InstanceStorage::get_upgrade_epoch(&env),
            Error::UpgradeBindingMismatch,
        )?;

        let threshold = InstanceStorage::get_upgrade_threshold(&env);
        let active_approvals = count_active_approvals(&env, &proposal);
        ensure(
            threshold > 0 && active_approvals >= threshold,
            Error::UpgradeProposalUnavailable,
        )?;

        let expected_migration_hash =
            build_migration_hash(&env, &proposal.target_wasm_hash, proposal.schema_version);
        ensure(
            expected_migration_hash == proposal.migration_hash,
            Error::UpgradeBindingMismatch,
        )?;

        let current_schema_version = InstanceStorage::get_schema_version(&env);
        verify_schema_transition(
            proposal.is_rollback,
            proposal.schema_version,
            current_schema_version,
        )?;
        if proposal.is_rollback {
            let previous = InstanceStorage::get_previous_wasm_hash(&env);
            ensure(
                previous == Some(proposal.target_wasm_hash.clone()),
                Error::UpgradeBindingMismatch,
            )?;
        }

        check_upgrade_invariants(&env)?;

        let previous_wasm_hash = InstanceStorage::get_current_wasm_hash(&env);
        env.deployer()
            .update_current_contract_wasm(proposal.target_wasm_hash.clone());
        if let Some(previous) = previous_wasm_hash {
            InstanceStorage::set_previous_wasm_hash(&env, &previous);
        }
        InstanceStorage::set_current_wasm_hash(&env, &proposal.target_wasm_hash);
        InstanceStorage::set_schema_version(&env, proposal.schema_version);
        let new_epoch = InstanceStorage::increment_upgrade_epoch(&env)?;

        env.storage().instance().extend_ttl(
            crate::ttl_policy::PERSISTENT_LIFETIME_THRESHOLD,
            crate::ttl_policy::PERSISTENT_BUMP_AMOUNT,
        );
        Storage::extend_all_ttl(&env);

        proposal.executed = true;
        let target_wasm_hash = proposal.target_wasm_hash.clone();
        let schema_version = proposal.schema_version;
        Storage::save_upgrade_proposal(&env, &proposal);

        Events::emit_upgrade_executed(
            &env,
            proposal_id,
            target_wasm_hash,
            schema_version,
            new_epoch,
        );
        Ok(())
    }

    fn get_upgrade_proposal(env: Env, proposal_id: u32) -> Result<UpgradeProposal, Error> {
        Storage::require_upgrade_proposal(&env, proposal_id)
    }

    fn extend_ttl(env: Env, key: DataKey) -> Result<(), Error> {
        Storage::extend_key_ttl(&env, &key);
        Ok(())
    }

    #[only_owner]
    fn extend_ttl_page(env: Env, cursor: Option<u64>, limit: u32) -> Result<Option<u64>, Error> {
        Ok(Storage::extend_ttl_page(&env, cursor, limit))
    }

    #[only_owner]
    fn migrate_prompt_indexes_page(
        env: Env,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<Option<u64>, Error> {
        Ok(Storage::migrate_prompt_indexes_page(&env, cursor, limit))
    }

    #[only_owner]
    fn migrate_buyer_index_page(
        env: Env,
        buyer: Address,
        cursor: Option<u32>,
        limit: u32,
    ) -> Result<Option<u32>, Error> {
        Ok(Storage::migrate_buyer_index_page(&env, &buyer, cursor, limit))
    }

    fn submit_evidence(
        env: Env,
        party: Address,
        prompt_id: u64,
        buyer: Address,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        party.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(escrow.state == EscrowState::Disputed, Error::InvalidEscrowState)?;
        ensure(
            party == escrow.buyer || party == escrow.creator,
            Error::Unauthorized,
        )?;

        escrow.evidence_hashes.push_back(evidence_hash.clone());
        Storage::save_escrow(&env, &escrow);

        Events::emit_evidence_submitted(&env, prompt_id, buyer, party, evidence_hash);
        Ok(())
    }

    fn vote_on_dispute(
        env: Env,
        reviewer: Address,
        prompt_id: u64,
        buyer: Address,
        refund: bool,
    ) -> Result<(), Error> {
        reviewer.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        
        let reviewers = Storage::get_reviewers(&env);
        let mut is_reviewer = false;
        for r in reviewers.iter() {
            if r == reviewer {
                is_reviewer = true;
                break;
            }
        }
        ensure(is_reviewer, Error::NotAReviewer)?;

        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(escrow.state == EscrowState::Disputed, Error::InvalidEscrowState)?;
        ensure(!escrow.is_appealed, Error::InvalidEscrowState)?;

        // Conflict check
        ensure(reviewer != escrow.buyer && reviewer != escrow.creator, Error::ConflictOfInterest)?;
        for split in escrow.splits.iter() {
            ensure(reviewer != split.recipient, Error::ConflictOfInterest)?;
        }

        // Duplicate vote check
        for v in escrow.voters.iter() {
            ensure(v != reviewer, Error::DuplicateVote)?;
        }

        escrow.voters.push_back(reviewer.clone());
        if refund {
            escrow.votes_for_refund = escrow.votes_for_refund.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        } else {
            escrow.votes_for_reject = escrow.votes_for_reject.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        }

        Events::emit_dispute_voted(&env, prompt_id, buyer.clone(), reviewer, refund);

        let threshold = InstanceStorage::get_reviewer_threshold(&env);
        if escrow.votes_for_refund >= threshold {
            escrow.state = EscrowState::Refunded;
            escrow.dispute_resolved_at = env.ledger().timestamp();
            Storage::save_escrow(&env, &escrow);

            // Also update legacy PurchaseDispute for backward compatibility
            if let Some(mut dispute) = Storage::get_dispute(&env, prompt_id, &buyer) {
                dispute.resolved_at = env.ledger().timestamp();
                dispute.status = DisputeStatus::Refunded;
                Storage::save_dispute(&env, &dispute);
            }
            Events::emit_dispute_resolved(&env, prompt_id, buyer, true);
        } else if escrow.votes_for_reject >= threshold {
            escrow.state = EscrowState::Rejected;
            escrow.dispute_resolved_at = env.ledger().timestamp();
            Storage::save_escrow(&env, &escrow);

            // Also update legacy PurchaseDispute for backward compatibility
            if let Some(mut dispute) = Storage::get_dispute(&env, prompt_id, &buyer) {
                dispute.resolved_at = env.ledger().timestamp();
                dispute.status = DisputeStatus::Rejected;
                Storage::save_dispute(&env, &dispute);
            }
            Events::emit_dispute_resolved(&env, prompt_id, buyer, false);
        } else {
            Storage::save_escrow(&env, &escrow);
        }

        Ok(())
    }

    fn appeal_resolution(
        env: Env,
        party: Address,
        prompt_id: u64,
        buyer: Address,
    ) -> Result<(), Error> {
        party.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(
            escrow.state == EscrowState::Refunded || escrow.state == EscrowState::Rejected,
            Error::InvalidEscrowState,
        )?;
        ensure(
            party == escrow.buyer || party == escrow.creator,
            Error::Unauthorized,
        )?;
        
        let now = env.ledger().timestamp();
        let appeal_window = 3 * 24 * 60 * 60; // 3 days
        ensure(
            now <= escrow.dispute_resolved_at.checked_add(appeal_window).ok_or(Error::ArithmeticOverflow)?,
            Error::AppealWindowExpired,
        )?;

        escrow.is_appealed = true;
        escrow.state = EscrowState::Disputed;
        Storage::save_escrow(&env, &escrow);

        Events::emit_dispute_appealed(&env, prompt_id, buyer);
        Ok(())
    }

    fn resolve_appealed_dispute(
        env: Env,
        admin: Address,
        prompt_id: u64,
        buyer: Address,
        refund: bool,
    ) -> Result<(), Error> {
        admin.require_auth();
        let owner = ownable::get_owner(&env).ok_or(Error::Unauthorized)?;
        ensure(owner == admin, Error::Unauthorized)?;
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(escrow.is_appealed, Error::InvalidEscrowState)?;
        
        execute_resolution_transfer(&env, &mut escrow, refund)?;
        escrow.state = if refund { EscrowState::Refunded } else { EscrowState::Released };
        escrow.is_appealed = false;
        escrow.dispute_resolved_at = env.ledger().timestamp();
        Storage::save_escrow(&env, &escrow);

        // Also update legacy PurchaseDispute for backward compatibility
        if let Some(mut dispute) = Storage::get_dispute(&env, prompt_id, &buyer) {
            dispute.resolved_at = env.ledger().timestamp();
            dispute.status = if refund { DisputeStatus::Refunded } else { DisputeStatus::Rejected };
            Storage::save_dispute(&env, &dispute);
        }

        Events::emit_dispute_resolved(&env, prompt_id, buyer, refund);
        Ok(())
    }

    fn release_funds_early(env: Env, buyer: Address, prompt_id: u64) -> Result<(), Error> {
        buyer.require_auth();
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(escrow.state == EscrowState::Pending, Error::InvalidEscrowState)?;
        
        execute_resolution_transfer(&env, &mut escrow, false)?;
        escrow.state = EscrowState::Released;
        Storage::save_escrow(&env, &escrow);
        Ok(())
    }

    fn resolve_escrow_timeout(env: Env, prompt_id: u64, buyer: Address) -> Result<(), Error> {
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        ensure(escrow.state == EscrowState::Pending, Error::InvalidEscrowState)?;
        
        let now = env.ledger().timestamp();
        ensure(now > escrow.dispute_window_expiry, Error::DisputeNotExpired)?;
        
        execute_resolution_transfer(&env, &mut escrow, false)?;
        escrow.state = EscrowState::Expired;
        Storage::save_escrow(&env, &escrow);
        Ok(())
    }

    fn resolve_dispute_timeout(env: Env, prompt_id: u64, buyer: Address) -> Result<(), Error> {
        ensure(!InstanceStorage::is_paused(&env), Error::ContractIsPaused)?;
        
        let mut escrow = Storage::require_escrow(&env, prompt_id, &buyer)?;
        let now = env.ledger().timestamp();
        
        if escrow.state == EscrowState::Disputed {
            ensure(!escrow.is_appealed, Error::InvalidEscrowState)?;
            ensure(now > escrow.resolution_deadline, Error::DisputeNotExpired)?;
            
            execute_resolution_transfer(&env, &mut escrow, false)?;
            escrow.state = EscrowState::Expired;
            escrow.dispute_resolved_at = now;
            Storage::save_escrow(&env, &escrow);

            // Also update legacy PurchaseDispute for backward compatibility
            if let Some(mut dispute) = Storage::get_dispute(&env, prompt_id, &buyer) {
                dispute.resolved_at = now;
                dispute.status = DisputeStatus::Rejected;
                Storage::save_dispute(&env, &dispute);
            }
            Events::emit_dispute_resolved(&env, prompt_id, buyer, false);
        } else if escrow.state == EscrowState::Refunded {
            ensure(!escrow.is_appealed, Error::InvalidEscrowState)?;
            let appeal_window = 3 * 24 * 60 * 60;
            ensure(
                now > escrow.dispute_resolved_at.checked_add(appeal_window).ok_or(Error::ArithmeticOverflow)?,
                Error::DisputeNotExpired,
            )?;
            
            execute_resolution_transfer(&env, &mut escrow, true)?;
            escrow.state = EscrowState::Refunded;
            Storage::save_escrow(&env, &escrow);
        } else if escrow.state == EscrowState::Rejected {
            ensure(!escrow.is_appealed, Error::InvalidEscrowState)?;
            let appeal_window = 3 * 24 * 60 * 60;
            ensure(
                now > escrow.dispute_resolved_at.checked_add(appeal_window).ok_or(Error::ArithmeticOverflow)?,
                Error::DisputeNotExpired,
            )?;
            
            execute_resolution_transfer(&env, &mut escrow, false)?;
            escrow.state = EscrowState::Released;
            Storage::save_escrow(&env, &escrow);
        } else {
            return Err(Error::InvalidEscrowState);
        }
        
        Ok(())
    }

    fn add_reviewer(env: Env, admin: Address, reviewer: Address) -> Result<(), Error> {
        admin.require_auth();
        let owner = ownable::get_owner(&env).ok_or(Error::Unauthorized)?;
        ensure(owner == admin, Error::Unauthorized)?;
        
        let mut reviewers = Storage::get_reviewers(&env);
        let mut exists = false;
        for r in reviewers.iter() {
            if r == reviewer {
                exists = true;
                break;
            }
        }
        if !exists {
            reviewers.push_back(reviewer);
            Storage::save_reviewers(&env, &reviewers);
        }
        Ok(())
    }

    fn remove_reviewer(env: Env, admin: Address, reviewer: Address) -> Result<(), Error> {
        admin.require_auth();
        let owner = ownable::get_owner(&env).ok_or(Error::Unauthorized)?;
        ensure(owner == admin, Error::Unauthorized)?;
        
        let mut reviewers = Storage::get_reviewers(&env);
        let mut index = 0;
        let mut found = false;
        while index < reviewers.len() {
            if reviewers.get(index).unwrap() == reviewer {
                reviewers.remove(index);
                found = true;
            } else {
                index += 1;
            }
        }
        if found {
            Storage::save_reviewers(&env, &reviewers);
        }
        Ok(())
    }

    fn set_reviewer_threshold(env: Env, admin: Address, threshold: u32) -> Result<(), Error> {
        admin.require_auth();
        let owner = ownable::get_owner(&env).ok_or(Error::Unauthorized)?;
        ensure(owner == admin, Error::Unauthorized)?;
        ensure(threshold > 0, Error::InvalidPrice)?;
        
        InstanceStorage::set_reviewer_threshold(&env, threshold);
        Ok(())
    }

    fn get_reviewer_threshold(env: Env) -> u32 {
        InstanceStorage::get_reviewer_threshold(&env)
    }

    fn get_reviewers(env: Env) -> Vec<Address> {
        Storage::get_reviewers(&env)
    }

    fn get_escrow(env: Env, prompt_id: u64, buyer: Address) -> Result<Escrow, Error> {
        Storage::require_escrow(&env, prompt_id, &buyer)
    }
}

#[default_impl]
#[contractimpl]
impl Ownable for PromptHashContract {}

fn execute_buy(
    env: &Env,
    buyer: &Address,
    prompt_id: u64,
    referrer: &Option<Address>,
    payment_amount_stroops: i128,
    voucher: Option<Bytes>,
) -> Result<(), Error> {
    let mut prompt = Storage::require_prompt(env, prompt_id)?;
    let now = env.ledger().timestamp();

    ensure(prompt.active, Error::PromptInactive)?;
    ensure(prompt.creator != *buyer, Error::CreatorCannotBuy)?;
    ensure(
        !Storage::has_active_purchase(env, prompt_id, buyer, now),
        Error::AlreadyPurchased,
    )?;

    if prompt.expires_at != 0 {
        ensure(prompt.expires_at >= now, Error::ListingExpired)?;
    }

    if prompt.max_supply > 0 {
        ensure(
            prompt.sales_count < prompt.max_supply,
            Error::MaxSupplyReached,
        )?;
    }

    let mut required_price = prompt.price_stroops;
    if let Some(code) = voucher {
        let hashed_raw = env.crypto().sha256(&code);
        let hashed = BytesN::from_array(env, &hashed_raw.to_array());
        if let Some(discount_bps) = Storage::get_voucher(env, prompt_id, &hashed) {
            let discount_amount = required_price
                .checked_mul(discount_bps as i128)
                .ok_or(Error::ArithmeticOverflow)?
                / MAX_BPS as i128;
            required_price = required_price
                .checked_sub(discount_amount)
                .ok_or(Error::ArithmeticOverflow)?;
            Storage::remove_voucher(env, prompt_id, &hashed);
        } else {
            return Err(Error::InvalidVoucher);
        }
    }

    ensure(
        payment_amount_stroops >= required_price,
        Error::InvalidPaymentAmount,
    )?;

    if let Some(ref r) = referrer {
        ensure(
            r != buyer && r != &prompt.creator,
            Error::ReferrerCannotBeBuyerOrCreator,
        )?;
    }

    InstanceStorage::set_reentrancy_guard(env)?;

    let fee_wallet = InstanceStorage::get_fee_wallet(env).ok_or(Error::FeeWalletNotSet)?;
    let this_contract = env.current_contract_address();

    // Use the fee policy this listing is pinned to (from creation, or its
    // last `update_splits` re-pin) rather than the live global rate — a
    // later admin fee change can then never retroactively brick an
    // already-listed prompt's purchasability (#82).
    let policy_version = Storage::get_prompt_fee_policy_version(env, prompt_id);
    let policy = resolve_fee_policy(env, policy_version);
    let fee_percentage = policy.fee_bps;
    let referral_percentage = policy.referral_bps;
    let referral_bps = if referrer.is_some() {
        Some(referral_percentage)
    } else {
        None
    };
    // Validates that fee + referral + splits <= 100% for this payment;
    // the actual per-recipient amounts are recomputed from these same
    // pinned rates at payout time (see `execute_resolution_transfer`).
    allocate_payment(
        env,
        payment_amount_stroops,
        fee_percentage,
        referral_bps,
        &prompt.splits,
    )?;

    let asset_client = token::StellarAssetClient::new(env, &prompt.asset);
    asset_client.transfer_from(&this_contract, buyer, &this_contract, &payment_amount_stroops);

    let dispute_window = 7 * 24 * 60 * 60; // 7 days in seconds
    let escrow = Escrow {
        prompt_id,
        buyer: buyer.clone(),
        creator: prompt.creator.clone(),
        asset: prompt.asset.clone(),
        price: payment_amount_stroops,
        fee_percentage,
        fee_wallet: fee_wallet.clone(),
        referral_percentage,
        referrer: referrer.clone(),
        splits: prompt.splits.clone(),
        content_hash: prompt.content_hash.clone(),
        created_at: now,
        dispute_window_expiry: now.checked_add(dispute_window).ok_or(Error::ArithmeticOverflow)?,
        state: EscrowState::Pending,
        dispute_opened_at: 0,
        resolution_deadline: 0,
        evidence_hashes: Vec::new(env),
        voters: Vec::new(env),
        votes_for_refund: 0,
        votes_for_reject: 0,
        is_appealed: false,
        dispute_resolved_at: 0,
    };
    Storage::save_escrow(env, &escrow);

    prompt.sales_count = prompt
        .sales_count
        .checked_add(1)
        .ok_or(Error::ArithmeticOverflow)?;
    Storage::update_prompt(env, &prompt);
    Storage::grant_purchase(
        env,
        &prompt,
        buyer,
        payment_amount_stroops,
        MAX_ACCESS_EXPIRY,
    );
    InstanceStorage::clear_reentrancy_guard(env);

    Events::emit_escrow_created(env, prompt_id, buyer.clone(), payment_amount_stroops);

    Events::emit_prompt_purchased(
        env,
        prompt_id,
        buyer.clone(),
        prompt.creator,
        payment_amount_stroops,
        referrer.clone(),
    );

    if payment_amount_stroops > required_price {
        Events::emit_prompt_tipped(
            env,
            prompt_id,
            buyer.clone(),
            payment_amount_stroops - required_price,
        );
    }

    Ok(())
}

/// Validates that a listing's splits fit within `MAX_BPS` alongside the
/// *currently active* fee policy's fee and referral rates — the same
/// policy version `create_prompt`/`update_splits` are about to pin the
/// listing to. Including `referral_bps` here (previously omitted) closes a
/// latent solvency gap: a referred purchase could otherwise deduct
/// fee + referral + splits > 100% even without any fee change (#82).
fn validate_splits(env: &Env, splits: &Vec<Split>) -> Result<(), Error> {
    let policy = current_fee_policy(env);
    let mut total_bps: u32 = policy
        .fee_bps
        .checked_add(policy.referral_bps)
        .ok_or(Error::ArithmeticOverflow)?;
    for i in 0..splits.len() {
        let split = splits.get(i).unwrap();
        ensure(split.bps > 0, Error::InvalidSplits)?;
        total_bps = total_bps
            .checked_add(split.bps)
            .ok_or(Error::ArithmeticOverflow)?;
    }
    ensure(total_bps <= MAX_BPS, Error::InvalidSplits)?;
    Ok(())
}

/// Resolves the fee policy for `version`. Falls back to the synthesized
/// pre-governance baseline (today's live `FeePercentage`/
/// `ReferralPercentage` values) for any version not yet materialized into
/// history — which, by construction, is only ever version `0` prior to the
/// first `activate_pending_fee_policy` call (#82).
fn resolve_fee_policy(env: &Env, version: u32) -> FeePolicy {
    if let Some(policy) = Storage::get_fee_policy(env, version) {
        return policy;
    }
    FeePolicy {
        version,
        fee_bps: InstanceStorage::get_fee_percentage(env),
        referral_bps: InstanceStorage::get_referral_percentage(env),
        effective_at: 0,
    }
}

fn current_fee_policy(env: &Env) -> FeePolicy {
    resolve_fee_policy(env, InstanceStorage::get_current_fee_policy_version(env))
}

/// Stages a fee/referral change behind the governance timelock (#82).
/// Overriding only `new_fee_bps` or only `new_referral_bps` preserves
/// whatever the *other* field is currently pending (or active, if nothing
/// is pending) — so `set_fee_percentage` and `set_referral_percentage` can
/// be called independently without clobbering each other. Any new proposal
/// replaces the previous one outright and restarts the timelock.
fn propose_fee_change(
    env: &Env,
    new_fee_bps: Option<u32>,
    new_referral_bps: Option<u32>,
) -> Result<(), Error> {
    if let Some(fee) = new_fee_bps {
        ensure(fee <= MAX_PLATFORM_FEE, Error::FeeExceedsMaximum)?;
    }
    if let Some(referral) = new_referral_bps {
        ensure(referral <= MAX_BPS, Error::InvalidReferralPercentage)?;
    }

    let current_version = InstanceStorage::get_current_fee_policy_version(env);
    let baseline = InstanceStorage::get_pending_fee_policy(env)
        .unwrap_or_else(|| resolve_fee_policy(env, current_version));

    let now = env.ledger().timestamp();
    let pending = FeePolicy {
        version: current_version
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?,
        fee_bps: new_fee_bps.unwrap_or(baseline.fee_bps),
        referral_bps: new_referral_bps.unwrap_or(baseline.referral_bps),
        effective_at: now
            .checked_add(FEE_POLICY_TIMELOCK_SECS)
            .ok_or(Error::ArithmeticOverflow)?,
    };
    InstanceStorage::set_pending_fee_policy(env, &pending);
    Events::emit_fee_policy_proposed(
        env,
        pending.version,
        pending.fee_bps,
        pending.referral_bps,
        pending.effective_at,
    );
    Ok(())
}

/// `amount * bps / MAX_BPS`, floor-rounded toward zero.
fn bps_amount(amount: i128, bps: u32) -> Result<i128, Error> {
    ensure(bps <= MAX_BPS, Error::InvalidFeePercentage)?;
    Ok(amount
        .checked_mul(bps as i128)
        .ok_or(Error::ArithmeticOverflow)?
        / MAX_BPS as i128)
}

struct Allocation {
    fee: i128,
    referral: i128,
    split_amounts: Vec<i128>,
    creator_amount: i128,
}

/// Shared waterfall allocator: deducts an optional fee, an optional
/// referral cut, then co-creator splits (in listing order) from `amount`.
/// The remaining `creator_amount` absorbs the integer-division remainder —
/// matching the existing "creator absorbs rounding dust" convention
/// documented on `Split::bps` — and is guaranteed non-negative whenever
/// `fee_bps + referral_bps + sum(split.bps) <= MAX_BPS`, since each term is
/// floor-divided against the same `amount` and floor(a/n) sums never
/// exceed floor of the combined total. Used by every money-splitting call
/// site (buy/bulk-buy validation, escrow payout, lease, resale royalty) so
/// their arithmetic can never drift apart (#82).
fn allocate_payment(
    env: &Env,
    amount: i128,
    fee_bps: u32,
    referral_bps: Option<u32>,
    splits: &Vec<Split>,
) -> Result<Allocation, Error> {
    let fee = bps_amount(amount, fee_bps)?;
    let referral = match referral_bps {
        Some(bps) => bps_amount(amount, bps)?,
        None => 0,
    };

    let mut split_amounts = Vec::new(env);
    let mut split_total: i128 = 0;
    for i in 0..splits.len() {
        let split = splits.get(i).unwrap();
        let split_amount = bps_amount(amount, split.bps)?;
        split_total = split_total
            .checked_add(split_amount)
            .ok_or(Error::ArithmeticOverflow)?;
        split_amounts.push_back(split_amount);
    }

    let creator_amount = amount
        .checked_sub(fee)
        .ok_or(Error::ArithmeticOverflow)?
        .checked_sub(referral)
        .ok_or(Error::ArithmeticOverflow)?
        .checked_sub(split_total)
        .ok_or(Error::ArithmeticOverflow)?;
    ensure(creator_amount >= 0, Error::InvalidSplits)?;

    Ok(Allocation {
        fee,
        referral,
        split_amounts,
        creator_amount,
    })
}

#[allow(clippy::too_many_arguments)]
fn validate_prompt_fields(
    image_url: &String,
    title: &String,
    category: &String,
    preview_text: &String,
    encrypted_prompt: &String,
    encryption_iv: &String,
    wrapped_key: &String,
    price_stroops: i128,
) -> Result<(), Error> {
    ensure(price_stroops > 0, Error::InvalidPrice)?;
    validate_len(image_url, MAX_IMAGE_URL_LEN, Error::InvalidImageUrlLength)?;
    validate_len(title, MAX_TITLE_LEN, Error::InvalidTitleLength)?;
    validate_len(category, MAX_CATEGORY_LEN, Error::InvalidCategoryLength)?;
    validate_len(preview_text, MAX_PREVIEW_LEN, Error::InvalidPreviewLength)?;
    validate_len(
        encrypted_prompt,
        MAX_ENCRYPTED_PROMPT_LEN,
        Error::InvalidEncryptedPromptLength,
    )?;
    validate_len(
        wrapped_key,
        MAX_WRAPPED_KEY_LEN,
        Error::InvalidWrappedKeyLength,
    )?;
    validate_len(encryption_iv, MAX_IV_LEN, Error::InvalidIvLength)?;
    Ok(())
}

fn validate_tags(tags: &Vec<String>) -> Result<(), Error> {
    ensure(tags.len() <= MAX_TAGS, Error::InvalidCategoryLength)?;
    for i in 0..tags.len() {
        let tag = tags.get(i).unwrap();
        validate_len(&tag, MAX_TAG_LEN, Error::InvalidCategoryLength)?;
        for j in (i + 1)..tags.len() {
            ensure(tag != tags.get(j).unwrap(), Error::InvalidCategoryLength)?;
        }
    }
    Ok(())
}

fn validate_no_duplicate_recipients(splits: &Vec<Split>) -> Result<(), Error> {
    for i in 0..splits.len() {
        for j in (i + 1)..splits.len() {
            let a = splits.get(i).unwrap();
            let b = splits.get(j).unwrap();
            ensure(a.recipient != b.recipient, Error::DuplicateSplitRecipient)?;
        }
    }
    Ok(())
}

fn validate_len(value: &String, max_len: u32, error: Error) -> Result<(), Error> {
    ensure(!value.is_empty() && value.len() <= max_len, error)
}

fn ensure(condition: bool, error: Error) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(error)
    }
}

/// Structural invariants that must hold for any upgrade to be safe: fee/
/// referral bounds, a reachable dispute-reviewer quorum, and a reachable
/// upgrade-signer quorum. This is the on-chain "simulate migration" gate —
/// bounded, deterministic checks rather than an unbounded storage walk, so
/// it stays safe to run standalone (RPC simulation) and inline before every
/// mutation (#84).
fn check_upgrade_invariants(env: &Env) -> Result<(), Error> {
    let fee_percentage = InstanceStorage::get_fee_percentage(env);
    ensure(fee_percentage <= MAX_BPS, Error::InvalidFeePercentage)?;

    let referral_percentage = InstanceStorage::get_referral_percentage(env);
    ensure(
        referral_percentage <= MAX_BPS,
        Error::InvalidReferralPercentage,
    )?;

    let reviewer_threshold = InstanceStorage::get_reviewer_threshold(env);
    ensure(reviewer_threshold >= 1, Error::ReviewerThresholdNotMet)?;

    let signers = Storage::get_upgrade_signers(env);
    let threshold = InstanceStorage::get_upgrade_threshold(env);
    ensure(
        threshold > 0 && threshold <= signers.len(),
        Error::UpgradeSignerConfigInvalid,
    )?;
    Ok(())
}

fn ensure_upgrade_signer(env: &Env, signer: &Address) -> Result<(), Error> {
    let signers = Storage::get_upgrade_signers(env);
    for s in signers.iter() {
        if s == *signer {
            return Ok(());
        }
    }
    Err(Error::Unauthorized)
}

/// `sha256(target_wasm_hash || schema_version || network_id)`. Anyone who
/// rebuilds the candidate Wasm and knows the (public) schema version and
/// network passphrase can reproduce this exact value and compare it against
/// the on-chain proposal, giving a reproducible, independently-verifiable
/// migration artifact identity (#84).
fn build_migration_hash(
    env: &Env,
    target_wasm_hash: &BytesN<32>,
    schema_version: u32,
) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.append(&Bytes::from_array(env, &target_wasm_hash.to_array()));
    data.append(&Bytes::from_array(env, &schema_version.to_be_bytes()));
    data.append(&Bytes::from_array(
        env,
        &env.ledger().network_id().to_array(),
    ));
    let digest = env.crypto().sha256(&data);
    BytesN::from_array(env, &digest.to_array())
}

/// Counts approvals cast by addresses that are still active upgrade signers,
/// so a signer rotated out after approving no longer counts toward quorum
/// (and a signer added after approving still doesn't retroactively count
/// until they approve themselves) (#84).
fn count_active_approvals(env: &Env, proposal: &UpgradeProposal) -> u32 {
    let signers = Storage::get_upgrade_signers(env);
    let mut count: u32 = 0;
    for approver in proposal.approvals.iter() {
        for s in signers.iter() {
            if s == approver {
                count += 1;
                break;
            }
        }
    }
    count
}

/// Forward migrations must strictly advance the schema version; rollbacks
/// may only restore a version at or below the current one. Checked both at
/// proposal time and again at execution time (#84).
fn verify_schema_transition(
    is_rollback: bool,
    schema_version: u32,
    current_schema_version: u32,
) -> Result<(), Error> {
    if is_rollback {
        ensure(
            schema_version <= current_schema_version,
            Error::UpgradeBindingMismatch,
        )
    } else {
        ensure(
            schema_version > current_schema_version,
            Error::UpgradeBindingMismatch,
        )
    }
}

fn execute_resolution_transfer(env: &Env, escrow: &mut Escrow, refund: bool) -> Result<(), Error> {
    ensure(escrow.price > 0, Error::InvalidPrice)?;
    let transfer_price = escrow.price;
    escrow.price = 0;

    if refund {
        let asset_client = token::StellarAssetClient::new(env, &escrow.asset);
        asset_client.transfer(&env.current_contract_address(), &escrow.buyer, &transfer_price);

        Storage::remove_purchase(env, escrow.prompt_id, &escrow.buyer);
        Storage::index_buyer_remove(env, &escrow.buyer, escrow.prompt_id);
        
        Events::emit_escrow_refunded(env, escrow.prompt_id, escrow.buyer.clone());
    } else {
        // Payout based on the snapshotted splits/fees, computed once via the
        // shared allocator (previously this recomputed the split amounts a
        // second time to pay them out, a second hand-copy of the same
        // formula that could silently drift from the first) (#82).
        let referral_bps = if escrow.referrer.is_some() {
            Some(escrow.referral_percentage)
        } else {
            None
        };
        let allocation = allocate_payment(
            env,
            transfer_price,
            escrow.fee_percentage,
            referral_bps,
            &escrow.splits,
        )?;

        let asset_client = token::StellarAssetClient::new(env, &escrow.asset);
        if allocation.creator_amount > 0 {
            asset_client.transfer(
                &env.current_contract_address(),
                &escrow.creator,
                &allocation.creator_amount,
            );
        }
        if allocation.fee > 0 {
            asset_client.transfer(&env.current_contract_address(), &escrow.fee_wallet, &allocation.fee);
        }
        if let Some(ref r) = escrow.referrer {
            if allocation.referral > 0 {
                asset_client.transfer(&env.current_contract_address(), r, &allocation.referral);
            }
        }
        for i in 0..escrow.splits.len() {
            let split = escrow.splits.get(i).unwrap();
            let split_amount = allocation.split_amounts.get(i).unwrap();
            if split_amount > 0 {
                asset_client.transfer(&env.current_contract_address(), &split.recipient, &split_amount);
            }
        }

        Events::emit_escrow_released(env, escrow.prompt_id, escrow.buyer.clone());
    }
    Ok(())
}

