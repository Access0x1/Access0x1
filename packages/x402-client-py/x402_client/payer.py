"""Access0x1Payer — the concrete IAgentPayer for the Access0x1 rail (Python twin).

The flow, matching the x402 protocol and the rail's real endpoints:
  1. DISCOVER — fetch the resource once (the natural unpaid x402 request). A non-402
     response passes through unpaid; a 402 body is parsed + validated as an x402
     challenge (:func:`parse_challenge`).
  2. SETTLE — POST the resource URL to the rail's ``/api/agent/pay``, which signs and
     settles the EIP-3009 USDC payment and performs the paid retry internally.
  3. RETURN — surface the rail's ``result`` as the paid resource content.

All configuration is explicit constructor input — the library reads NO ambient env and
depends only on the standard library. The default transport uses ``urllib``; inject any
callable (``httpx``-backed, an in-memory stub) with the same ``Transport`` shape.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from .challenge import parse_challenge
from .errors import (
    BudgetExceededError,
    HumanGateRequiredError,
    PaymentRailError,
    PaymentUnresolvedError,
)
from .types import (
    HttpResponse,
    PaymentOutcome,
    PaymentSettlement,
    PayerRequestInit,
    SettleRequest,
    Transport,
)

__all__ = ["Access0x1Payer", "urllib_transport"]


def urllib_transport(
    method: str,
    url: str,
    headers: Optional[Dict[str, str]],
    json_body: Any,
) -> HttpResponse:
    """Default :data:`Transport`, backed by the stdlib ``urllib`` (zero third-party deps).

    A JSON body is serialized when ``json_body`` is not ``None``. An HTTP error status
    (4xx/5xx — including 402) is caught and returned as an :class:`HttpResponse`, NOT
    raised, so the payer's status handling owns the control flow.
    """
    data = None
    hdrs = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        hdrs.setdefault("content-type", "application/json")
    request = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(request) as resp:  # noqa: S310 - caller supplies the URL
            return HttpResponse(
                status=resp.status,
                headers={k.lower(): v for k, v in resp.headers.items()},
                body=resp.read(),
            )
    except urllib.error.HTTPError as err:  # 402 and every other non-2xx land here.
        raw_headers = err.headers.items() if err.headers else []
        return HttpResponse(
            status=err.code,
            headers={k.lower(): v for k, v in raw_headers},
            body=err.read(),
        )


def _read_body(resp: HttpResponse) -> Any:
    """Read a response body as parsed JSON, falling back to text, then ``None`` when empty."""
    text = resp.text()
    if text == "":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _num_or_none(value: Any) -> Optional[float]:
    """Coerce to a number, or ``None`` when it is not one (bools excluded)."""
    if isinstance(value, bool):
        return None
    return value if isinstance(value, (int, float)) else None


def _str_or_none(value: Any) -> Optional[str]:
    """Coerce to a string, or ``None`` when it is not one."""
    return value if isinstance(value, str) else None


def _str_or(value: Any, fallback: str) -> str:
    """Coerce to a string, falling back to ``fallback`` when it is not one."""
    return value if isinstance(value, str) else fallback


class Access0x1Payer:
    """The concrete IAgentPayer for the Access0x1 rail.

    Construct once per rail deployment and reuse across calls.

    Example:
        >>> payer = Access0x1Payer(base_url="https://pay.example.com")
        >>> out = payer.fetch("https://api.example.com/premium")
        >>> if out.paid:
        ...     print("paid by", out.agent, "->", out.result)
    """

    def __init__(
        self,
        base_url: str,
        caller_auth: Optional[str] = None,
        transport: Optional[Transport] = None,
        pay_path: str = "/api/agent/pay",
        mandate_path: str = "/api/ap2/mandate",
    ) -> None:
        """Create the payer.

        Args:
            base_url: base URL of the Access0x1 rail (trailing slash optional).
            caller_auth: optional shared secret sent as the ``x-internal-secret`` header.
            transport: injected transport; defaults to :func:`urllib_transport`.
            pay_path: agent-pay endpoint path.
            mandate_path: AP2 mandate endpoint path.

        Raises:
            ValueError: when ``base_url`` is missing or empty.
        """
        if not base_url:
            raise ValueError("Access0x1Payer: `base_url` is required")
        self._base_url = base_url.rstrip("/")
        self._caller_auth = caller_auth
        self._transport: Transport = transport or urllib_transport
        self._pay_path = pay_path
        self._mandate_path = mandate_path

    def fetch(self, url: str, init: Optional[PayerRequestInit] = None) -> PaymentOutcome:
        """Fetch ``url``; pass through a non-402 response, settle a 402 through the rail.

        At most ONE settle attempt — no automatic re-probe (the rail owns its own
        internal x402 pay-and-retry).

        Args:
            url: the resource to fetch.
            init: optional probe options + the per-call price ceiling.

        Returns:
            The paid outcome, or an unpaid passthrough.

        Raises:
            MalformedChallengeError: a 402 whose body is not a valid x402 challenge.
            BudgetExceededError: the rail rejected the spend on budget.
            HumanGateRequiredError: the rail requires a verified human.
            PaymentUnresolvedError: the rail could not resolve the challenge.
            PaymentRailError: any other structured rail failure.
        """
        if not url:
            raise ValueError("Access0x1Payer.fetch: `url` is required")
        init = init or PayerRequestInit()
        probe = self._transport(init.method, url, dict(init.headers or {}) or None, None)

        # Non-402 -> unpaid passthrough. The payer takes no view on non-payment
        # statuses; the caller inspects ``status``.
        if probe.status != 402:
            return PaymentOutcome(paid=False, status=probe.status, result=_read_body(probe))

        # 402 -> discover + validate (raises MalformedChallengeError, never reaching the
        # rail, if the body is not a genuine x402 challenge).
        challenge = parse_challenge(_read_body(probe))
        settlement = self.settle(
            SettleRequest(url=url, challenge=challenge, price_per_call_usd=init.price_per_call_usd)
        )
        return PaymentOutcome(
            paid=True,
            status=200,
            result=settlement.result,
            agent=settlement.agent,
            challenge=challenge,
            settlement=settlement,
        )

    def settle(self, request: SettleRequest) -> PaymentSettlement:
        """Settle an already-discovered challenge through the rail — the leg in isolation.

        Args:
            request: the settle request (maps 1:1 to the rail body).

        Returns:
            The resolved settlement.

        Raises:
            Same taxonomy as :meth:`fetch`.
        """
        if not request.url:
            raise ValueError("Access0x1Payer.settle: `url` is required")
        # Re-validate a supplied challenge — refuse to settle a malformed one, even when
        # the caller discovered the 402 themselves.
        if request.challenge is not None:
            source = request.challenge.raw
            if source is None:
                source = {"accepts": list(request.challenge.accepts)}
            parse_challenge(source)

        # Build the rail body from ONLY the fields the endpoint accepts (nothing invented).
        body: Dict[str, Any] = {"url": request.url}
        if request.count is not None:
            body["count"] = request.count
        if request.price_per_call_usd is not None:
            body["pricePerCallUsd"] = request.price_per_call_usd
        if request.private is not None:
            body["private"] = request.private
        if request.merchant is not None:
            body["merchant"] = request.merchant
        if request.quote_token is not None:
            body["quoteToken"] = request.quote_token

        resp = self._post_json(self._pay_path, body)
        return self._map_pay_response(request.url, resp.status, _read_body(resp))

    def _post_json(self, path: str, body: Any) -> HttpResponse:
        """POST a JSON body to a rail path, attaching the caller-auth header when configured."""
        headers: Dict[str, str] = {"content-type": "application/json"}
        if self._caller_auth:
            headers["x-internal-secret"] = self._caller_auth
        return self._transport("POST", self._base_url + path, headers, body)

    def _map_pay_response(self, url: str, status: int, data: Any) -> PaymentSettlement:
        """Map a rail ``/api/agent/pay`` response to a settlement, or raise the matching error.

        Every non-success path raises — the money path is never swallowed into a silent
        success.
        """
        d = data if isinstance(data, dict) else {}

        if status == 200 and d.get("ok") is True:
            return PaymentSettlement(
                paid=True,
                result=d.get("result"),
                results=d.get("results"),
                agent=_str_or_none(d.get("agent")),
                raw=data,
            )
        if status == 402:
            if d.get("error") == "BudgetExceeded":
                raise BudgetExceededError(_num_or_none(d.get("spent")), _num_or_none(d.get("cap")))
            if d.get("error") == "HumanGateRequired":
                raise HumanGateRequiredError()
            raise PaymentRailError(status, _str_or(d.get("error"), "PaymentRequired"), _str_or_none(d.get("reason")), data)
        if status == 502 and d.get("error") == "PaymentRequiredUnresolved":
            raise PaymentUnresolvedError(url)
        # 400 / 401 / 500 / 503 / 502-PrivatePayFailed / a 200 without ok:true — surface it.
        detail = _str_or_none(d.get("reason")) or _str_or_none(d.get("code"))
        raise PaymentRailError(status, _str_or(d.get("error"), "PaymentRailError"), detail, data)
