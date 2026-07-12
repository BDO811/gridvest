/* GridVest P0.6 — previous-close quotes via Alpha Vantage
 *
 * fetchPrevCloses(symbols, apiKey, fetchImpl?) -> Promise<{
 *   quotes: {SYM: {prevClose, asOf}}, errors: {SYM: reason} }>
 *
 * - GLOBAL_QUOTE endpoint, one call per symbol (free tier: 25/day — five
 *   symbols once daily fits comfortably)
 * - never throws for a single bad symbol; per-symbol errors come back so the
 *   UI can fall back to manual entry EXPLICITLY, not silently
 * - fetchImpl injectable for tests
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GridVestQuotes = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const BASE = 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE';

  function parseGlobalQuote(json) {
    if (json && json['Note']) return { error: 'rate-limited: ' + json['Note'].slice(0, 80) };
    if (json && json['Error Message']) return { error: json['Error Message'].slice(0, 120) };
    const q = json && json['Global Quote'];
    if (!q || !q['08. previous close']) return { error: 'unexpected response shape' };
    const prevClose = parseFloat(q['08. previous close']);
    if (isNaN(prevClose) || prevClose <= 0) return { error: 'bad previous close value' };
    return { prevClose, asOf: q['07. latest trading day'] || null };
  }

  async function fetchPrevCloses(symbols, apiKey, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('no fetch implementation available');
    if (!apiKey) throw new Error('no API key configured');
    const quotes = {}, errors = {};
    for (const sym of symbols) {
      try {
        const res = await f(`${BASE}&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(apiKey)}`);
        if (!res.ok) { errors[sym] = `HTTP ${res.status}`; continue; }
        const parsed = parseGlobalQuote(await res.json());
        if (parsed.error) errors[sym] = parsed.error;
        else quotes[sym] = parsed;
      } catch (e) {
        errors[sym] = 'network: ' + (e && e.message || e);
      }
    }
    return { quotes, errors };
  }

  return { fetchPrevCloses, parseGlobalQuote };
});
