"""x402 402-challenge discovery + the malformed-challenge guard (Python twin)."""

from __future__ import annotations

from typing import Any

from .errors import MalformedChallengeError
from .types import PaymentChallenge

__all__ = ["parse_challenge"]


def parse_challenge(body: Any) -> PaymentChallenge:
    """Parse and validate an x402 402 response body into a :class:`PaymentChallenge`.

    Discovery rule (x402 v1): a genuine challenge is a JSON object carrying a non-empty
    ``accepts`` list of objects. Anything else — a plain-text 402, an empty or missing
    ``accepts``, a non-object body, a non-object ``accepts`` entry — is rejected with
    :class:`MalformedChallengeError`. This is the guard that stops the payer from
    settling a 402 it cannot recognize (e.g. a generic "402 Payment Required" from an
    unrelated server): a malformed challenge NEVER reaches the rail.

    Args:
        body: the parsed 402 response body (a JSON value, or a string if not JSON).

    Returns:
        The validated challenge.

    Raises:
        MalformedChallengeError: when ``body`` is not a valid x402 challenge.
    """
    if not isinstance(body, dict):
        raise MalformedChallengeError("402 body is not a JSON object", body)
    accepts = body.get("accepts")
    if not isinstance(accepts, list) or len(accepts) == 0:
        raise MalformedChallengeError("402 body has no non-empty `accepts` array", body)
    for entry in accepts:
        if not isinstance(entry, dict):
            raise MalformedChallengeError("`accepts` contains a non-object entry", body)

    raw_version = body.get("x402Version")
    # bool is a subclass of int in Python — exclude it explicitly.
    x402_version = raw_version if isinstance(raw_version, int) and not isinstance(raw_version, bool) else None
    error = body.get("error") if isinstance(body.get("error"), str) else None
    return PaymentChallenge(
        accepts=tuple(accepts),
        x402_version=x402_version,
        error=error,
        raw=body,
    )
