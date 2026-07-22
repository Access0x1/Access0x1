# Makefile — the green gate for access0x1-x402-client (the Python twin).
#
# The repo's Solidity and web gates do not cover Python, so this package carries
# its own one-command gate. `make test` runs the offline pytest suite (stub
# transport, no network); `make install` provisions the test dependency in
# editable mode. Wire `make -C packages/x402-client-py test` into CI to keep the
# twin green at merge.

.PHONY: install test

install:
	python -m pip install -e ".[test]"

test:
	python -m pytest
