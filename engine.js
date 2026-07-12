/* GridVest P0.8 — the trading engine as a pure module (ALGORITHM.md §4, v1.1 OTO model)
 *
 * engine(state, params) -> { cancel[], tickets[], withheld[] }
 *   state:  { funds: {SYM: {prevClose, blocks:[{account,basis,shares}]}},
 *             summary: {cashBalance, marketValue, blocksOwned} }
 *   params: { sell_target: number | {SYM|default}, ladder_step, block_pct,
 *             max_open_rungs, targets: {SYM: pct}, reserve (cash floor, $) }
 *
 * Guardrails (P0.4): rungs that would breach the allocation cap, the
 * designated cash reserve, or available cash are NOT dropped silently —
 * they come back in `withheld` with the same ticket fields plus `reason`,
 * so the UI can grey them out and let the user deliberately include one.
 *
 * No DOM, no globals, no I/O — same module runs in app.html, in tests, and
 * (future) server-side. Behavior preserved verbatim from the app.html inline
 * version; every open question in ALGORITHM.md §7 stays visible here.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GridVestEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const sellT = (params, sym) => typeof params.sell_target === 'number'
    ? params.sell_target
    : (params.sell_target[sym] ?? params.sell_target['default']);

  // Each account's share of a block ∝ its share of total open-position value.
  function accountWeights(funds) {
    const w = {}; let tot = 0;
    for (const f of Object.values(funds)) (f.blocks || []).forEach(b => {
      const a = b.account || 'Account 1'; const v = b.shares * b.basis;
      w[a] = (w[a] || 0) + v; tot += v;
    });
    if (!tot) return { 'Account 1': 1 };
    for (const k in w) w[k] /= tot;
    return w;
  }

  function engine(state, params) {
    const { funds, summary: S } = state;
    const cancel = [], tickets = [], withheld = [];
    const weights = accountWeights(funds);
    const reserve = params.reserve || 0;
    let inv = S.cashBalance - reserve;    // investable never touches the reserve
    let seq = (S.blocksOwned || 0) + 1;
    for (const [sym, f] of Object.entries(funds)) {
      (f.blocks || []).forEach((b, i) => cancel.push({
        label: `OTO ${i + 1}B`, sym, account: b.account || 'Account 1',
        desc: `Sell ${b.shares.toLocaleString()} ${sym} Limit ${(b.basis * (1 + sellT(params, sym))).toFixed(2)} GTC — cancel only if this block was re-averaged or DI-window repriced`,
      }));
      const cap = (params.targets[sym] || 0) / 100 * S.marketValue;
      let dep = (f.blocks || []).reduce((a, b) => a + b.shares * f.prevClose, 0);
      const totT = Object.values(params.targets).reduce((a, b) => a + b, 0) || 1;
      const blk = params.block_pct * S.marketValue * ((params.targets[sym] || 0) / totT);
      if (blk <= 0) continue;
      for (let r = 1; r <= params.max_open_rungs; r++) {
        const buyPx = +(f.prevClose * Math.pow(1 - params.ladder_step, r)).toFixed(2);
        // guardrails: classify instead of silently stopping
        let reason = null;
        if (dep >= cap) reason = `allocation-cap: ${sym} already at its ${params.targets[sym]}% target (${Math.round(dep).toLocaleString()} of ${Math.round(cap).toLocaleString()} deployed)`;
        else if (inv < blk) reason = (S.cashBalance >= blk && reserve > 0)
          ? `cash-reserve: placing this ${Math.round(blk).toLocaleString()} block would invade the ${reserve.toLocaleString()} designated reserve`
          : `insufficient-cash: block needs ${Math.round(blk).toLocaleString()}, only ${Math.max(0, Math.round(inv)).toLocaleString()} investable`;
        const sellPx = +(buyPx * (1 + sellT(params, sym))).toFixed(2);
        const bucket = reason ? withheld : tickets;
        for (const [acct, wt] of Object.entries(weights)) {
          const sh = Math.floor(blk * wt / buyPx); if (sh < 1) continue;
          const tk = {
            block: buyPx.toFixed(2), seq, sym, account: acct, shares: sh,
            buyPx: buyPx.toFixed(2), sellPx: sellPx.toFixed(2),
            spreadPct: (sellT(params, sym) * 100).toFixed(2), rung: r,
          };
          if (reason) tk.reason = reason;
          bucket.push(tk);
        }
        seq++;
        if (!reason) { dep += blk; inv -= blk; }   // withheld rungs consume nothing
      }
    }
    return { cancel, tickets, withheld };
  }

  return { engine, accountWeights, sellT };
});
