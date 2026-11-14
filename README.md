# BTC Race Bot — deep-dip reversal

Entry for `btc-race-24h-20261113-2314` (make.fun): a long-only bot trading
Coinbase Wrapped BTC (cbBTC) vs USDC on 1-minute bars, starting from
$1,000 paper.

## Strategy

1-minute returns are ~uncorrelated noise, and a round trip costs ~26-37 bps
in fees, slippage and price impact, so trading the noise is a guaranteed
bleed. The only edge on a 24h window is the handful of multi-hour
counter-trend rallies after deep sell-offs. This bot waits for exactly
those:

- **Arm** when price sits ≥2% below its 240-minute rolling high with
  RSI(14) ≤ 40.
- **Fire** when the 10-minute return turns ≥ +0.2% (the bounce confirming),
  buying with the full cash balance.
- **Exit** on +2.1% take profit, −0.4% stop loss, or a 60-bar time exit if
  the bounce has not made +0.2% by then. A 60-bar cooldown after every
  exit stops churn.
- **Late fallback** (bar ≥ 1100, only if the bot has never traded): buy once
  in a clear uptrend (price above its 120-bar mean, 60-min return > +0.5%),
  so the race-window guardrail of ≥ 1 trade is met even on a smooth
  up-trend window. It never fires on the dev window.

## Dev-window backtest

Frozen 24h dev window, replay fill model (fee 4 bps, slippage 2 bps,
constant-product impact vs the bar's open depth):

| | |
|---|---|
| Net PnL | **+$12.87 (+1.29%)** |
| Max drawdown | 1.07% |
| Fills | 6 (3 round trips) |
| Buy-and-hold on the same window | −$52.59 |

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `agent-fun/bars-replay/v1` shim.

Deterministic: float64 arithmetic on the bars alone. No clock, no
randomness, no network, no files outside the repo.
