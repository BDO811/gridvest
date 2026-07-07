# GridVest Trading Algorithm — Specification

**Status:** v1.0 · reverse-engineered from Decisive Investor · July 6, 2026
**Evidence base:** all 155 trades in the live account, 05/04/2026 → 07/06/2026 (NAIL 120, SPXL 31, TQQQ 4), plus the Owned Trading Blocks detail table and color legend.
**This is a living document.** Edit the parameters in §6 and the logic in §4/§5 as we validate against more history. Every number here is empirical unless marked *[assumption]*.

---

## 1. One-sentence summary

Hold most of the portfolio in cash; on each leveraged ETF, place a **ladder of limit buys ~2.3% apart stepping down from the market**, sizing each buy as a fixed **"trading block"**; the moment a block fills, attach a **sell limit ~3% above that block's average cost**; never sell at a loss, so blocks are simply held until their target is hit; recycle the freed cash into the next dip.

It is a **grid / mean-reversion strategy** that harvests volatility, tuned so the portfolio is rarely more than ~25–30% deployed.

---

## 2. Core object: the Trading Block

A **trading block** is the unit of everything. It is one position tranche with its own cost basis and its own sell order.

- **Open a block:** a buy fills at a laddered price. Block basis = fill price.
- **Add to a block ("Subsequent Buy"):** buying more at a lower price *re-averages* the block's basis. This is confirmed by the `AdjustedTradeBlock` column — e.g. a buy at 51.29 shows basis 53.17, and a further buy at 51.29 shows basis 51.93: the block's reference cost is recomputed as shares are added.
- **Close a block (or "Partial Sell"):** a sell fills at basis × (1 + target). Realized profit is booked. Cash returns to reserve.
- **Blocks Owned** = count of currently open blocks (observed range 0–17).

The color legend encodes exactly these three states: **Buy Order**, **Sell Order**, **Subsequent Buy or Partial Sell**.

---

## 3. Empirical parameters (measured from the 155 trades)

| Parameter | Measured value | Notes |
|-----------|----------------|-------|
| **Sell profit target** | **≈ 3.0%** above block basis | sell/basis spread: median **3.22%**, mean 3.90% (mean inflated by outliers). Per-symbol PctGain medians: NAIL 3.68%, SPXL 3.17%, TQQQ ~3.25% floor. Minimum observed ≈ **2.4%**. |
| **Buy ladder step** | **≈ 2.3% down** per rung | consecutive down-steps: NAIL median 2.31% / mean 2.08%; SPXL median 2.34% / mean 2.14%. Range ~1.1%–3.4% typical. |
| **Block size** | **≈ 2.3–2.7% of portfolio** per block | NAIL buys median 2.70% of portfolio (avg ≈ $64.8k, trending ~$82k as portfolio grew). Scales with the ETF's target allocation (SPXL blocks far smaller at 10% target). Effectively a **fixed dollar tranche per ETF**, recalculated from portfolio × sizing constant. |
| **Max deployment** | **~29%** ever invested | % invested ranged **0% → 28.9%**. The huge cash reserve is the core risk control. |
| **Stop loss** | **none** | **0 losing sells out of 71.** Blocks are held indefinitely until the +3% target hits. (Matches the marketing "2,000 sells without a loss.") |
| **Turnover** | **1–5 days per gain** | short-lived blocks; 57 NAIL gains booked in ~2 months. |
| **Order type** | limit / GTC, re-evaluated daily | stale rungs are cancelled and repriced each day (Daily Processing step 2). |

---

## 4. The daily algorithm (what runs each morning)

```
INPUT per account-group:
  positions[]      # per ETF: open blocks (shares, avg basis)
  cash             # from broker CSV import
  reserve          # user-set Designated Cash Reserve (never deployed)
  targets{}        # per-ETF target allocation %  (e.g. NAIL 90, SPXL 10, TQQQ 0)
  quotes{}         # previous close / current price per ETF
  params           # see §6

STEP 0 — RECONCILE
  parse broker transactions; mark blocks that filled (buys opened, sells closed)
  recompute cash, shares owned, realized + unrealized P&L

STEP 1 — CANCEL (Daily Processing "Orders to Cancel")
  for each working order:
     if it is a buy rung no longer within the active ladder window,
        or a sell whose block was re-averaged / already handled:
        -> CANCEL and reprice

STEP 2 — SELLS (attach/refresh a target to every open block)
  for each open block b:
     sell_price = round_tick( b.basis * (1 + params.sell_target) )   # ~1.03
     ensure a SELL limit exists at sell_price for b.shares
     # never below basis -> no losing exits

STEP 3 — BUYS (build the ladder, bounded by reserve + target)
  investable = cash - reserve
  for each ETF with targets[etf] > 0, in priority order:
     cap        = targets[etf]/100 * portfolio_value      # allocation ceiling
     deployed   = market_value(open blocks in etf)
     ref        = quotes[etf].prev_close
     block_$    = params.block_pct * portfolio_value       # ~2.5% (scaled by target)
     rung = 1
     while deployed < cap and investable >= block_$ and rung <= params.max_open_rungs:
        rung_price = round_tick( ref * (1 - params.ladder_step)^rung )   # ~2.3% steps
        if no open order/block already covers rung_price:
           shares = floor(block_$ / rung_price)
           emit BUY limit (etf, rung_price, shares)
           investable -= block_$
        rung += 1

OUTPUT:
  "Orders to Cancel"  (step 1)
  "Orders to Place"   = new BUY rungs (step 3) + SELL limits for filled blocks (step 2)
  # user enters these at Fidelity/Schwab
```

## 5. Worked example (real rows, NAIL, main account)

```
07/01  BUY  1,679 @ 50.71   -> opens block, basis 50.71,  blocks 12->13, inv 19.4%
07/01  SELL 1,679 @ 52.18   <- 52.18/50.71 = +2.90%,      blocks 13->12, inv 16.8%   (target hit)
07/01  BUY  1,717 @ 49.52   -> price kept falling, next rung ~2.3% down, blocks ->13
07/02  BUY  1,619 @ 49.10   -> add,   blocks ->14, inv 21.8%
07/02  BUY  1,698 @ 48.36   -> add,   blocks ->15, inv 24.4%   (~1.5% step)
07/02  BUY  1,738 @ 47.23   -> add,   blocks ->16, inv 26.9%   (~2.3% step)
07/02  SELL 1,738 @ 48.65   <- 48.65/47.23 = +3.00%,  blocks ->15, inv 24.5%
```
Reads exactly as the model in §4: ladder down in ~2.3% rungs, each block carries a +3% sell, cash recycles, deployment oscillates in the low-to-high-20s%.

## 6. Tunable parameters (edit these to configure GridVest)

```jsonc
{
  "sell_target":     0.030,   // +3.0% above block basis (min seen ~2.4%)
  "ladder_step":     0.023,   // 2.3% between buy rungs
  "block_pct":       0.025,   // block size ≈ 2.5% of portfolio (per ETF, scaled by target)
  "max_open_rungs":  6,        // [assumption] how many live buy rungs at once
  "reserve_floor":   0.0,      // user Designated Cash Reserve ($ or %)
  "max_deployment":  0.30,     // [derived] soft ceiling — never seen above 28.9%
  "stop_loss":       null,     // none — blocks held until target
  "targets": { "NAIL": 90, "SPXL": 10, "TQQQ": 0, "SOXL": 0, "TNA": 0 },
  "tick_rounding":   0.01,
  "order_tif":       "GTC"     // re-evaluated & repriced daily
}
```

## 7. Why it (mostly) works — and where it breaks

- **Works in choppy/volatile ranges:** frequent ~3% round-trips on high-volatility 3× ETFs, funded by a deep cash reserve, compounds many small wins. The reserve means dips get *bought*, not feared.
- **The hidden risk — "no losing sells" is a feature and a trap:** because blocks are never sold at a loss, a sustained decline just accumulates open blocks (unrealized loss grows, `blocks owned` climbs, deployment rises toward the cap). On a 3× ETF that can fall 60–88%, a long one-way drawdown leaves capital stuck in deep-underwater blocks waiting for a recovery that may take years. The strategy's safety lives entirely in (a) the cash reserve size and (b) the deployment cap. **Those two numbers are the real risk dial.**
- **Open questions still to validate** (capture more data before finalizing):
  1. Exact ladder anchor — is `ref` the previous close, or the last fill? (§4 assumes prev close.)
  2. Is `block_$` a fixed dollar set per ETF, or recomputed daily from portfolio × `block_pct`? (Data supports the latter, drifting up as the portfolio grew.)
  3. `max_open_rungs` and the precise cancel/reprice trigger.
  4. Whether `sell_target` is flat 3% or widens for deeper-averaged blocks (a few sells at 4–7%+ suggest possible widening, or just multi-block exits).

## 8. How to gather more evidence (before cancelling the subscription)

1. **Full ledger export:** Analysis → set "View Transactions" to each yearly scope (2026, and prior years if present) and re-scrape — more market regimes = better ladder/target fit. (`data/all-transactions.tsv` currently holds the 2026 set.)
2. **Daily ticket capture:** run Daily Processing on 3–5 consecutive days and record the exact "Orders to Place" vs that day's prices — this pins `ladder_step`, the anchor, and `max_open_rungs` precisely.
3. **Owned Trading Blocks snapshots:** the `AdjustedTradeBlock` basis column is the ground truth for the averaging + sell-target math. Snapshot it periodically. (`data/owned-trading-blocks.json`.)

---
*Source data: `~/Downloads/DecisiveInvestor_Archive/data/`. Companion: `DecisiveInvestor_Archive/03-strategy-engine-spec-draft.md` (superseded by this file).*
