"""Tests for the optional AP2 mandate-derivation capability (Python twin)."""

from __future__ import annotations

import pytest

from x402_client import (
    Access0x1Payer,
    CartInput,
    CartItem,
    MandateRequest,
    PaymentInput,
    PaymentRailError,
    SessionGrantAuthorization,
)

BASE = "https://pay.example.com"
MANDATE_URL = BASE + "/api/ap2/mandate"

GRANT = SessionGrantAuthorization(
    session_id="0xabc0000000000000000000000000000000000000000000000000000000000001",
    owner="0x1111111111111111111111111111111111111111",
    delegate="0x2222222222222222222222222222222222222222",
    token="0x3333333333333333333333333333333333333333",
    budget_cap="1000000",
    spent="0",
    expiry=1893456000,
    nonce=1,
    chain_id=5042002,
)

GRANT_WIRE = {
    "sessionId": GRANT.session_id,
    "owner": GRANT.owner,
    "delegate": GRANT.delegate,
    "token": GRANT.token,
    "budgetCap": "1000000",
    "expiry": 1893456000,
    "nonce": 1,
    "chainId": 5042002,
    "spent": "0",
}


def test_derives_intent_mandate_and_surfaces_on_chain_truth(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        if url == MANDATE_URL:
            return json_response(
                200,
                {
                    "ok": True,
                    "mandates": {"intent": {"id": "urn:intent:1"}},
                    "note": "Mandates carry an UNSIGNED proof stub.",
                    "onChainTruth": "DERIVED, NOT AUTHORITATIVE: re-verify the SessionGrant on-chain.",
                },
            )
        raise AssertionError(f"unexpected url {url}")

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, caller_auth="sek", transport=transport)

    res = payer.derive_mandate(MandateRequest(grant=GRANT))
    assert "DERIVED, NOT AUTHORITATIVE" in res.on_chain_truth
    assert res.mandates == {"intent": {"id": "urn:intent:1"}}
    # The request body carries the exact camelCase `grant` shape — no invented fields.
    assert transport.calls[0]["json_body"] == {"grant": GRANT_WIRE}
    assert transport.calls[0]["headers"]["x-internal-secret"] == "sek"


def test_forwards_cart_and_payment(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        return json_response(200, {"ok": True, "mandates": {}, "linksValid": True, "onChainTruth": "x"})

    transport = stub_transport(handler)
    payer = Access0x1Payer(base_url=BASE, transport=transport)

    cart = CartInput(
        merchant_id="m1",
        items=[CartItem(name="API call", quantity=1, unit_price="1000")],
        total_amount="1000",
    )
    payment = PaymentInput(
        network="eip155:5042002",
        asset="0x3600000000000000000000000000000000000000",
        amount="1000",
        pay_to="0x4444444444444444444444444444444444444444",
        scheme="exact",
    )
    res = payer.derive_mandate(MandateRequest(grant=GRANT, cart=cart, payment=payment))
    assert res.links_valid is True
    assert transport.calls[0]["json_body"] == {
        "grant": GRANT_WIRE,
        "cart": {
            "merchantId": "m1",
            "items": [{"name": "API call", "quantity": 1, "unitPrice": "1000"}],
            "totalAmount": "1000",
        },
        "payment": {
            "network": "eip155:5042002",
            "asset": "0x3600000000000000000000000000000000000000",
            "amount": "1000",
            "payTo": "0x4444444444444444444444444444444444444444",
            "scheme": "exact",
        },
    }


def test_mandate_400_raises_rail_error(stub_transport, json_response) -> None:
    def handler(method, url, json_body):
        return json_response(400, {"error": "BadRequest", "reason": "grant.owner must be a 0x address"})

    payer = Access0x1Payer(base_url=BASE, transport=stub_transport(handler))
    with pytest.raises(PaymentRailError):
        payer.derive_mandate(MandateRequest(grant=GRANT))
