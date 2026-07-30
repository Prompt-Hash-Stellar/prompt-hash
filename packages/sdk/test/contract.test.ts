import { describe, it, expect, vi } from 'vitest';
import { PromptHashContractClient } from '../src/contract.js';

describe('PromptHashContractClient', () => {
  it('initializes with config', () => {
    const client = new PromptHashContractClient({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractId: 'CACABC123...'
    });
    expect(client).toBeDefined();
  });

  it('builds a transaction successfully (mocked)', async () => {
    const client = new PromptHashContractClient({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractId: 'CACABC123...'
    });

    // Mock the RPC call to getAccount
    vi.spyOn(client['rpc'], 'getAccount').mockResolvedValue({
      accountId: () => 'GB...',
      sequenceNumber: () => '1',
      incrementSequenceNumber: () => {},
    } as any);

    const tx = await client.buildUpdatePriceTx(
      'GB...',
      'GB...',
      1n,
      10000000n
    );
    expect(tx).toBeDefined();
  });
});
