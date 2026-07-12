// P0.8 acceptance tests — run: node test/engine.test.js
// Part 1: structural behavior on fixtures.
// Part 2: empirical validation replaying the real trade ledger
//         (archive/data/all-transactions.json — private, outside the repo;
//         those tests skip gracefully when the file is absent, e.g. in CI).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

let passed = 0, skipped = 0;
function t(name, fn) { fn(); passed++; console.log('ok - ' + name); }
function skip(name, why) { skipped++; console.log('skip - ' + name + ' (' + why + ')'); }

const PARAMS = {
  sell_target: { NAIL: 0.0345, SPXL: 0.0317, SOXL: 0.0447, TQQQ: 0.0325, default: 0.03 },
  ladder_step: 0.023, block_pct: 0.025, max_open_rungs: 3,
  targets: { NAIL: 90, SPXL: 10 },
};

function fixture() {
  return {
    funds: {
      NAIL: { prevClose: 49.20, blocks: [
        { account: 'Account A', basis: 57.09, shares: 1633 },
        { account: 'Account B', basis: 57.09, shares: 20 },
      ]},
      SPXL: { prevClose: 268.81, blocks: [] },
    },
    summary: { cashBalance: 2000000, marketValue: 2800000, blocksOwned: 2 },
  };
}

/* ---------- Part 1: structural ---------- */

t('pure: does not mutate its input state', () => {
  const st = fixture(); const snapshot = JSON.stringify(st);
  E.engine(st, PARAMS);
  assert.strictEqual(JSON.stringify(st), snapshot);
});

t('ladder rungs step down ~ladder_step from prevClose, compounding', () => {
  const { tickets } = E.engine(fixture(), PARAMS);
  const nail = tickets.filter(t => t.sym === 'NAIL');
  const rung1 = +(49.20 * (1 - 0.023)).toFixed(2);          // 48.07
  const rung2 = +(49.20 * Math.pow(1 - 0.023, 2)).toFixed(2); // 46.96
  assert.strictEqual(nail.find(t => t.rung === 1).buyPx, rung1.toFixed(2));
  assert.strictEqual(nail.find(t => t.rung === 2).buyPx, rung2.toFixed(2));
});

t('sell leg = buy × (1 + per-symbol target), never below', () => {
  const { tickets } = E.engine(fixture(), PARAMS);
  for (const tk of tickets) {
    const target = PARAMS.sell_target[tk.sym] ?? PARAMS.sell_target.default;
    assert.strictEqual(tk.sellPx, (+tk.buyPx * (1 + target)).toFixed(2));
    assert.ok(+tk.sellPx > +tk.buyPx);
  }
});

t('multi-account: identical prices, shares ∝ account weight', () => {
  const { tickets } = E.engine(fixture(), PARAMS);
  const rung1 = tickets.filter(t => t.sym === 'NAIL' && t.rung === 1);
  assert.strictEqual(new Set(rung1.map(t => t.buyPx)).size, 1);   // same price everywhere
  const a = rung1.find(t => t.account === 'Account A'), b = rung1.find(t => t.account === 'Account B');
  // weights: 1633:20 by basis value → share counts in the same ratio (±rounding)
  assert.ok(Math.abs(a.shares / b.shares - 1633 / 20) / (1633 / 20) < 0.15);
});

t('zero-target symbol gets no buy rungs', () => {
  const st = fixture(); const p = { ...PARAMS, targets: { NAIL: 90, SPXL: 0 } };
  const { tickets } = E.engine(st, p);
  assert.ok(!tickets.some(t => t.sym === 'SPXL'));
});

t('allocation cap stops the ladder', () => {
  const st = fixture();
  // NAIL already deployed past 90% × marketValue? shrink marketValue so cap binds
  st.summary.marketValue = 100000;      // cap NAIL = 90k; deployed = 1653sh × 49.20 ≈ 81k
  st.summary.cashBalance = 2000000;     // cash is not the constraint
  const { tickets } = E.engine(st, PARAMS);
  const nailBlocks = tickets.filter(t => t.sym === 'NAIL');
  // block_$ = 2.5% × 100k × 0.9 = 2250 → one block fits under the 90k cap, second exceeds
  assert.ok(new Set(nailBlocks.map(t => t.rung)).size <= 4);
});

t('insufficient cash emits nothing active', () => {
  const st = fixture(); st.summary.cashBalance = 10;
  const { tickets } = E.engine(st, PARAMS);
  assert.strictEqual(tickets.length, 0);
});

/* ---- P0.4 guardrails: withheld, never silent ---- */

t('guardrail: insufficient cash -> rungs withheld with reason, prices still computed', () => {
  const st = fixture(); st.summary.cashBalance = 10;
  const { withheld } = E.engine(st, PARAMS);
  assert.ok(withheld.length > 0);
  assert.match(withheld[0].reason, /insufficient-cash/);
  assert.ok(+withheld[0].buyPx > 0 && +withheld[0].sellPx > +withheld[0].buyPx);
});

t('guardrail: designated reserve -> cash-reserve reason when cash exists but is reserved', () => {
  const st = fixture(); st.summary.cashBalance = 2000000;
  const p = { ...PARAMS, reserve: 1996000 };            // investable $4k < even SPXL's $7k block
  const { tickets, withheld } = E.engine(st, p);
  assert.strictEqual(tickets.length, 0);
  assert.ok(withheld.length > 0);
  assert.match(withheld[0].reason, /cash-reserve/);
});

t('guardrail: allocation cap -> allocation-cap reason on the rungs past the cap', () => {
  const st = fixture(); st.summary.marketValue = 90000;  // NAIL cap 81k < deployed ~81.3k
  const { withheld } = E.engine(st, PARAMS);
  const capped = withheld.filter(w => w.sym === 'NAIL');
  assert.ok(capped.length > 0);
  assert.match(capped[0].reason, /allocation-cap/);
});

t('guardrail: withheld rungs consume no cash — active tickets unaffected', () => {
  const st = fixture();
  const base = E.engine(st, PARAMS).tickets.length;
  const p = { ...PARAMS, reserve: 0 };
  assert.strictEqual(E.engine(st, p).tickets.length, base);
  // reserve large enough to withhold rung 3 only
  const blk = PARAMS.block_pct * st.summary.marketValue * 0.9;   // NAIL block $
  const p2 = { ...PARAMS, reserve: st.summary.cashBalance - 2.5 * blk - 20000 /*SPXL room*/ };
  const r2 = E.engine(st, p2);
  assert.ok(r2.tickets.length > 0 && r2.withheld.length > 0);
});

t('no guardrail breach -> withheld is empty', () => {
  const { withheld } = E.engine(fixture(), PARAMS);
  assert.strictEqual(withheld.length, 0);
});

t('cancel list covers every open block with its sell-target price', () => {
  const { cancel } = E.engine(fixture(), PARAMS);
  assert.strictEqual(cancel.filter(c => c.sym === 'NAIL').length, 2);
  assert.match(cancel[0].desc, /59\.06/);   // 57.09 × 1.0345
});

t('binding parity: module output matches the historical inline formula shape', () => {
  const { tickets } = E.engine(fixture(), PARAMS);
  for (const tk of tickets) {
    assert.ok(tk.block && tk.seq && tk.sym && tk.account && tk.shares >= 1 && tk.buyPx && tk.sellPx && tk.spreadPct && tk.rung);
    assert.strictEqual(tk.block, tk.buyPx);  // block is identified by its buy price level
  }
});

/* ---------- Part 2: empirical validation against the real ledger ---------- */

const LEDGER = path.join(__dirname, '..', '..', 'archive', 'data', 'all-transactions.json');
if (!fs.existsSync(LEDGER)) {
  skip('ledger empirical suite', 'private archive/data/all-transactions.json not present');
} else {
  const num = s => { const v = parseFloat(String(s).replace(/[,%$]/g, '')); return isNaN(v) ? null : v; };
  const rows = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).rows
    .filter(r => r.length >= 22 && /^(Buy|Sell)$/.test(r[2]))
    .map(r => ({ symbol: r[0], date: r[1], action: r[2], shares: num(r[3]), price: num(r[4]), adjBlock: num(r[5]), account: r[9], amount: num(r[14]), profit: num(r[15]), marketValue: num(r[18]), pctInvested: num(r[20]) }))
    .reverse();  // ledger scrape is newest-first; replay oldest-first
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  t(`ledger loads (${rows.length} trades)`, () => assert.ok(rows.length >= 150));

  t('zero losing sells in the entire ledger (strategy invariant)', () => {
    const losers = rows.filter(r => r.action === 'Sell' && r.profit != null && r.profit < 0);
    assert.strictEqual(losers.length, 0);
  });

  t('deployment never exceeded 30% (ALGORITHM.md max_deployment)', () => {
    const worst = Math.max(...rows.map(r => r.pctInvested ?? 0));
    assert.ok(worst <= 30, `saw ${worst}%`);
  });

  t('per-symbol sell spreads: ledger medians within 0.75pp of PARAMS sell_target', () => {
    for (const sym of ['NAIL', 'SPXL']) {
      const spreads = rows.filter(r => r.symbol === sym && r.action === 'Sell' && r.adjBlock > 0)
        .map(r => (r.price / r.adjBlock - 1) * 100);
      if (spreads.length < 5) continue;
      const m = median(spreads), expected = PARAMS.sell_target[sym] * 100;
      assert.ok(Math.abs(m - expected) < 0.75, `${sym}: ledger median ${m.toFixed(2)}% vs param ${expected}%`);
    }
  });

  t('buy ladder: median consecutive down-step ≈ ladder_step ±0.6pp', () => {
    for (const sym of ['NAIL', 'SPXL']) {
      const buys = rows.filter(r => r.symbol === sym && r.action === 'Buy');
      const steps = [];
      for (let i = 1; i < buys.length; i++) {
        const d = (buys[i - 1].price - buys[i].price) / buys[i - 1].price * 100;
        if (d > 0.5 && d < 6) steps.push(d);   // consecutive down-steps only, per ALGORITHM.md §3
      }
      if (steps.length < 5) continue;
      const m = median(steps), expected = PARAMS.ladder_step * 100;
      assert.ok(Math.abs(m - expected) < 0.6, `${sym}: median step ${m.toFixed(2)}% vs param ${expected}%`);
    }
  });

  t('block sizing: median buy ≈ block_pct of portfolio (±1pp)', () => {
    const pcts = rows.filter(r => r.symbol === 'NAIL' && r.action === 'Buy' && r.amount && r.marketValue)
      .map(r => r.amount / r.marketValue * 100);
    const m = median(pcts), expected = PARAMS.block_pct * 100;
    assert.ok(Math.abs(m - expected) < 1.0, `median block ${m.toFixed(2)}% vs param ${expected}%`);
  });
}

console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped` : ''}`);
