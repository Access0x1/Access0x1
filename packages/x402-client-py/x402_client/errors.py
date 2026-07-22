"""The payment-leg error taxonomy shared by every IAgentPayer.

Both language twins (Python here, TypeScript in ``x402-client``) raise the SAME
error kinds with the SAME meaning, so a runtime that switches languages keeps
identical failure handling (see ``PARITY.md``). Every error is a distinct class so a
caller can branch on ``except``; the payer NEVER swallows a money-path failure.
"""

from __future__ import annotations

from typing import Any, Optional

__all__ = [
    "X402ClientError",
    "MalformedChallengeError",
    "BudgetExceededError",
    "HumanGateRequiredError",
    "PaymentUnresolvedError",
    "PaymentRailError",
]


class X402ClientError(Exception):
    """Base class for every error the x402 client raises.

    Not raised directly — catch a concrete subclass, or this base to catch them all.
    """


class MalformedChallengeError(X402ClientError):
    """A 402 whose body is not a valid x402 challenge (no non-empty ``accepts`` array).

    The payer REFUSES to pay a 402 it cannot recognize — it never blindly settles an
    unknown challenge, and never reaches the rail.
    """

    def __init__(self, message: str, body: Any) -> None:
        """Create the error.

        Args:
            message: why the challenge was rejected.
            body: the raw 402 body that failed validation, kept for diagnostics.
        """
        super().__init__(message)
        self.body = body


class BudgetExceededError(X402ClientError):
    """The rail rejected the payment because the daily budget cap would be exceeded.

    Maps the rail's ``402 {"error": "BudgetExceeded", "spent", "cap"}``. Surfaced, never
    swallowed, so an agent stops spending instead of silently retrying into the cap.
    """

    def __init__(self, spent: Optional[float] = None, cap: Optional[float] = None) -> None:
        """Create the error.

        Args:
            spent: the rail's reported cumulative spend this window.
            cap: the rail's reported daily cap.
        """
        super().__init__(f"BudgetExceeded: spent={spent} cap={cap}")
        self.spent = spent
        self.cap = cap


class HumanGateRequiredError(X402ClientError):
    """The rail requires a verified human behind the agent before it will spend.

    Maps the rail's ``402 {"error": "HumanGateRequired"}``. Distinct from
    :class:`BudgetExceededError` so a caller can route the human through verification
    rather than treat it as over-spend.
    """

    def __init__(self) -> None:
        super().__init__("HumanGateRequired: the rail requires a verified human for this agent")


class PaymentUnresolvedError(X402ClientError):
    """The payment leg ran but the challenge was never resolved.

    Maps the rail's ``502 {"error": "PaymentRequiredUnresolved"}``: the resource still
    answered 402 after the rail attempted settlement. The rail refunds the reservation.
    """

    def __init__(self, url: str) -> None:
        """Create the error.

        Args:
            url: the resource URL that stayed 402 after payment.
        """
        super().__init__(f"PaymentUnresolved: {url} still returned 402 after payment")
        self.url = url


class PaymentRailError(X402ClientError):
    """Any other structured, non-success answer from the rail.

    Covers ``400 BadRequest``, ``401 Unauthorized``, ``500 Internal``,
    ``503 not_configured``, ``502 PrivatePayFailed``, or a ``200`` without ``ok: true``.
    Carries the HTTP status and the rail's own error code so nothing is hidden.
    """

    def __init__(
        self,
        status: int,
        code: str,
        detail: Optional[str] = None,
        body: Any = None,
    ) -> None:
        """Create the error.

        Args:
            status: the HTTP status the rail returned.
            code: the rail's ``error`` code.
            detail: the rail's ``reason``/``code`` detail, when present.
            body: the full parsed rail body, for diagnostics.
        """
        suffix = f" — {detail}" if detail else ""
        super().__init__(f"PaymentRailError: {status} {code}{suffix}")
        self.status = status
        self.code = code
        self.detail = detail
        self.body = body
