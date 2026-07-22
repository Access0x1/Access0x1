"""The IAgentPayer contract and its data shapes (Python twin).

IAgentPayer is the payment LEG only: given a resource, it discovers an x402 402
challenge, settles it through the Access0x1 rail, and returns the paid result. It is
not an agent runtime and decides nothing about WHAT to fetch. The identical contract
exists in the TypeScript twin (``x402-client``); see ``PARITY.md``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence, Tuple, runtime_checkable

__all__ = [
    "HttpResponse",
    "Transport",
    "PaymentChallenge",
    "PayerRequestInit",
    "SettleRequest",
    "PaymentSettlement",
    "PaymentOutcome",
    "IAgentPayer",
]


@dataclass(frozen=True)
class HttpResponse:
    """A minimal transport response: status + headers + raw body bytes.

    Transport-agnostic so the payer works over the stdlib ``urllib`` default, ``httpx``,
    or a pure in-memory stub, with no third-party dependency in the library itself.
    """

    status: int
    headers: Mapping[str, str]
    body: bytes

    def text(self) -> str:
        """Decode the body as UTF-8 text (lossy on invalid bytes)."""
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """Parse the body as JSON, or ``None`` when empty. Raises on invalid JSON."""
        if not self.body:
            return None
        return json.loads(self.body.decode("utf-8"))


# A transport: (method, url, headers, json_body) -> HttpResponse. ``json_body`` is a
# JSON-serializable value for POSTs, or ``None`` for a bodyless GET.
Transport = Callable[[str, str, Optional[Mapping[str, str]], Any], HttpResponse]


@dataclass(frozen=True)
class PaymentChallenge:
    """A parsed, validated x402 challenge (the 402 payment-required response body).

    "Validated" means the body is a JSON object carrying a non-empty ``accepts`` list —
    the x402 v1 signal that this is a genuine payment challenge. Individual requirement
    entries are surfaced AS PROVIDED by the (untrusted) resource server, as plain dicts;
    they are not field-validated. Treat their fields defensively.
    """

    accepts: Tuple[Mapping[str, Any], ...]
    x402_version: Optional[int] = None
    error: Optional[str] = None
    raw: Any = None


@dataclass(frozen=True)
class PayerRequestInit:
    """Options for a single :meth:`IAgentPayer.fetch` call.

    ``price_per_call_usd`` is forwarded to the rail as ``pricePerCallUsd``; the rail's
    meter is the budget authority — this is a per-call ceiling, not a client wallet.
    """

    method: str = "GET"
    headers: Optional[Mapping[str, str]] = None
    body: Optional[str] = None
    price_per_call_usd: Optional[float] = None


@dataclass(frozen=True)
class SettleRequest:
    """A direct settle request — the payment leg in isolation.

    Fields map 1:1 to the rail's ``POST /api/agent/pay`` body (``url``, ``count``,
    ``pricePerCallUsd``, ``private``, ``merchant``, ``quoteToken``); nothing is invented.
    Python-side names are snake_case and translated to the wire's camelCase on send.
    """

    url: str
    challenge: Optional[PaymentChallenge] = None
    price_per_call_usd: Optional[float] = None
    count: Optional[int] = None
    private: Optional[bool] = None
    merchant: Optional[str] = None
    quote_token: Optional[str] = None


@dataclass(frozen=True)
class PaymentSettlement:
    """A resolved settlement from the rail's agent-pay endpoint.

    Exactly one of ``result`` / ``results`` is set, depending on whether a nano-loop
    (``count > 1``) was requested.
    """

    paid: bool  # always True
    result: Any = None
    results: Optional[Sequence[Any]] = None
    agent: Optional[str] = None
    raw: Any = None


@dataclass(frozen=True)
class PaymentOutcome:
    """The outcome of :meth:`IAgentPayer.fetch`: paid-and-settled, or unpaid passthrough."""

    paid: bool
    status: int
    result: Any = None
    agent: Optional[str] = None
    challenge: Optional[PaymentChallenge] = None
    settlement: Optional[PaymentSettlement] = None


@runtime_checkable
class IAgentPayer(Protocol):
    """The minimal payment leg an agent runtime uses to pay through the Access0x1 rail.

    Two methods, one contract, mirrored in both language twins.
    """

    def fetch(self, url: str, init: Optional[PayerRequestInit] = None) -> PaymentOutcome:
        """Fetch ``url``; pass through a non-402 response, settle a 402 through the rail.

        At most ONE settle attempt — no automatic re-probe (the rail owns its own
        internal x402 pay-and-retry).
        """
        ...

    def settle(self, request: SettleRequest) -> PaymentSettlement:
        """Settle an already-discovered challenge through the rail — the leg in isolation."""
        ...
