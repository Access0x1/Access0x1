import { LinkCard } from '@access0x1/web'

// components/pages/DashboardView.tsx's real post-registration usage:
// <LinkCard result={justRegistered} />, where `justRegistered` is the
// RegisterResult a merchant gets right after RegisterForm.tsx submits —
// name defaults to the form's own "Acme Coffee" placeholder pattern,
// priceUsd defaults to its '29.00' initial state.
export const Default = () => (
  <div style={{ maxWidth: 420 }}>
    <LinkCard
      result={{
        merchantId: 3n,
        txHash: '0xa3d51b27ff9a11b93424c5c7a9dd07a58a1f1262c5be3f119ab082136d78f589',
        name: 'Acme Coffee',
        priceUsd: '29.00',
        chainId: 84532,
      }}
    />
  </div>
)

// The same card settling on Arc (5042002) — the flagship gas-free chain,
// which has no verifiable block explorer, so the footer tx line falls back
// to the full hash as selectable text (TxHashLink's `full` no-explorer path).
export const ArcTestnet = () => (
  <div style={{ maxWidth: 420 }}>
    <LinkCard
      result={{
        merchantId: 12n,
        txHash: '0x8cdbfec7278e4274bea147553e2aa65fa6644665df60ef8093d8d36b096eaab5',
        name: 'Nomad Roasters',
        priceUsd: '15.00',
        chainId: 5042002,
      }}
    />
  </div>
)
