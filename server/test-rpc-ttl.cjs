const { rpc, Contract } = require('@stellar/stellar-sdk');
const server = new rpc.Server('https://soroban-testnet.stellar.org');
const contractId = 'CBUC2V5X2T2M52Y5Z7GZJ4Q3U5Q7XY3Z3QYXY2B6X7WYH23O7B34XFZX'; 
const contract = new Contract(contractId);
async function test() {
    try {
        const res = await server.getLedgerEntries(contract.getFootprint());
        console.log(JSON.stringify(res, null, 2));
    } catch(e) { console.error(e) }
}
test();
