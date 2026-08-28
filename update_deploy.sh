#!/bin/bash
awk '
/^  contract-build:/ {
  print "  check-ttl:"
  print "    runs-on: ubuntu-latest"
  print "    steps:"
  print "      - uses: actions/checkout@v4"
  print "      - name: Use Node.js"
  print "        uses: actions/setup-node@v4"
  print "        with:"
  print "          node-version: \"22.x\""
  print "          cache: \"npm\""
  print "          cache-dependency-path: server/package-lock.json"
  print "      - name: Install server dependencies"
  print "        working-directory: server"
  print "        run: npm ci"
  print "      - name: Check Contract TTL"
  print "        working-directory: server"
  print "        run: npm run check-ttl"
  print "        env:"
  print "          PUBLIC_STELLAR_RPC_URL: ${{ secrets.PUBLIC_STELLAR_RPC_URL || '\''https://soroban-testnet.stellar.org'\'' }}"
  print "          PUBLIC_PROMPT_HASH_CONTRACT_ID: ${{ secrets.PUBLIC_PROMPT_HASH_CONTRACT_ID }}"
  print "          PUBLIC_STELLAR_NETWORK: ${{ secrets.PUBLIC_STELLAR_NETWORK || '\''TESTNET'\'' }}"
  print "          PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015""
  print "          PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC""
  print ""
}
{print}
' .github/workflows/deploy.yml > deploy.tmp && mv deploy.tmp .github/workflows/deploy.yml
