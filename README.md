# 📈 IPO Radar

Live tracker for Indian IPOs — grey-market premium (GMP), expected listing gain,
company fundamentals, and a **transparent, rule-based Subscribe / Avoid verdict**
for every open and upcoming IPO.

Data is scraped from [ipowatch.in](https://ipowatch.in) on a schedule, baked into
a single `data.json`, and rendered by one static `index.html`. **No backend, no
database, and zero runtime dependencies.**

> ⚠️ **Not investment advice.** GMP is an unofficial, speculative signal from the
> unregulated grey market and moves daily. The verdict is an automated heuristic
> to help you research faster — always do your own diligence.

---

## What it does

- **One screen, all live IPOs** — mainboard + SME, pulled straight from the GMP
  table (no typing or guessing URLs; each IPO links to its own analysis).
- **A custom scorecard** that weighs four best-practice signals:
  1. **GMP / expected listing gain** — grey-market demand.
  2. **Subscription** — overall & QIB (institutional) demand, once the IPO opens.
  3. **Valuation & fundamentals** — P/E vs peers, revenue & profit growth, margins,
     leverage.
  4. **Promoter skin-in-the-game** — post-issue holding and fresh-issue vs
     offer-for-sale (OFS) split.
- **An honest credibility stat** — e.g. *“of the last N listed IPOs with a positive
  GMP, X% listed above their issue price.”*
- **Full detail per IPO** — what the company does, a financials chart, key ratios,
  and a signal-by-signal breakdown of *why* it got its verdict.

## How it's built

```
index.html   ← the entire UI + the scorecard engine (this is what you edit/host)
data.json    ← scraped data (regenerated automatically; the site just reads it)
scripts/
  scrape.js      ← zero-dependency scraper (runs in CI)
  serve.js       ← tiny local preview server
  test-parse.js  ← offline unit tests for the parser
.github/workflows/refresh.yml  ← hourly GitHub Action that updates data.json
```

The site you deploy is just **two files**: `index.html` + `data.json`.
Everything under `scripts/` and `.github/` is tooling that runs in GitHub, not on
the live site.

```
GitHub Action (hourly)  →  scrape.js updates data.json  →  git push  →  Netlify redeploys
```

## Run it locally

Requires **Node 18+** (for the built-in `fetch`). No `npm install` needed.

```bash
npm run serve      # then open http://localhost:8080
npm test           # run the parser unit tests (offline)
npm run scrape     # re-scrape and rewrite data.json (needs open internet)
```

> Open the site through `npm run serve`, **not** by double-clicking `index.html` —
> browsers block a `file://` page from reading `data.json`.
>
> On a corporate network that intercepts TLS, `npm run scrape` may fail locally
> with a certificate/`401` error. That's the proxy, not the code — the GitHub
> Action runs on a clean network, so scheduled refreshes work regardless.

## Deploy to Netlify

1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import from Git**, pick the repo.
3. Build command: *(leave empty)*. Publish directory: `.` (the repo root).
4. Deploy. Done — it's a static site.

The GitHub Action refreshes `data.json` every hour and pushes; Netlify auto-deploys
each push. To refresh on demand, open the repo's **Actions** tab → *Refresh IPO
data* → **Run workflow**.

*(Prefer no Git? You can also drag-and-drop just `index.html` + `data.json` onto
Netlify — but then the data won't auto-refresh.)*

## Make the verdict your own

The scoring lives in one place — the `CONFIG` block and the four `score…()`
functions at the top of the `<script>` in [`index.html`](index.html). Change the
weights, thresholds, or add a signal, and the whole UI updates. For example:

```js
const CONFIG = {
  weights: { gmp: 40, subscription: 20, fundamentals: 25, promoter: 15 },
  bands: [
    { min: 75, key: 'SUBSCRIBE' },
    { min: 60, key: 'CONSIDER' },
    { min: 45, key: 'NEUTRAL' },
    { min: 0,  key: 'AVOID' },
  ],
};
```

## Data & attribution

Data is scraped from **ipowatch.in** for personal/portfolio use, with light,
cached, scheduled requests. All figures belong to their source; this project just
reorganises public information and adds a scoring layer. If you fork it, please
keep the attribution and the disclaimer.

## License

MIT
