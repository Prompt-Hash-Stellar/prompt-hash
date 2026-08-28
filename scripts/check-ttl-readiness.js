import { rpc, Contract } from '@stellar/stellar-sdk';
import process from 'process';

const RPC_URL = process.env.PUBLIC_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID;

const CRITICAL_TTL_THRESHOLD = 7 * 17280; // 7 days in ledgers

async function checkTTL() {
    if (!CONTRACT_ID) {
        console.log("No CONTRACT_ID provided, skipping TTL check.");
        process.exit(0);
    }
    
    // Validate length and prefix
    if (!CONTRACT_ID.startsWith('C') || CONTRACT_ID.length !== 56) {
        console.warn(`Contract ID ${CONTRACT_ID} seems invalid. Skipping TTL check.`);
        process.exit(0);
    }

    try {
        console.log(`Checking TTL readiness for contract ${CONTRACT_ID} on ${RPC_URL}`);
        const server = new rpc.Server(RPC_URL);
        const contract = new Contract(CONTRACT_ID);
        
        // Use getLedgerEntries to fetch the instance's liveUntilLedgerSeq
        const footprint = contract.getFootprint();
        const response = await server.getLedgerEntries(footprint);
        
        if (!response.entries || response.entries.length === 0) {
            console.warn("Contract not found on network. It might not be deployed yet.");
            process.exit(0);
        }

        const entry = response.entries[0];
        const latestLedger = await server.getLatestLedger();
        const liveUntil = entry.liveUntilLedgerSeq;
        
        const ttl = liveUntil - latestLedger.sequence;
        console.log(`Current Contract Instance TTL: ${ttl} ledgers`);

        if (ttl < CRITICAL_TTL_THRESHOLD) {
            console.error(`\n[CRITICAL] Contract instance TTL is critically low (${ttl} ledgers)!`);
            console.error(`It is below the operational threshold of ${CRITICAL_TTL_THRESHOLD} ledgers.`);
            console.error(`\nRemediation Command:`);
            console.error(`Run the following command to bump the TTL before continuing deployment:`);
            console.error(`\tsoroban contract bump --id ${CONTRACT_ID} --network ${process.env.PUBLIC_STELLAR_NETWORK || 'testnet'} --source admin --ledgers-to-expire 518400\n`);
            process.exit(1);
        }
        
        console.log("TTL is above operational threshold. Readiness check passed.");
        
    } catch (e) {
        console.error("Failed to check TTL:", e);
        // Do not fail if RPC is down, fail only if TTL is proven low
        process.exit(0); 
    }
}

checkTTL();
