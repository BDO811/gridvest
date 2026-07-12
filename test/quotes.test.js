// P0.6 tests — run: node test/quotes.test.js
const assert = require('assert');
const Q = require('../quotes.js');

let passed = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('ok - ' + name); }); }

const GOOD = sym => ({
  ok: true,
  json: async () => ({ 'Global Quote': { '01. symbol': sym, '07. latest trading day': '2026-07-10', '08. previous close': '49.2000' } }),
});
const RATE_LIMITED = { ok: true, json: async () => ({ 'Note': 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' }) };
const GARBAGE = { ok: true, json: async () => ({ hello: 'world' }) };

(async () => {
  await t('parses GLOBAL_QUOTE previous close + trading day', async () => {
    const { quotes, errors } = await Q.fetchPrevCloses(['NAIL'], 'k', async () => GOOD('NAIL'));
    assert.deepStrictEqual(quotes.NAIL, { prevClose: 49.2, asOf: '2026-07-10' });
    assert.deepStrictEqual(errors, {});
  });

  await t('rate-limit Note -> per-symbol error, not a crash', async () => {
    const { quotes, errors } = await Q.fetchPrevCloses(['NAIL'], 'k', async () => RATE_LIMITED);
    assert.strictEqual(Object.keys(quotes).length, 0);
    assert.match(errors.NAIL, /rate-limited/);
  });

  await t('unexpected shape -> explicit error', async () => {
    const { errors } = await Q.fetchPrevCloses(['NAIL'], 'k', async () => GARBAGE);
    assert.match(errors.NAIL, /unexpected response shape/);
  });

  await t('network failure on one symbol does not kill the rest', async () => {
    let n = 0;
    const f = async () => { if (++n === 1) throw new Error('offline'); return GOOD('SPXL'); };
    const { quotes, errors } = await Q.fetchPrevCloses(['NAIL', 'SPXL'], 'k', f);
    assert.match(errors.NAIL, /network: offline/);
    assert.strictEqual(quotes.SPXL.prevClose, 49.2);
  });

  await t('HTTP error surfaces status', async () => {
    const { errors } = await Q.fetchPrevCloses(['NAIL'], 'k', async () => ({ ok: false, status: 503 }));
    assert.match(errors.NAIL, /HTTP 503/);
  });

  await t('missing API key rejects loudly', async () => {
    await assert.rejects(() => Q.fetchPrevCloses(['NAIL'], '', async () => GOOD('NAIL')), /no API key/);
  });

  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
