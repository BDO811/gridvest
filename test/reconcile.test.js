// P0.1 acceptance tests — run: node test/reconcile.test.js
const assert = require('assert');
const R = require('../reconcile.js');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok - ' + name); }

/* ---------- fixtures ---------- */

// Fidelity Accounts_History.csv: preamble junk, quoted fields with commas,
// "YOU BOUGHT/ YOU SOLD" actions, negative amounts on buys, running cash balance.
const FIDELITY = `
Brokerage

Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date
07/08/2026,Main Retirement Taxable Account,X12345678," YOU SOLD OPENING TRANSACTION as of 07/08/2026",NAIL,"DIREXION SHS ETF TR DAILY HOMEBUILDERS & SUPPLIES BULL 3X",Cash,-1550,47.71,,0.02,,73950.48,"1,264,371.10",07/10/2026
07/08/2026,Main Retirement Taxable Account,X12345678," YOU BOUGHT NAIL",NAIL,"DIREXION SHS ETF TR DAILY HOMEBUILDERS & SUPPLIES BULL 3X",Cash,1590,45.06,,,,-71645.40,"1,190,420.62",07/10/2026
07/08/2026,New Roth IRA,900000001," YOU BOUGHT NAIL",NAIL,"DIREXION SHS ETF TR",Cash,19,45.06,,,,-856.14,"5,102.33",07/10/2026
07/07/2026,Main Retirement Taxable Account,X12345678," DIVIDEND RECEIVED SPXL",SPXL,"DIREXION DAILY S&P 500 BULL 3X",Cash,,,,,,412.55,"1,338,321.58",
07/07/2026,Main Retirement Taxable Account,X12345678," REVERSE SPLIT R/S FROM 12345",NAIL,"DIREXION SHS ETF TR",Cash,100,,,,,,"1,337,909.03",
07/07/2026,Main Retirement Taxable Account,X12345678," JOURNALED CASH",,"CASH MOVEMENT",Cash,,,,,,-2500.00,"1,337,909.03",

"Disclaimer: The data provided is for informational purposes, blah, blah"
`;

// Schwab transactions CSV: title line, fully quoted, $ amounts, "as of" dates.
const SCHWAB = `
"Transactions for account Roth Contributory IRA ...789 as of 07/08/2026"
"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"07/08/2026","Buy","NAIL","DIREXION DAILY HOMEBUILDERS BULL 3X","25","$45.06","","-$1,126.50"
"07/08/2026 as of 07/07/2026","Sell","NAIL","DIREXION DAILY HOMEBUILDERS BULL 3X","25","$47.71","$0.01","$1,192.74"
"07/07/2026","Cash Dividend","SPXL","DIREXION DAILY S&P 500 BULL 3X","","","","$6.12"
"07/07/2026","MoneyLink Transfer","","TRANSFER","","","","$500.00"
`;

const SYMS = ['NAIL', 'SPXL', 'SOXL', 'TQQQ'];
const PARAMS = { sell_target: { NAIL: 0.0345, SPXL: 0.0317, SOXL: 0.0447, TQQQ: 0.0325, default: 0.03 } };

/* ---------- CSV primitives ---------- */

t('quoted fields with embedded commas', () => {
  assert.deepStrictEqual(R.splitCSVLine('a,"b, c",d'), ['a', 'b, c', 'd']);
  assert.deepStrictEqual(R.splitCSVLine('"say ""hi""",2'), ['say "hi"', '2']);
});

t('number parsing: $, commas, parens-negative', () => {
  assert.strictEqual(R.num('"1,264,371.10"'.replace(/"/g, '')), 1264371.10);
  assert.strictEqual(R.num('-$1,126.50'), -1126.50);
  assert.strictEqual(R.num('(500.25)'), -500.25);
  assert.strictEqual(R.num(''), null);
});

t('schwab "as of" dates normalize', () => {
  assert.strictEqual(R.normDate('07/08/2026 as of 07/07/2026'), '07/08/2026');
  assert.strictEqual(R.normDate('7/8/2026'), '07/08/2026');
});

/* ---------- normalize: Fidelity ---------- */

t('fidelity: detects format, extracts trades, ignores cash rows', () => {
  const { format, txs, skipped } = R.normalize(FIDELITY, SYMS);
  assert.strictEqual(format, 'fidelity');
  assert.strictEqual(txs.length, 3);                       // 2 buys + 1 sell; dividend/journal ignored
  const sell = txs.find(x => x.action === 'SELL');
  assert.strictEqual(sell.shares, 1550);                   // abs() of -1550
  assert.strictEqual(sell.price, 47.71);
  assert.strictEqual(sell.account, 'Main Retirement Taxable Account');
  assert.strictEqual(sell.cashBalance, 1264371.10);        // running broker cash captured
  // oldest-first ordering
  assert.ok(txs.every((x, i) => i === 0 || new Date(txs[i - 1].date) <= new Date(x.date)));
  // the unpriced REVERSE SPLIT row on a tracked symbol must be SURFACED, not dropped
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /REVERSE SPLIT|Unrecognized action/);
});

/* ---------- normalize: Schwab ---------- */

t('schwab: detects format, parses quoted $ fields, ignores dividends/transfers', () => {
  const { format, txs, skipped } = R.normalize(SCHWAB, SYMS);
  assert.strictEqual(format, 'schwab');
  assert.strictEqual(txs.length, 2);
  assert.strictEqual(txs[0].action, 'BUY');
  assert.strictEqual(txs[0].amount, -1126.50);
  assert.strictEqual(txs[1].date, '07/08/2026');
  assert.strictEqual(skipped.length, 0);
});

t('options legs ("Sell to Open") are surfaced as unrecognized, not treated as equity sells', () => {
  const csv = `"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"07/11/2026","Sell to Open","NAIL","CALL OPTION","10","$46.00","","$460.00"`;
  const { txs, skipped } = R.normalize(csv, SYMS);
  assert.strictEqual(txs.length, 0);
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /Unrecognized action/);
});

t('garbage input: no header -> explicit skip reason, no throw', () => {
  const { format, skipped } = R.normalize('hello\nworld', SYMS);
  assert.strictEqual(format, null);
  assert.match(skipped[0].reason, /header/i);
});

/* ---------- reconcile ---------- */

function freshState() {
  return {
    funds: {
      NAIL: { prevClose: 46.0, blocks: [{ account: 'Main Retirement Taxable Account', basis: 46.12, shares: 1550, opened: '07/03/2026' }] },
      SPXL: { prevClose: 268.81, blocks: [] },
    },
    summary: { cashBalance: 1000000, blocksOwned: 1, realizedGains: 114469, projection: 2878493 },
  };
}

t('buy opens a block, decrements cash, increments blocksOwned', () => {
  const { state, events, issues } = R.reconcile(freshState(), [
    { date: '07/08/2026', account: 'Main Retirement Taxable Account', action: 'BUY', symbol: 'NAIL', shares: 1590, price: 45.06 },
  ], PARAMS);
  assert.strictEqual(state.funds.NAIL.blocks.length, 2);
  assert.strictEqual(state.funds.NAIL.blocks[1].basis, 45.06);
  assert.strictEqual(state.summary.cashBalance, 1000000 - 1590 * 45.06);
  assert.strictEqual(state.summary.blocksOwned, 2);
  assert.strictEqual(events[0].type, 'open');
  assert.strictEqual(issues.length, 0);
});

t('sell closes the matching block and books profit to the penny', () => {
  const { state, events } = R.reconcile(freshState(), [
    { date: '07/08/2026', account: 'Main Retirement Taxable Account', action: 'SELL', symbol: 'NAIL', shares: 1550, price: 47.71 },
  ], PARAMS);
  assert.strictEqual(state.funds.NAIL.blocks.length, 0);
  assert.strictEqual(state.summary.blocksOwned, 0);
  const profit = 1550 * (47.71 - 46.12);
  assert.strictEqual(events[0].profit, +profit.toFixed(2));  // 2464.50
  assert.strictEqual(state.summary.realizedGains, 114469 + profit);
  assert.strictEqual(state.summary.cashBalance, 1000000 + 1550 * 47.71);
});

t('sell with no matching block is an issue, state untouched', () => {
  const { state, issues } = R.reconcile(freshState(), [
    { date: '07/08/2026', account: 'Some Other Account', action: 'SELL', symbol: 'NAIL', shares: 999, price: 47.71 },
  ], PARAMS);
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0].reason, /no matching open block/);
  assert.strictEqual(state.funds.NAIL.blocks.length, 1);   // untouched
  assert.strictEqual(state.summary.realizedGains, 114469);
});

t('partial sell shrinks the block instead of deleting it', () => {
  const { state, events } = R.reconcile(freshState(), [
    { date: '07/08/2026', account: 'Main Retirement Taxable Account', action: 'SELL', symbol: 'NAIL', shares: 550, price: 47.71 },
  ], PARAMS);
  assert.strictEqual(state.funds.NAIL.blocks.length, 1);
  assert.strictEqual(state.funds.NAIL.blocks[0].shares, 1000);
  assert.strictEqual(state.summary.blocksOwned, 1);        // still open
  assert.strictEqual(events[0].type, 'close');
});

t('losing sell is flagged (strategy never sells at a loss)', () => {
  const { issues } = R.reconcile(freshState(), [
    { date: '07/08/2026', account: 'Main Retirement Taxable Account', action: 'SELL', symbol: 'NAIL', shares: 1550, price: 44.00 },
  ], PARAMS);
  assert.ok(issues.some(i => /Losing sell/.test(i.reason)));
});

t('multi-account: same prices, blocks tracked per account', () => {
  const st = freshState();
  st.funds.NAIL.blocks.push({ account: 'New Roth IRA', basis: 46.12, shares: 19, opened: '07/03/2026' });
  st.summary.blocksOwned = 2;
  const { state } = R.reconcile(st, [
    { date: '07/08/2026', account: 'New Roth IRA', action: 'SELL', symbol: 'NAIL', shares: 19, price: 47.71 },
  ], PARAMS);
  assert.strictEqual(state.funds.NAIL.blocks.length, 1);   // Roth block closed
  assert.strictEqual(state.funds.NAIL.blocks[0].account, 'Main Retirement Taxable Account');
});

t('end-to-end: fidelity CSV through normalize+reconcile', () => {
  const { txs } = R.normalize(FIDELITY, SYMS);
  const { state, events, issues } = R.reconcile(freshState(), txs, PARAMS);
  // sell 1550 closes the seed block; buys 1590 + 19 open two new ones
  assert.strictEqual(state.funds.NAIL.blocks.length, 2);
  assert.strictEqual(state.summary.blocksOwned, 2);
  assert.strictEqual(events.filter(e => e.type === 'close').length, 1);
  assert.strictEqual(events.filter(e => e.type === 'open').length, 2);
  assert.strictEqual(issues.length, 0);
  // broker running balances are tracked PER ACCOUNT — a small Roth's balance
  // must never overwrite the main account's
  assert.strictEqual(state.summary.brokerCashByAccount['Main Retirement Taxable Account'], 1190420.62);
  assert.strictEqual(state.summary.brokerCashByAccount['New Roth IRA'], 5102.33);
});

console.log(`\n${passed} tests passed`);
