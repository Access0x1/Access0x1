"""Shared fixtures for the NameMath.vy conformance suite.

The contract is loaded with titanoboa (the engine moccasin/`mox test` uses). NameMath is a pure
math library: no constructor args, no state, no money — so a single module-scoped deploy is reused
across every test.
"""

import os

import boa
import pytest

# Path to the Vyper source, resolved relative to the project root (the `vyper/` dir) so the suite
# runs the same whether invoked as `mox test` or `pytest` from `vyper/`.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.normpath(os.path.join(_HERE, "..", "src", "NameMath.vy"))


@pytest.fixture(scope="module")
def name_math():
    """The deployed Vyper NameMath demonstrator."""
    return boa.load(_SRC)
