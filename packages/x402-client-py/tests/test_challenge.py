"""Unit tests for the x402 challenge parser / malformed-challenge guard."""

from __future__ import annotations

import pytest

from x402_client import MalformedChallengeError, parse_challenge


def test_accepts_valid_x402_challenge() -> None:
    body = {
        "x402Version": 1,
        "error": "X-PAYMENT header is required",
        "accepts": [
            {
                "scheme": "exact",
                "network": "base-sepolia",
                "maxAmountRequired": "10000",
                "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                "resource": "https://api.example.com/premium",
            }
        ],
    }
    challenge = parse_challenge(body)
    assert challenge.x402_version == 1
    assert challenge.error == "X-PAYMENT header is required"
    assert len(challenge.accepts) == 1
    assert challenge.accepts[0]["scheme"] == "exact"
    assert challenge.raw is body


def test_rejects_body_with_no_accepts() -> None:
    with pytest.raises(MalformedChallengeError):
        parse_challenge({"error": "please pay"})


def test_rejects_empty_accepts() -> None:
    with pytest.raises(MalformedChallengeError):
        parse_challenge({"accepts": []})


def test_rejects_non_object_accepts_entry() -> None:
    with pytest.raises(MalformedChallengeError):
        parse_challenge({"accepts": ["not-an-object"]})


def test_rejects_plain_text_body() -> None:
    with pytest.raises(MalformedChallengeError):
        parse_challenge("402 Payment Required")


def test_rejects_none() -> None:
    with pytest.raises(MalformedChallengeError):
        parse_challenge(None)


def test_preserves_raw_body_on_error() -> None:
    with pytest.raises(MalformedChallengeError) as excinfo:
        parse_challenge({"nope": True})
    assert excinfo.value.body == {"nope": True}


def test_ignores_bool_x402_version() -> None:
    # bool is a subclass of int in Python; it must not be treated as a version number.
    challenge = parse_challenge({"x402Version": True, "accepts": [{"scheme": "exact"}]})
    assert challenge.x402_version is None
