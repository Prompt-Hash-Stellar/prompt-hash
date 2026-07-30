import { Contract, rpc, xdr, Address, nativeToScVal, scValToNative, TransactionBuilder, Networks, TimeoutInfinite } from '@stellar/stellar-sdk';
import { ContractClientConfig, CreatePromptArgs, ContractPrompt } from './types.js';
import { normalizeError, ContractError } from './errors.js';

export class PromptHashContractClient {
  private rpc: rpc.Server;
  private contract: Contract;
  private networkPassphrase: string;

  constructor(config: ContractClientConfig) {
    this.rpc = new rpc.Server(config.rpcUrl);
    this.contract = new Contract(config.contractId);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Constructs a transaction to create a prompt.
   * Note: You must sign and submit the returned transaction.
   */
  async buildCreatePromptTx(
    sourceAddress: string,
    args: CreatePromptArgs
  ): Promise<xdr.Transaction> {
    try {
      const sourceAccount = await this.rpc.getAccount(sourceAddress);
      
      const invokeArgs = [
        nativeToScVal(args.creator, { type: 'address' }),
        nativeToScVal(args.imageUrl, { type: 'string' }),
        nativeToScVal(args.title, { type: 'string' }),
        nativeToScVal(args.category, { type: 'string' }),
        nativeToScVal(args.previewText, { type: 'string' }),
        nativeToScVal(args.encryptedPrompt, { type: 'string' }),
        nativeToScVal(args.encryptionIv, { type: 'string' }),
        nativeToScVal(args.wrappedKey, { type: 'string' }),
        nativeToScVal(args.contentHash),
        nativeToScVal({
          price: args.listing.price,
          asset: new Address(args.listing.asset),
          max_supply: args.listing.max_supply,
          expires_at: args.listing.expires_at,
          splits: args.listing.splits.map(s => ({
            recipient: new Address(s.recipient),
            bps: s.bps
          })),
          tags: args.listing.tags
        })
      ];

      const call = this.contract.call('create_prompt', ...invokeArgs);

      return new TransactionBuilder(sourceAccount, {
        fee: '100', // Note: use appropriate fee or fee bump in production
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(call)
        .setTimeout(TimeoutInfinite)
        .build();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async buildBuyPromptTx(
    sourceAddress: string,
    buyer: string,
    promptId: bigint,
    paymentAmountStroops: bigint,
    referrer?: string,
    voucher?: Buffer
  ): Promise<xdr.Transaction> {
    try {
      const sourceAccount = await this.rpc.getAccount(sourceAddress);
      
      const invokeArgs = [
        nativeToScVal(buyer, { type: 'address' }),
        nativeToScVal(promptId, { type: 'u64' }),
        nativeToScVal(referrer ? new Address(referrer) : undefined),
        nativeToScVal(paymentAmountStroops, { type: 'i128' }),
        nativeToScVal(voucher)
      ];

      const call = this.contract.call('buy_prompt', ...invokeArgs);

      return new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(call)
        .setTimeout(TimeoutInfinite)
        .build();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async buildSetSaleStatusTx(
    sourceAddress: string,
    creator: string,
    promptId: bigint,
    active: boolean
  ): Promise<xdr.Transaction> {
    try {
      const sourceAccount = await this.rpc.getAccount(sourceAddress);
      const call = this.contract.call('set_prompt_sale_status',
        nativeToScVal(creator, { type: 'address' }),
        nativeToScVal(promptId, { type: 'u64' }),
        nativeToScVal(active, { type: 'bool' })
      );

      return new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(call)
        .setTimeout(TimeoutInfinite)
        .build();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async buildUpdatePriceTx(
    sourceAddress: string,
    creator: string,
    promptId: bigint,
    priceStroops: bigint
  ): Promise<xdr.Transaction> {
    try {
      const sourceAccount = await this.rpc.getAccount(sourceAddress);
      const call = this.contract.call('update_prompt_price',
        nativeToScVal(creator, { type: 'address' }),
        nativeToScVal(promptId, { type: 'u64' }),
        nativeToScVal(priceStroops, { type: 'i128' })
      );

      return new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(call)
        .setTimeout(TimeoutInfinite)
        .build();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async buildTransferLicenseTx(
    sourceAddress: string,
    seller: string,
    promptId: bigint,
    newBuyer: string,
    resalePrice: bigint
  ): Promise<xdr.Transaction> {
    try {
      const sourceAccount = await this.rpc.getAccount(sourceAddress);
      const call = this.contract.call('transfer_license',
        nativeToScVal(seller, { type: 'address' }),
        nativeToScVal(promptId, { type: 'u64' }),
        nativeToScVal(newBuyer, { type: 'address' }),
        nativeToScVal(resalePrice, { type: 'i128' })
      );

      return new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(call)
        .setTimeout(TimeoutInfinite)
        .build();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  /** Read operations */
  
  async hasAccess(user: string, promptId: bigint): Promise<boolean> {
    try {
      const source = new Address(user);
      const call = this.contract.call('has_access',
        nativeToScVal(user, { type: 'address' }),
        nativeToScVal(promptId, { type: 'u64' })
      );
      
      const simulation = await this.rpc.simulateTransaction(
        new TransactionBuilder(new rpc.Account(user, "0"), {
          fee: '100',
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(call)
          .setTimeout(TimeoutInfinite)
          .build()
      );

      if (rpc.Api.isSimulationError(simulation)) {
        throw new ContractError(simulation.error);
      }

      if (simulation.result) {
        return scValToNative(simulation.result.retval) as boolean;
      }
      return false;
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async getPrompt(promptId: bigint): Promise<ContractPrompt> {
    try {
      const call = this.contract.call('get_prompt', nativeToScVal(promptId, { type: 'u64' }));
      
      // Simulate with a random source for read-only
      const simulation = await this.rpc.simulateTransaction(
        new TransactionBuilder(new rpc.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"), {
          fee: '100',
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(call)
          .setTimeout(TimeoutInfinite)
          .build()
      );

      if (rpc.Api.isSimulationError(simulation)) {
        throw new ContractError(simulation.error);
      }

      if (simulation.result) {
        return scValToNative(simulation.result.retval) as ContractPrompt;
      }
      throw new ContractError('No result from simulation');
    } catch (e) {
      throw normalizeError(e);
    }
  }
}
