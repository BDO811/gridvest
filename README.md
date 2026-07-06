# GridVest — Phase 0

Your own-brand rebuild of the Decisive Investor concept. Black-on-cream canon: Georgia display and body, Courier New labels, cream `#F0EAE0` surface, black accents, zero rounded corners.

## Files
- `theme.css` — **the entire brand lives here.** Design tokens (colors, fonts, sizes) as CSS variables plus all shared components (topbar, cards, data tables, forms, footer, disclosure box). Change a variable, rebrand every page.
- `index.html` — public home: hero, how it works, feature table, plain-language risk section. All copy is original.
- `calculator.html` — working retirement calculator (accumulation, needed-savings PV, drawdown curve on a canvas chart). Pure vanilla JS, no dependencies.
- `app.html` — member-app design mockup with sample data: per-fund scorecards, portfolio panel, and a "today's tickets" table using the buy/sell row colors.

## Run it
Open `index.html` in a browser. No build step, no server needed.

## Phasing (from the clone plan)
- **Phase 0 (this):** brand system + public pages + calculator + app mockup.
- **Phase 1:** auth, Postgres data model, broker CSV import, read-only Summary/Ledger.
- **Phase 2:** the strategy engine + Daily Processing wizard (see `~/Downloads/DecisiveInvestor_Archive/03-strategy-engine-spec-draft.md` for the reverse-engineered rules and the open questions to validate before cancelling the subscription).
- **Phase 3:** projections engine, charts, settings.
- **Phase 4:** broker auto-import, streak tracker, polish.
