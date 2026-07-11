/* GridVest P0.1 — CSV reconciliation (Fidelity Accounts_History + Schwab transactions)
 *
 * Pure module: no DOM, no globals. Loaded by app.html via <script> and by
 * tests via require(). See docs/PRD.md P0.1 for acceptance criteria.
 *
 * normalize(text, knownSymbols) -> { format, txs[], skipped[] }
 *   txs: {date, account, action:'BUY'|'SELL', symbol, shares, price, amount, cashBalance|null}
 *   skipped: {line, raw, reason}  — every non-ignorable row we couldn't use
 *
 * reconcile(state, txs, params) -> { state, events[], issues[] }
 *   state: {funds:{SYM:{blocks:[{account,basis,shares}],...}}, summary:{cashBalance,blocksOwned,realizedGains,...}}
 *   events: block opens/closes with profit; issues: sells with no matching block etc.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GridVestReconcile = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------- CSV primitives ---------- */

  // RFC-4180-ish line splitter: handles quoted fields, embedded commas, "" escapes.
  function splitCSVLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  function num(s) {
    if (s == null) return null;
    const t = String(s).replace(/[$,]/g, '').trim();
    if (t === '' || t === '--') return null;
    const neg = /^\(.*\)$/.test(t);
    const v = parseFloat(neg ? t.slice(1, -1) : t);
    if (isNaN(v)) return null;
    return neg ? -v : v;
  }

  // Normalize dates to MM/DD/YYYY. Schwab sometimes uses "07/08/2026 as of 07/07/2026".
  function normDate(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  }

  /* ---------- format detection ---------- */

  function detectFormat(lines) {
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const l = lines[i].toLowerCase();
      if (/run date/.test(l) && /symbol/.test(l)) return { format: 'fidelity', headerIndex: i };
      if (/^"?date"?,/.test(l) && /action/.test(l) && /symbol/.test(l)) return { format: 'schwab', headerIndex: i };
    }
    return { format: null, headerIndex: -1 };
  }

  /* ---------- action mapping ---------- */

  // Rows that are real trades of tracked symbols -> BUY/SELL.
  // Rows that are expected non-trade activity -> ignored silently.
  // Anything else for a tracked symbol -> skipped (surfaced to the user).
  const IGNORE_RE = /dividend|reinvest|interest|journal|transfer|contribution|distribution|wire|deposit|withdrawal|fee|foreign tax|cash in lieu|moneylink|funds (received|paid)|sweep|core|redemption|direct debit|check received/i;

  function mapAction(raw) {
    const a = String(raw || '').toUpperCase();
    if (/TO (OPEN|CLOSE)/.test(a)) return null;   // options legs ("Sell to Open") are not equity fills
    if (/YOU BOUGHT|^BOUGHT|^BUY\b/.test(a)) return 'BUY';
    if (/YOU SOLD|^SOLD|^SELL\b/.test(a)) return 'SELL';
    return null;
  }

  /* ---------- normalize: CSV text -> transactions ---------- */

  function normalize(text, knownSymbols) {
    const syms = new Set(knownSymbols || []);
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() !== '');
    const det = detectFormat(lines);
    if (!det.format) return { format: null, txs: [], skipped: [{ line: 0, raw: lines[0] || '', reason: 'No Fidelity (Run Date/Symbol) or Schwab (Date/Action/Symbol) header row found' }] };

    const hdr = splitCSVLine(lines[det.headerIndex]).map(h => h.toLowerCase());
    const col = re => hdr.findIndex(h => re.test(h));
    const ci = det.format === 'fidelity'
      ? { date: col(/run date/), account: col(/^account(?! number)/), acctNum: col(/account number/), action: col(/^action/), sym: col(/^symbol/), qty: col(/quantity/), price: col(/price/), amt: col(/amount/), cash: col(/cash balance/) }
      : { date: col(/^date/), account: -1, acctNum: -1, action: col(/^action/), sym: col(/^symbol/), qty: col(/quantity/), price: col(/^price/), amt: col(/^amount/), cash: -1 };

    const txs = [], skipped = [];
    for (let i = det.headerIndex + 1; i < lines.length; i++) {
      const raw = lines[i];
      const c = splitCSVLine(raw);
      if (c.length < 4) continue;                       // footers/disclaimers
      const sym = (c[ci.sym] || '').trim().toUpperCase();
      const actionRaw = c[ci.action] || '';
      if (!sym) { if (!IGNORE_RE.test(actionRaw)) continue; else continue; } // cash rows: not ours
      if (syms.size && !syms.has(sym)) continue;        // other holdings: out of scope by design
      const action = mapAction(actionRaw);
      if (!action) {
        if (!IGNORE_RE.test(actionRaw)) skipped.push({ line: i + 1, raw, reason: `Unrecognized action for tracked symbol ${sym}: "${actionRaw}"` });
        continue;
      }
      const shares = Math.abs(num(c[ci.qty]) ?? 0);
      const price = num(c[ci.price]);
      const amount = num(c[ci.amt]);
      const date = normDate(c[ci.date]);
      if (!shares || !price || !date) {
        skipped.push({ line: i + 1, raw, reason: `Trade row missing ${!date ? 'date' : !shares ? 'quantity' : 'price'}` });
        continue;
      }
      const account = ci.account >= 0 && c[ci.account] ? c[ci.account] : (ci.acctNum >= 0 && c[ci.acctNum] ? c[ci.acctNum] : 'Schwab PCRA');
      txs.push({
        date, account, action, symbol: sym, shares, price,
        amount: amount != null ? amount : (action === 'BUY' ? -1 : 1) * shares * price,
        cashBalance: ci.cash >= 0 ? num(c[ci.cash]) : null,
      });
    }
    // Fidelity lists newest-first; reconcile oldest-first so state evolves forward.
    txs.sort((a, b) => new Date(a.date) - new Date(b.date));
    return { format: det.format, txs, skipped };
  }

  /* ---------- reconcile: transactions -> state changes ---------- */

  // Sell matching: same symbol + account, prefer exact share count, then the block
  // whose basis*(1+target) is closest to the sell price (OTO pairs sell the whole block).
  function findBlockForSell(blocks, tx, sellTarget) {
    const cands = blocks
      .map((b, idx) => ({ b, idx }))
      .filter(x => (x.b.account || '') === (tx.account || '') || !x.b.account);
    if (!cands.length) return -1;
    const exact = cands.filter(x => x.b.shares === tx.shares);
    const pool = exact.length ? exact : cands;
    let best = -1, bestErr = Infinity;
    for (const x of pool) {
      const expected = x.b.basis * (1 + sellTarget);
      const err = Math.abs(expected - tx.price) + (x.b.shares === tx.shares ? 0 : 1e6);
      if (err < bestErr) { bestErr = err; best = x.idx; }
    }
    return best;
  }

  function reconcile(state, txs, params) {
    // deep-copy the mutable parts so callers can diff old vs new
    const st = JSON.parse(JSON.stringify(state));
    const events = [], issues = [];
    const sellT = sym => {
      const t = params && params.sell_target;
      if (typeof t === 'number') return t;
      return (t && (t[sym] ?? t['default'])) || 0.03;
    };

    for (const tx of txs) {
      const fund = st.funds[tx.symbol];
      if (!fund) { issues.push({ tx, reason: `No fund configured for ${tx.symbol}` }); continue; }
      fund.blocks = fund.blocks || [];

      if (tx.action === 'BUY') {
        fund.blocks.push({ account: tx.account, basis: tx.price, shares: tx.shares, opened: tx.date });
        st.summary.cashBalance -= tx.shares * tx.price;
        st.summary.blocksOwned = (st.summary.blocksOwned || 0) + 1;
        events.push({ type: 'open', tx, basis: tx.price });
      } else { // SELL
        const i = findBlockForSell(fund.blocks, tx, sellT(tx.symbol));
        if (i < 0) {
          issues.push({ tx, reason: `Sell of ${tx.shares} ${tx.symbol} (${tx.account}) has no matching open block — reconcile manually` });
          continue;
        }
        const b = fund.blocks[i];
        const closedShares = Math.min(b.shares, tx.shares);
        const profit = closedShares * (tx.price - b.basis);
        if (tx.shares >= b.shares) fund.blocks.splice(i, 1);
        else b.shares -= tx.shares;                    // partial sell
        st.summary.cashBalance += tx.shares * tx.price;
        if (tx.shares >= closedShares && !fund.blocks.includes(b)) st.summary.blocksOwned = Math.max(0, (st.summary.blocksOwned || 0) - 1);
        st.summary.realizedGains = (st.summary.realizedGains || 0) + profit;
        st.summary.projection = (st.summary.projection || 0) + profit;
        events.push({ type: 'close', tx, basis: b.basis, profit: +profit.toFixed(2), pctGain: +((tx.price / b.basis - 1) * 100).toFixed(2) });
        if (profit < 0) issues.push({ tx, reason: `Losing sell (-$${Math.abs(profit).toFixed(2)}) — the strategy never sells at a loss; check block matching` });
      }
      // trust the broker's running cash balance when the CSV provides one (per account —
      // each account's rows carry that account's own running balance)
      if (tx.cashBalance != null) {
        st.summary.brokerCashByAccount = st.summary.brokerCashByAccount || {};
        st.summary.brokerCashByAccount[tx.account] = tx.cashBalance;
      }
    }
    return { state: st, events, issues };
  }

  return { splitCSVLine, num, normDate, detectFormat, normalize, reconcile };
});
