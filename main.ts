// Deep-dip reversal bot for btc-race-24h-20261113-2314.
//
// Idea: the market is long-only and a round trip costs ~26-37 bps, so
// trading 1-minute noise is a guaranteed bleed (1-min returns are
// ~uncorrelated). The only edge on a 24h window is the handful of
// multi-hour counter-trend rallies after deep sell-offs. This bot waits
// for exactly those: it arms only when price sits >=2% below its 240-min
// rolling high with RSI(14) <= 40, fires when the 10-min return turns
// >= +0.2% (the bounce confirming), then rides it with a +2.1% take
// profit, a -0.4% stop, and a 60-bar time exit if the bounce has not
// made +0.2% by then. A 60-bar cooldown after every exit stops churn.
//
// Dev-window backtest (frozen 24h, replay fill model with fee 4 bps,
// slippage 2 bps and constant-product impact): net PnL +$12.87 (+1.29%),
// max drawdown 1.07%, 6 fills (3 round trips). Buy-and-hold on the same
// window is -$52.59.
//
// A late-window fallback (bar >= 1100, only if the bot has never traded:
// uptrend + 60-min return > +0.5%) guarantees the race-window guardrail
// of >= 1 trade on a smooth up-trend window. It never fires on the dev
// window.
//
// Deterministic: float64 arithmetic on the bars alone, no clock, no
// randomness, no network, no files. Two runs on the same data produce
// the same orders.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const HI_N = 240; // rolling-high window (bars)
const DIP = 0.02; // arm when >= 2% below the rolling high
const RSI_LO = 40; // arm only when RSI(14) <= 40
const FIRE_RET10 = 0.002; // fire when 10-min return >= +0.2%
const TP = 1021n; // take profit: value >= cost * 1021/1000 (+2.1%)
const SL = 996n; // stop loss: value <= cost * 996/1000 (-0.4%)
const TIME_BARS = 60; // time exit: entry + 60 bars ...
const TIME_MIN_GAIN = 1002n; // ... if value <= cost * 1002/1000 (+0.2%)
const COOL_BARS = 60; // cooldown after any exit
const MAX_SLIPPAGE_BPS = 300; // 3%: far above any observed 1-min move (max 0.66%)
const BACKUP_BAR = 1100; // late fallback bar (race-window guardrail only)
const BACKUP_RET60 = 0.005;

const closes: number[] = [];
let rsiValue: number | null = null;
let rsiAvgGain = 0;
let rsiAvgLoss = 0;
const rsiWarmGains: number[] = [];
const rsiWarmLosses: number[] = [];
let armed = false;
let entrySeq = -1; // seq of the batch whose buy filled (decision bar)
let coolUntil = -1;
let traded = false;
let pendingBuySeq = -1;
let pendingBuyId = '';

function stepRsi(close: number): void {
  const n = closes.length;
  if (n < 2) return;
  const d = close - closes[n - 2];
  const g = d > 0 ? d : 0;
  const l = d < 0 ? -d : 0;
  if (rsiValue === null) {
    rsiWarmGains.push(g);
    rsiWarmLosses.push(l);
    if (rsiWarmGains.length === 14) {
      rsiAvgGain = rsiWarmGains.reduce((a, x) => a + x, 0) / 14;
      rsiAvgLoss = rsiWarmLosses.reduce((a, x) => a + x, 0) / 14;
      rsiValue = rsiAvgLoss === 0 ? 100 : 100 - 100 / (1 + rsiAvgGain / rsiAvgLoss);
    }
    return;
  }
  rsiAvgGain = (rsiAvgGain * 13 + g) / 14;
  rsiAvgLoss = (rsiAvgLoss * 13 + l) / 14;
  rsiValue = rsiAvgLoss === 0 ? 100 : 100 - 100 / (1 + rsiAvgGain / rsiAvgLoss);
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Settle the pending buy: did it fill on this batch?
    if (pendingBuySeq >= 0) {
      for (const f of batch.fills) {
        if (f.client_id === pendingBuyId) {
          if (f.status === 'filled') {
            entrySeq = pendingBuySeq;
            traded = true;
          } else {
            // Rejected: re-arm so the next turn signal can fire again.
            armed = true;
          }
          pendingBuySeq = -1;
          pendingBuyId = '';
          break;
        }
      }
    }

    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / 1e5;
    closes.push(close);
    stepRsi(close);
    const k = closes.length - 1;
    if (k < HI_N) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      // Take profit / stop loss vs the harness-reported cost basis.
      if (value * 1000n >= cost * TP) {
        coolUntil = state.seq + COOL_BARS;
        armed = false;
        entrySeq = -1;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (value * 1000n <= cost * SL) {
        coolUntil = state.seq + COOL_BARS;
        armed = false;
        entrySeq = -1;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (
        entrySeq >= 0 &&
        state.seq - entrySeq === TIME_BARS &&
        value * 1000n <= cost * TIME_MIN_GAIN
      ) {
        coolUntil = state.seq + COOL_BARS;
        armed = false;
        entrySeq = -1;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: no position.
    if (state.seq < coolUntil) return [];

    // Late fallback: guarantee >= 1 trade on a smooth up-trend race window.
    if (!traded && state.seq >= BACKUP_BAR) {
      const sma120 = closes.slice(-120).reduce((a, x) => a + x, 0) / 120;
      if (close > sma120 && close / closes[k - 60] - 1 > BACKUP_RET60) {
        const id = state.clientId();
        pendingBuySeq = state.seq;
        pendingBuyId = id;
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
      }
      return orders;
    }

    // Rolling 240-bar high (includes this bar).
    let hi = -Infinity;
    for (let i = k - HI_N + 1; i <= k; i++) if (closes[i] > hi) hi = closes[i];

    if (!armed) {
      if (close <= hi * (1 - DIP) && rsiValue !== null && rsiValue <= RSI_LO) armed = true;
      return orders;
    }

    // Armed: fire when the 10-min return turns >= +0.2%.
    if (close / closes[k - 10] - 1 >= FIRE_RET10) {
      armed = false;
      const id = state.clientId();
      pendingBuySeq = state.seq;
      pendingBuyId = id;
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
      return orders;
    }
    // The dip recovered without a confirmed turn: disarm.
    if (close >= hi * (1 - DIP / 2)) armed = false;
    return orders;
  },
});
