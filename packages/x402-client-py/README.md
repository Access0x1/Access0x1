# access0x1-x402-client (Python)

**IAgentPayer** — the minimal client an agent runtime uses to pay for a resource
through the Access0x1 rail via [x402](https://github.com/coinbase/x402). It is the
**payment leg only**. This is the Python twin of the TypeScript
`@access0x1/x402-client`: same contract, same 402 detection, same retry semantics, same
error taxonomy (see `PARITY.md`).

**Zero third-party runtime dependencies** — the library uses only the standard library
(`urllib`, `json`). Inject any transport (an `httpx`-backed callable, an in-memory stub)
with the same shape.

## Install

```sh
pip install access0x1-x402-client
```

## Usage

```python
from x402_client import Access0x1Payer, PayerRequestInit

# All configuration is explicit — the library reads no ambient env.
payer = Access0x1Payer(base_url="https://pay.example.com", caller_auth="…optional…")

out = payer.fetch("https://api.example.com/premium")
if out.paid:
    print("paid by", out.agent, "->", out.result)
else:
    print("no payment needed:", out.status, out.result)
```

### Settle in isolation / nano-loop

```python
from x402_client import SettleRequest

settlement = payer.settle(SettleRequest(url=url, challenge=challenge, price_per_call_usd=0.001))
loop = payer.settle(SettleRequest(url=url, count=25, price_per_call_usd=0.001))
```

### Inject a custom transport

```python
import httpx
from x402_client import Access0x1Payer
from x402_client.types import HttpResponse

def httpx_transport(method, url, headers, json_body):
    r = httpx.request(method, url, headers=headers, json=json_body)
    return HttpResponse(status=r.status_code, headers=dict(r.headers), body=r.content)

payer = Access0x1Payer(base_url="https://pay.example.com", transport=httpx_transport)
```

## Error taxonomy

Every non-success money-path answer is **surfaced, never swallowed**:

| Error | Cause |
| --- | --- |
| `MalformedChallengeError` | A 402 whose body is not a valid x402 challenge — refuse, never reach the rail. |
| `BudgetExceededError` | The rail rejected the spend on budget (`spent`, `cap`). |
| `HumanGateRequiredError` | The rail requires a verified human. |
| `PaymentUnresolvedError` | The rail could not resolve the challenge. |
| `PaymentRailError` | Any other structured rail failure (`status`, `code`, `detail`). |

## AP2 mandate (optional)

`derive_mandate` calls the rail's `POST /api/ap2/mandate` to express an on-chain
SessionGrant as an AP2 mandate chain. It **moves no money**. Heed the returned
`on_chain_truth` and re-verify the SessionGrant on-chain before trusting a mandate.

## Develop

```sh
python -m pytest        # 26 tests, stub transport — no network
```

## License

MIT.
