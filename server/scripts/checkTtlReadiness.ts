import { rpc, Contract } from "@stellar/stellar-sdk";
import { stellarConfig } from "../src/config/stellar";

const CRITICAL_TTL_THRESHOLD = 7 * 17280; // 7 days in ledgers

async function checkTTL() {
    const rpcUrl = stellarConfig.PUBLIC_STELLAR_RPC_URL;
    const contractId = stellarConfig.PUBLIC_PROMPT_HASH_CONTRACT_ID;

    if (!contractId) {
        console.log("No CONTRACT_ID provided, skipping TTL check.");
        process.exit(0);
    }
    
    // Validate length and prefix
    if (!contractId.startsWith("C") || contractId.length !== 56) {
        console.warn(`Contract ID ${contractId} seems invalid. Skipping TTL check.`);
        process.exit(0);
    }

    try {
        console.log(`Checking TTL readiness for contract ${contractId} on ${rpcUrl}`);
        const server = new rpc.Server(rpcUrl);
        const contract = new Contract(contractId);
        
        // Use getLedgerEntries to fetch the instance's liveUntilLedgerSeq
        const footprint = contract.getFootprint();
        const response = await server.getLedgerEntries(footprint);
        
        if (!response.entries || response.entries.length === 0) {
            console.warn("Contract not found on network. It might not be deployed yet.");
            process.exit(0);
        }

        const entry = response.entries[0];
        const latestLedger = await server.getLatestLedger();
        
        // Ensure liveUntilLedgerSeq is parsed
        const liveUntil = entry.liveUntilLedgerSeq;
        
        if (!liveUntil) {
            console.warn("Could not determine liveUntilLedgerSeq. Skipping TTL check.");
            process.exit(0);
        }

        const ttl = liveUntil - latestLedger.sequence;
        console.log(`Current Contract Instance TTL: ${ttl} ledgers`);

        if (ttl < CRITICAL_TTL_THRESHOLD) {
            console.error(`\n[CRITICAL] Contract instance TTL is critically low (${ttl} ledgers)!`);
            console.error(`It is below the operational threshold of ${CRITICAL_TTL_THRESHOLD} ledgers.`);
            console.error(`\nRemediation Command:`);
            console.error(`Run the following command to bump the TTL before continuing deployment:`);
            console.error(`\tsoroban contract bump --id ${contractId} --network ${stellarConfig.PUBLIC_STELLAR_NETWORK.toLowerCase()} --source admin --ledgers-to-expire 518400\n`);
            process.exit(1);
        }
        
        console.log("TTL is above operational threshold. Readiness check passed.");
        
    } catch (e) {
        console.error("Failed to check TTL:", e);
        // Do not fail if RPC is down, fail only if TTL is proven low to avoid blocking fresh deploys due to network issues
        process.exit(0); 
    }
}

checkTTL();
