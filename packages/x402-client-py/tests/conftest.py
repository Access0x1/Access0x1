"""Shared pytest fixtures: an in-memory stub transport + response builders.

The stub records every call and returns canned :class:`HttpResponse` objects, so every
payer scenario runs fully offline with zero third-party dependencies (mirrors the
TypeScript twin's mocked ``fetch``).
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

import pytest

from x402_client.types import HttpResponse


def _json_response(status: int, body: Any) -> HttpResponse:
    """Build a JSON :class:`HttpResponse`."""
    return HttpResponse(
        status=status,
        headers={"content-type": "application/json"},
        body=json.dumps(body).encode("utf-8"),
    )


def _text_response(status: int, text: str) -> HttpResponse:
    """Build a plain-text :class:`HttpResponse` (for the non-JSON 402 guard)."""
    return HttpResponse(status=status, headers={"content-type": "text/plain"}, body=text.encode("utf-8"))


class StubTransport:
    """A recording transport: routes (method, url, json_body) -> HttpResponse via a handler."""

    def __init__(self, handler: Callable[[str, str, Any], HttpResponse]) -> None:
        self._handler = handler
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self,
        method: str,
        url: str,
        headers: Optional[Dict[str, str]],
        json_body: Any,
    ) -> HttpResponse:
        self.calls.append({"method": method, "url": url, "headers": headers, "json_body": json_body})
        return self._handler(method, url, json_body)


@pytest.fixture
def json_response() -> Callable[[int, Any], HttpResponse]:
    """Fixture exposing the JSON response builder."""
    return _json_response


@pytest.fixture
def text_response() -> Callable[[int, str], HttpResponse]:
    """Fixture exposing the text response builder."""
    return _text_response


@pytest.fixture
def stub_transport() -> type[StubTransport]:
    """Fixture exposing the :class:`StubTransport` class for per-test handlers."""
    return StubTransport
