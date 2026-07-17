import { ReceiptScreen } from '@access0x1/web'

// components/CheckoutCard.tsx's real post-pay composition:
// <ReceiptScreen receipt={receipt.event} txHash={receipt.txHash} chainId={chainId}
//   tokenSymbol={tokenSymbol} tokenDecimals={tokenDecimals} returnUrl={safeReturn} />.
// __tests__/ReceiptScreen.test.tsx's RECEIPT fixture shape is mirrored here with
// realistic per-story amounts instead of the test's all-zero placeholders.

// Base Sepolia (has a verifiable explorer): a $29.00 USDC (6-decimal) payment,
// with a merchant-supplied `returnUrl` so "Return to merchant" renders.
export const Default = () => (
  <div style={{ maxWidth: 420 }}>
    <ReceiptScreen
      receipt={{
        merchantId: 3n,
        buyer: '0x5b1e0431df9d1274950ecdcfd5f9c015d92d740f',
        token: '0x7e25c68d857232f21625e56e87e2b7fdf2e0cfed',
        grossAmount: 29010000n,
        feeAmount: 0n,
        netAmount: 29010000n,
        usdAmount8: 2900000000n,
        orderId: '0x2f5031e7819d205ecd58249f1864d299a6b8c2c335b7de6d02022eddc27c9537',
        srcChainSelector: 0n,
      }}
      txHash="0x7e73576ff748e863462b12fc97d8432bce9ac2f4d5d1ac3b39e27c5419cb13d0"
      chainId={84532}
      tokenSymbol="USDC"
      tokenDecimals={6}
      returnUrl="https://acmecoffee.example/thanks"
    />
  </div>
)

// The link had no `?return_url=` — the real branch where "Return to merchant"
// is dropped entirely (no href to nowhere).
export const NoReturnUrl = () => (
  <div style={{ maxWidth: 420 }}>
    <ReceiptScreen
      receipt={{
        merchantId: 3n,
        buyer: '0x5b1e0431df9d1274950ecdcfd5f9c015d92d740f',
        token: '0x7e25c68d857232f21625e56e87e2b7fdf2e0cfed',
        grossAmount: 29010000n,
        feeAmount: 0n,
        netAmount: 29010000n,
        usdAmount8: 2900000000n,
        orderId: '0xb03bed31a83f28b57eafff4a487fa3712a0053a32ba03805672f6c90b067215f',
        srcChainSelector: 0n,
      }}
      txHash="0xd31382de2e0d5faa966f08464a82689259804f8654caa9c8a645584f31a49daf"
      chainId={84532}
      tokenSymbol="USDC"
      tokenDecimals={6}
    />
  </div>
)

// Arc (5042002): native USDC is 18-decimal there (the "Arc trap" —
// lib/chains.ts#tokenDecimalsFor), and Arc has no verifiable explorer, so the
// tx line renders as full monospace text instead of a link.
export const ArcNoExplorer = () => (
  <div style={{ maxWidth: 420 }}>
    <ReceiptScreen
      receipt={{
        merchantId: 12n,
        buyer: '0x5b1e0431df9d1274950ecdcfd5f9c015d92d740f',
        token: '0xbda1ce1b3a2c0f0e3b552596442057de7f9a58f7',
        grossAmount: 15005000000000000000n,
        feeAmount: 0n,
        netAmount: 15005000000000000000n,
        usdAmount8: 1500000000n,
        orderId: '0x5143d6289c34d87737e53e8037f29789bbf784c3cbff1b682d46cb38f33094fa',
        srcChainSelector: 0n,
      }}
      txHash="0x5718275470812317bde2d314205ad6d85b0a7ef562bb839c3271dcb5d562c6e7"
      chainId={5042002}
      tokenSymbol="USDC"
      tokenDecimals={18}
      returnUrl="https://nomadroasters.example/thanks"
    />
  </div>
)
