#!/usr/bin/env bash
# Start fresh local chain: wipe old data, re-init genesis, run mining node.
# Run from P2PBC2026Project/ :  ./scripts/start_chain.sh
set -euo pipefail

# move to project root (parent of scripts/) regardless of where invoked
cd "$(dirname "$0")/.."

ACCOUNT=0xd278d247A52C550508ea2b2C9321d816238fb523

echo ">> removedb (wipe old chain data)"
# removedb prompts y/N for chaindata and ancient db -> auto-confirm
printf 'y\ny\n' | geth --datadir data removedb

echo ">> init genesis"
geth --datadir data init project2526genesis.json

echo ">> start node (mining)"
exec geth --datadir data --networkid 202526 \
  --http --http.api eth,net,web3,personal,debug,admin \
  --http.corsdomain '*' --allow-insecure-unlock \
  --nodiscover --maxpeers 0 \
  --mine --miner.gaslimit 30000000 \
  --miner.etherbase "$ACCOUNT" \
  --unlock "$ACCOUNT" \
  --password "${ACCOUNT}psw.txt"
