import { FundButton } from '@access0x1/web'

// components/CheckoutCard.tsx wires both seams from public env config
// (isOnrampPublicConfigured / isBlinkPublicConfigured) plus its own busy/note
// state. __tests__/FundButton.test.tsx pins the same four configurations —
// mirrored here as the real prop shapes rather than invented ones.
const noop = () => {}

export const BankOnly = () => (
  <FundButton showBank onFundWithBank={noop} />
)

export const OneTapOnly = () => (
  <FundButton showOneTap onOneTapDeposit={noop} />
)

export const BothConfigured = () => (
  <FundButton showBank showOneTap onFundWithBank={noop} onOneTapDeposit={noop} />
)

// CheckoutCard sets `busy` while a funding session is opening and surfaces a
// fail-soft `note` when the seam rejects (e.g. the on-ramp session 503s) —
// the honest-copy branch from handleFundWithBank's catch path.
export const BusyWithNote = () => (
  <FundButton
    showBank
    showOneTap
    onFundWithBank={noop}
    onOneTapDeposit={noop}
    busy
    note="Bank funding is not configured yet."
  />
)
