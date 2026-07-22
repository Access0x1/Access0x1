"""Behavioural tests for Access0x1Payer — the same four scenarios as the TypeScript twin.

happy path (402 -> pay -> retry), insufficient-budget surfaced, malformed-402 guard,
no-payment-needed passthrough, plus the error taxonomy and settle nano-loop.
"""

from __future__ import annotations

import pytest

from x402_client import (
    Access0x1Payer,
    BudgetExceededError,
    HumanGateRequiredError,
    MalformedChallengeError,
    PaymentChallenge,
    PaymentRailError,
    PaymentUnresolvedError,
    PayerRequestInit,
    SettleRequest,
)

RESOURCE = "https://api.example.com/premium"
BASE = "https://pay.example.com"
PAY_URL = BASE + "/api/agent/pay"

CHALLENGE = {
    "x402Version": 1,
    "error": "X-PAYMENT header is required",
    "accepts": [
        {
            "scheme": "exact",
            "network": "base-sepolia",
            "maxAmountRequired": "10000",
            "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            "resource": RESOURCE,
            "description": "Premium data",
            "maxTimeoutSeconds": 60,
        }
    ],
}


def test_happy_path_discovers_settles_returns_result(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, CHALLENGE)
        if url == PAY_URL:
            return json_response(200, {"ok": True, "result": {"data": "premium-payload"}, "agent": "0xAgent"})
        raise AssertionError(f"unexpected url {url}")

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, caller_auth="s3cret", transport=transport)

    out = payer.fetch(RESOURCE)

    assert out.paid is True
    assert out.status == 200
    assert out.result == {"data": "premium-payload"}
    assert out.agent == "0xAgent"
    assert out.challenge is not None
    assert out.challenge.accepts[0]["network"] == "base-sepolia"

    # Probe first, then settle — exactly two calls, in order.
    assert [c["url"] for c in transport.calls] == [RESOURCE, PAY_URL]
    # The rail body carries only the real endpoint field `url` — nothing invented.
    assert transport.calls[1]["json_body"] == {"url": RESOURCE}
    # Caller-auth is attached as x-internal-secret.
    assert transport.calls[1]["headers"]["x-internal-secret"] == "s3cret"


def test_surfaces_insufficient_budget_never_swallowed(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, CHALLENGE)
        return json_response(402, {"error": "BudgetExceeded", "spent": 5, "cap": 5})

    payer = Access0x1Payer(base_url=BASE, transport=stub_transport(handler))
    with pytest.raises(BudgetExceededError) as excinfo:
        payer.fetch(RESOURCE)
    assert excinfo.value.spent == 5
    assert excinfo.value.cap == 5


def test_guards_malformed_402_never_calls_rail(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, {"message": "please pay"})  # no accepts
        raise AssertionError(f"unexpected url {url}")

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)
    with pytest.raises(MalformedChallengeError):
        payer.fetch(RESOURCE)
    assert [c["url"] for c in transport.calls] == [RESOURCE]


def test_passthrough_non_402_unpaid(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(200, {"hello": "world"})
        raise AssertionError(f"unexpected url {url}")

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)
    out = payer.fetch(RESOURCE)
    assert out.paid is False
    assert out.status == 200
    assert out.result == {"hello": "world"}
    assert [c["url"] for c in transport.calls] == [RESOURCE]


def test_human_gate_maps_to_error(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, CHALLENGE)
        return json_response(402, {"error": "HumanGateRequired"})

    payer = Access0x1Payer(base_url=BASE, transport=stub_transport(handler))
    with pytest.raises(HumanGateRequiredError):
        payer.fetch(RESOURCE)


def test_unresolved_502_maps_to_error(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, CHALLENGE)
        return json_response(502, {"error": "PaymentRequiredUnresolved"})

    payer = Access0x1Payer(base_url=BASE, transport=stub_transport(handler))
    with pytest.raises(PaymentUnresolvedError):
        payer.fetch(RESOURCE)


def test_omits_caller_auth_and_forwards_price(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, CHALLENGE)
        return json_response(200, {"ok": True, "result": {"ok": 1}, "agent": "0xA"})

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)
    payer.fetch(RESOURCE, PayerRequestInit(price_per_call_usd=0.002))
    assert "x-internal-secret" not in transport.calls[1]["headers"]
    assert transport.calls[1]["json_body"] == {"url": RESOURCE, "pricePerCallUsd": 0.002}


def test_settle_forwards_nano_loop_count_and_returns_results(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        return json_response(200, {"ok": True, "results": [{"i": 0}, {"i": 1}, {"i": 2}], "agent": "0xAgent"})

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)
    settlement = payer.settle(SettleRequest(url=RESOURCE, count=3, price_per_call_usd=0.001))
    assert settlement.results is not None
    assert len(settlement.results) == 3
    assert settlement.result is None
    assert transport.calls[0]["json_body"] == {"url": RESOURCE, "count": 3, "pricePerCallUsd": 0.001}


def test_settle_surfaces_generic_rail_error(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        return json_response(400, {"error": "BadRequest", "reason": "url not in allowlist"})

    payer = Access0x1Payer(base_url=BASE, transport=stub_transport(handler))
    with pytest.raises(PaymentRailError) as excinfo:
        payer.settle(SettleRequest(url=RESOURCE))
    assert excinfo.value.status == 400
    assert excinfo.value.code == "BadRequest"
    assert excinfo.value.detail == "url not in allowlist"


def test_settle_refuses_supplied_malformed_challenge(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        return json_response(200, {"ok": True, "result": {}})

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)
    malformed = PaymentChallenge(accepts=(), raw={"accepts": []})
    with pytest.raises(MalformedChallengeError):
        payer.settle(SettleRequest(url=RESOURCE, challenge=malformed))
    assert transport.calls == []


def test_settle_requires_url(stub_transport, json_response) -> None:
    payer = Access0x1Payer(base_url=BASE, transport=stub_transport(lambda m, u, b: json_response(200, {"ok": True})))
    with pytest.raises(ValueError):
        payer.settle(SettleRequest(url=""))


def test_default_transport_is_urllib() -> None:
    # No transport injected → the payer wires the stdlib urllib transport (zero deps).
    from x402_client.payer import urllib_transport

    payer = Access0x1Payer(base_url=BASE)
    assert payer._transport is urllib_transport  # type: ignore[attr-defined]


def test_constructor_requires_base_url() -> None:
    with pytest.raises(ValueError):
        Access0x1Payer(base_url="")


def test_trailing_slash_stripped(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == RESOURCE:
            return json_response(402, CHALLENGE)
        return json_response(200, {"ok": True, "result": 1})

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE + "/", transport=transport)
    payer.fetch(RESOURCE)
    assert transport.calls[1]["url"] == PAY_URL


def test_non_json_402_text_body_is_malformed(stub_transport, text_response) -> None:
    # A 402 whose body is not JSON is a malformed challenge — refuse, never call the rail.
    def handler(method, url, json_body):
        return text_response(402, "402 Payment Required")

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)
    with pytest.raises(MalformedChallengeError):
        payer.fetch(RESOURCE)
    assert [c["url"] for c in transport.calls] == [RESOURCE]
