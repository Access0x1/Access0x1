/**
 * zerog-bootstrap.mjs — operator CLI to go LIVE on 0G Compute (broker mode).
 *
 * The Access0x1 agent lives on Ethereum; this script is the OPERATOR-side tool that funds the 0G
 * broker account which PAYS for the agent's inference. It never handles the agent's identity — only
 * the operator's funded 0G wallet. Run it locally; the private key stays in your shell env.
 *
 * Requires the optional 0G peer deps (kept out of the app's dependencies on purpose):
 *     npm i @0gfoundation/0g-compute-ts-sdk ethers
 *
 * Usage (from repo root or web/):
 *     node web/scripts/zerog-bootstrap.mjs discover                 # list live providers (NO key)
 *     ZEROG_BROKER_PRIVATE_KEY=0x… node web/scripts/zerog-bootstrap.mjs status
 *     ZEROG_BROKER_PRIVATE_KEY=0x… node web/scripts/zerog-bootstrap.mjs fund 2 [providerAddress]
 *     node web/scripts/zerog-bootstrap.mjs env <providerAddress>    # prints .env.local lines
 *
 * SAFETY: the key is read ONLY from ZEROG_BROKER_PRIVATE_KEY and is never printed or written to a
 * file. Use your TESTNET wallet (the one holding 0G testnet tokens) — never a real-money key.
 * Method names verified against @0gfoundation/0g-compute-ts-sdk@0.9.0.
 */

const RPC_URL = (process.env.ZEROG_BROKER_RPC_URL || 'https://evmrpc-testnet.0g.ai').trim()
const SERVICE = 'inference'

/** Dynamically load the optional peer deps with a clear message if they're absent. */
async function loadDeps() {
  try {
    const ethers = await import('ethers')
    const sdk = await import('@0gfoundation/0g-compute-ts-sdk')
    return { ethers: ethers.ethers ?? ethers, sdk }
  } catch {
    console.error(
      '\n[zerog] Missing peer deps. Install them first:\n' +
        '    npm i @0gfoundation/0g-compute-ts-sdk ethers\n',
    )
    process.exit(1)
  }
}

function requireKey() {
  const key = (process.env.ZEROG_BROKER_PRIVATE_KEY || '').trim()
  if (!key) {
    console.error('\n[zerog] Set ZEROG_BROKER_PRIVATE_KEY (your TESTNET wallet key) in your env.\n')
    process.exit(1)
  }
  return key
}

/** Read-only discovery — no key, no funds. Lists providers you can point ZEROG_PROVIDER_ADDRESS at. */
async function discover() {
  const { ethers, sdk } = await loadDeps()
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const broker = await sdk.createZGComputeNetworkReadOnlyBroker(provider)
  const services = await broker.inference.listService()
  if (!services.length) {
    console.log('[zerog] No providers returned by listService().')
    return
  }
  console.log(`[zerog] ${services.length} provider(s) on 0G Compute (${RPC_URL}):\n`)
  for (const s of services) {
    console.log(`  provider: ${s.provider}`)
    console.log(`    model:  ${s.model}`)
    console.log(`    url:    ${s.url}`)
    if (s.verifiability) console.log(`    verifiability: ${s.verifiability}`)
    console.log('')
  }
  console.log('Pick one and: node web/scripts/zerog-bootstrap.mjs env <provider>')
}

async function makeBroker() {
  const { ethers, sdk } = await loadDeps()
  const wallet = new ethers.Wallet(requireKey(), new ethers.JsonRpcProvider(RPC_URL))
  console.log(`[zerog] operator wallet: ${await wallet.getAddress()} @ ${RPC_URL}`)
  return sdk.createZGComputeNetworkBroker(wallet)
}

/** Show the ledger balance and any provider sub-account balances. */
async function status() {
  const broker = await makeBroker()
  try {
    const ledger = await broker.ledger.getLedger()
    console.log('[zerog] ledger:', JSON.stringify(ledger, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  } catch {
    console.log('[zerog] no ledger yet — run: fund <amount> to create one')
  }
  try {
    const funded = await broker.ledger.getProvidersWithBalance(SERVICE)
    console.log('[zerog] provider sub-accounts with balance:')
    for (const [p, bal, pending] of funded) console.log(`  ${p}  balance=${bal}  pendingRefund=${pending}`)
  } catch { /* none */ }
}

/** Create/top-up the ledger, and optionally move funds to a provider sub-account. */
async function fund(amountStr, providerAddress) {
  const amount = Number(amountStr)
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('[zerog] usage: fund <amount-in-0G> [providerAddress]')
    process.exit(1)
  }
  const broker = await makeBroker()
  // Create the ledger on first run, else just deposit.
  try {
    await broker.ledger.getLedger()
    console.log(`[zerog] depositing ${amount} 0G into existing ledger…`)
    await broker.ledger.depositFund(amount)
  } catch {
    console.log(`[zerog] creating ledger with ${amount} 0G…`)
    await broker.ledger.addLedger(amount)
  }
  console.log('[zerog] ledger funded ✓')
  if (providerAddress) {
    console.log(`[zerog] acknowledging + transferring to provider ${providerAddress}…`)
    try { await broker.inference.acknowledgeProviderSigner(providerAddress) } catch { /* already ack'd */ }
    console.log('[zerog] provider acknowledged ✓ (auto-funding covers per-request top-ups)')
  }
  await status()
}

/** Print the .env.local lines to wire the app to a chosen provider. */
function printEnv(providerAddress) {
  if (!providerAddress) {
    console.error('[zerog] usage: env <providerAddress>')
    process.exit(1)
  }
  console.log(
    '\n# --- paste into web/.env.local (gitignored — never commit your key) ---\n' +
      'AI_INFERENCE_PROVIDER=zerog\n' +
      'ZEROG_MODE=broker\n' +
      'ZEROG_BROKER_PRIVATE_KEY=<your testnet wallet key>\n' +
      `ZEROG_PROVIDER_ADDRESS=${providerAddress}\n` +
      `ZEROG_BROKER_RPC_URL=${RPC_URL}\n`,
  )
  console.log('Then: GET /api/ai/infer → {configured:true, provider:"zerog"}, and POST { prompt }.')
}

const [cmd, a, b] = process.argv.slice(2)
const run = {
  discover: () => discover(),
  status: () => status(),
  fund: () => fund(a, b),
  env: () => printEnv(a),
}[cmd]

if (!run) {
  console.log('Usage: zerog-bootstrap.mjs <discover | status | fund <amount> [provider] | env <provider>>')
  process.exit(cmd ? 1 : 0)
}
Promise.resolve(run()).catch((e) => {
  console.error('[zerog] error:', e?.shortMessage || e?.message || e)
  process.exit(1)
})
