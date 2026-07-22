"""Types for the AP2/A2A mandate interop surface (``POST /api/ap2/mandate``, Python twin).

The rail DERIVES an AP2 mandate chain (Intent <- Cart <- Payment) from an on-chain
SessionGrant so an AP2-aware counterparty can verify the agent acted within a
user-authorized, bounded, revocable mandate. This endpoint MOVES NO MONEY — it is a
pure wire-format view; the on-chain SessionGrant stays the only authority, and every
response carries a prominent ``on_chain_truth`` caveat the caller MUST heed.

Field names on the WIRE mirror the rail's request contract exactly (grant / cart /
payment / options); Python-side attribute names are snake_case and translated to
camelCase by the ``*_to_dict`` helpers. Deriving a mandate is an OPTIONAL capability
layered on top of the core payment leg — see ``Access0x1Payer.derive_mandate``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence

__all__ = [
    "SessionGrantAuthorization",
    "CartItem",
    "CartInput",
    "PaymentInput",
    "MandateRequest",
    "MandateResult",
    "grant_to_dict",
    "cart_to_dict",
    "payment_to_dict",
]


@dataclass(frozen=True)
class SessionGrantAuthorization:
    """A SessionGrant authorization to express as an AP2 Intent Mandate (rail ``grant``).

    Mirrors the on-chain ``SessionGrant.Session`` fields — every value is read from (or
    derivable from) the chain, so the derived mandate is a faithful view, never a claim.
    Amounts are decimal strings to preserve uint256 precision (never floats).
    """

    session_id: str
    owner: str
    delegate: str
    token: str
    budget_cap: str
    expiry: int
    nonce: int
    chain_id: int
    spent: Optional[str] = None
    revoked: Optional[bool] = None


@dataclass(frozen=True)
class CartItem:
    """One cart line item (rail ``cart.items[]``)."""

    name: str
    quantity: int
    unit_price: str


@dataclass(frozen=True)
class CartInput:
    """Cart inputs to derive a Cart Mandate, bound to the Intent Mandate (rail ``cart``)."""

    merchant_id: str
    items: Sequence[CartItem]
    total_amount: str


@dataclass(frozen=True)
class PaymentInput:
    """x402 rail params to derive a Payment Mandate, bound to the Cart Mandate (rail ``payment``)."""

    network: str
    asset: str
    amount: str
    pay_to: str
    scheme: Optional[str] = None  # only "exact" is meaningful for EIP-3009


@dataclass(frozen=True)
class MandateRequest:
    """Request to :meth:`Access0x1Payer.derive_mandate` (rail ``POST /api/ap2/mandate`` body)."""

    grant: SessionGrantAuthorization
    cart: Optional[CartInput] = None
    payment: Optional[PaymentInput] = None
    options: Optional[Mapping[str, Any]] = None


@dataclass(frozen=True)
class MandateResult:
    """Result of :meth:`Access0x1Payer.derive_mandate`.

    ``mandates`` and ``on_chain_truth`` come straight from the rail; the caller MUST heed
    ``on_chain_truth`` and re-verify the SessionGrant on-chain before trusting any
    derived mandate.
    """

    mandates: Any
    on_chain_truth: str
    links_valid: Optional[bool] = None
    note: Optional[str] = None
    raw: Any = None


def grant_to_dict(grant: SessionGrantAuthorization) -> Dict[str, Any]:
    """Translate a :class:`SessionGrantAuthorization` to the rail's camelCase ``grant`` body."""
    out: Dict[str, Any] = {
        "sessionId": grant.session_id,
        "owner": grant.owner,
        "delegate": grant.delegate,
        "token": grant.token,
        "budgetCap": grant.budget_cap,
        "expiry": grant.expiry,
        "nonce": grant.nonce,
        "chainId": grant.chain_id,
    }
    if grant.spent is not None:
        out["spent"] = grant.spent
    if grant.revoked is not None:
        out["revoked"] = grant.revoked
    return out


def cart_to_dict(cart: CartInput) -> Dict[str, Any]:
    """Translate a :class:`CartInput` to the rail's camelCase ``cart`` body."""
    return {
        "merchantId": cart.merchant_id,
        "items": [
            {"name": item.name, "quantity": item.quantity, "unitPrice": item.unit_price}
            for item in cart.items
        ],
        "totalAmount": cart.total_amount,
    }


def payment_to_dict(payment: PaymentInput) -> Dict[str, Any]:
    """Translate a :class:`PaymentInput` to the rail's camelCase ``payment`` body."""
    out: Dict[str, Any] = {
        "network": payment.network,
        "asset": payment.asset,
        "amount": payment.amount,
        "payTo": payment.pay_to,
    }
    if payment.scheme is not None:
        out["scheme"] = payment.scheme
    return out
