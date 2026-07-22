"""x402_client — the minimal client an agent runtime uses to pay through the Access0x1 rail via x402.

IAgentPayer is the payment leg: it discovers the 402 challenge, settles it through the
rail, and returns the paid result. This package is the Python twin of the TypeScript
``@access0x1/x402-client`` — same contract, same 402 detection, same retry semantics,
same error taxonomy (see ``PARITY.md``).
"""

from __future__ import annotations

from .challenge import parse_challenge
from .errors import (
    BudgetExceededError,
    HumanGateRequiredError,
    MalformedChallengeError,
    PaymentRailError,
    PaymentUnresolvedError,
    X402ClientError,
)
from .mandate import (
    CartInput,
    CartItem,
    MandateRequest,
    MandateResult,
    PaymentInput,
    SessionGrantAuthorization,
)
from .payer import Access0x1Payer, urllib_transport
from .types import (
    HttpResponse,
    IAgentPayer,
    PaymentChallenge,
    PaymentOutcome,
    PaymentSettlement,
    PayerRequestInit,
    SettleRequest,
    Transport,
)

__version__ = "0.1.0"

__all__ = [
    "Access0x1Payer",
    "urllib_transport",
    "IAgentPayer",
    "parse_challenge",
    "PaymentChallenge",
    "PayerRequestInit",
    "SettleRequest",
    "PaymentSettlement",
    "PaymentOutcome",
    "HttpResponse",
    "Transport",
    "SessionGrantAuthorization",
    "CartInput",
    "CartItem",
    "PaymentInput",
    "MandateRequest",
    "MandateResult",
    "X402ClientError",
    "MalformedChallengeError",
    "BudgetExceededError",
    "HumanGateRequiredError",
    "PaymentUnresolvedError",
    "PaymentRailError",
]
