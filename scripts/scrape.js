'use strict';

/**
 * IPO Radar — data scraper (zero dependencies).
 *
 * Runs in GitHub Actions on a schedule. Fetches ipowatch.in, parses the live
 * GMP tables + each IPO's detail page, and writes ../data.json — the single
 * file the static site reads. No npm packages: just Node 18+ (global fetch)
 * and a small purpose-built HTML parser below.
 *
 *   node scripts/scrape.js
 *
 * The subscribe/avoid VERDICT is intentionally NOT computed here — it lives in
 * index.html so the scoring rules stay editable in one visible place.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://ipowatch.in';
const GMP_URL = `${BASE}/ipo-grey-market-premium-latest-ipo-gmp/`;
const OUT = path.join(__dirname, '..', 'data.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0 Safari/537.36 IPO-Radar/1.0 (+https://github.com/)';
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 5;

/* ------------------------------------------------------------------ *
 * Tiny HTML helpers (no DOM library)
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => (ENTITIES[name] != null ? ENTITIES[name] : m));
}

function clean(html) {
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]*>/g, ' '))
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove scripts/styles/etc. so their contents never leak into parsed text. */
function stripInert(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

const lc = (a) => a.map((x) => (x || '').toLowerCase());
const idxOf = (header, re) => lc(header).findIndex((x) => re.test(x));

/** Parse every <table> into { index, rows } where each cell keeps its raw HTML. */
function getTables(html) {
  const tables = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tm[1]))) {
      const cells = [];
      const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) cells.push(cm[1]);
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ index: tm.index, rows });
  }
  return tables;
}

/** Linear list of heading/paragraph blocks, in document order. */
function getBlocks(html) {
  const blocks = [];
  const re = /<(h[1-3]|p|li|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const idMatch = m[2].match(/id\s*=\s*["']([^"']+)["']/i);
    const text = clean(m[3]);
    if (text) blocks.push({ tag, id: idMatch ? idMatch[1] : '', text, index: m.index });
  }
  return blocks;
}

function firstHref(cellHtml) {
  const m = String(cellHtml).match(/href\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ *
 * Value parsing
 * ------------------------------------------------------------------ */

function money(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
/** Number that treats (parentheses) as negative — used for financials/KPIs. */
function num(text) {
  if (text == null) return null;
  const s = String(text).replace(/,/g, '');
  const neg = /\(\s*₹?\s*[\d.]/.test(s) && /\)/.test(s);
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return neg ? -Math.abs(v) : v;
}
function upperBand(text) {
  if (text == null) return null;
  const nums = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  return nums ? parseFloat(nums[nums.length - 1]) : null;
}
function percent(text) {
  const m = String(text || '').match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}
function trendFrom(text) {
  const t = text || '';
  if (t.includes('🟢')) return 'up';
  if (t.includes('🔴')) return 'down';
  if (t.includes('🟡')) return 'flat';
  return 'unknown';
}
function normalizeUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, BASE);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // no javascript:/data: in data.json
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    return u.toString();
  } catch {
    return null;
  }
}
function slugFromUrl(url) {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}
const STOP = new Set([
  'ipo', 'ipos', 'details', 'detail', 'review', 'gmp', 'ltd', 'limited', 'the', 'and',
  'nse', 'bse', 'sme', 'india', 'indian', 'company', 'solution', 'solutions',
  'technologies', 'industries', 'projects', 'enterprises',
]);
function slugTokens(slug) {
  if (!slug) return [];
  return slug.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

/* ------------------------------------------------------------------ *
 * Networking
 * ------------------------------------------------------------------ */

async function fetchHtml(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const html = await res.text();
      if (!html || html.length < 500) throw new Error(`Tiny response from ${url}`);
      return html;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * List page
 * ------------------------------------------------------------------ */

function buildHeaderIndex(headerCells) {
  const idx = {};
  headerCells.forEach((raw, i) => {
    const t = raw.toLowerCase();
    if (/ipo name|company name|^name/.test(t) && idx.name == null) idx.name = i;
    else if (/gmp/.test(t) && idx.gmp == null) idx.gmp = i;
    else if (/trend/.test(t) && idx.trend == null) idx.trend = i;
    else if (/price band|price/.test(t) && idx.band == null) idx.band = i;
    else if (/listing/.test(t) && idx.listing == null) idx.listing = i;
    else if (/date/.test(t) && idx.date == null) idx.date = i;
    else if (/status/.test(t) && idx.status == null) idx.status = i;
    else if (/updated/.test(t) && idx.updated == null) idx.updated = i;
  });
  return idx;
}

function parseList(html) {
  const clean_html = stripInert(html);
  const tables = getTables(clean_html);
  // Section headings with offsets, to attribute each table to mainboard/SME.
  const headingRe = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  const headings = [];
  let hm;
  while ((hm = headingRe.exec(clean_html))) headings.push({ index: hm.index, text: clean(hm[1]).toLowerCase() });

  const segmentFor = (tableIndex, order) => {
    let seg = null;
    for (const h of headings) {
      if (h.index > tableIndex) break;
      if (/\bsme\b/.test(h.text)) seg = 'sme';
      else if (/main\s*board/.test(h.text)) seg = 'mainboard';
    }
    return seg || (order === 0 ? 'mainboard' : 'sme');
  };

  const ipos = [];
  let gmpTableOrder = 0;
  for (const table of tables) {
    const header = table.rows[0].map(clean);
    const ht = header.join(' | ').toLowerCase();
    if (!(/gmp/.test(ht) && /price band/.test(ht) && /status/.test(ht))) continue;
    const idx = buildHeaderIndex(header);
    const seg = segmentFor(table.index, gmpTableOrder);
    gmpTableOrder += 1;
    for (const row of table.rows.slice(1)) {
      const nameRaw = idx.name != null && row[idx.name] != null ? row[idx.name] : row[0];
      const name = clean(nameRaw);
      if (!name || /^ipo name$/i.test(name)) continue;
      const at = (i) => (i == null || row[i] == null ? '' : clean(row[i]));
      const href = normalizeUrl(firstHref(nameRaw) || firstHref(row.join(' ')));
      const listing = at(idx.listing);
      ipos.push({
        name,
        segment: seg,
        detailUrl: href,
        slug: slugFromUrl(href),
        gmp: money(at(idx.gmp)),
        gmpText: at(idx.gmp),
        trend: trendFrom(row[idx.trend] != null ? row[idx.trend] : ''),
        priceBandUpper: upperBand(at(idx.band)),
        priceBandText: at(idx.band),
        estListing: money(listing),
        estGainPct: percent(listing),
        dateText: at(idx.date),
        status: at(idx.status),
        lastUpdated: at(idx.updated),
      });
    }
  }
  return ipos;
}

function parseTrackRecord(html) {
  const tables = getTables(stripInert(html));
  let best = null;
  for (const table of tables) {
    if (table.rows.length < 5) continue;
    const header = table.rows[0].map(clean);
    const h = header.join(' | ').toLowerCase();
    if (!(/ipo price/.test(h) && /listing price/.test(h) && /gmp/.test(h))) continue;
    const iP = idxOf(header, /ipo price/);
    const iG = idxOf(header, /gmp/);
    const iL = idxOf(header, /listing price/);
    const listings = table.rows
      .slice(1)
      .map((r) => {
        const ip = money(clean(r[iP >= 0 ? iP : 1]));
        const gmp = money(clean(r[iG >= 0 ? iG : 2]));
        const ls = money(clean(r[iL >= 0 ? iL : 3]));
        const gainPct = ip && ls != null ? ((ls - ip) / ip) * 100 : null;
        return { ip, gmp, gainPct };
      })
      .filter((x) => x.ip != null);
    if (listings.length && (!best || listings.length > best.length)) best = listings;
  }
  if (!best) return null;
  const withData = best.filter((x) => x.gmp != null && x.gainPct != null);
  const posGmp = withData.filter((x) => x.gmp > 0);
  const green = posGmp.filter((x) => x.gainPct > 0);
  return {
    sampleSize: best.length,
    positiveGmpCount: posGmp.length,
    positiveGmpAccuracyPct: posGmp.length ? +((green.length / posGmp.length) * 100).toFixed(1) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Detail page
 * ------------------------------------------------------------------ */

/** Slice starting at the IPO's own H1, which drops any earlier foreign-IPO widget. */
function mainRegion(html, tokens) {
  const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let m;
  let fallback = -1;
  while ((m = h1Re.exec(html))) {
    const text = clean(m[1]).toLowerCase();
    if (tokens.length && tokens.some((t) => text.includes(t))) return html.slice(m.index);
    if (fallback < 0 && /ipo/.test(text)) fallback = m.index;
  }
  return fallback >= 0 ? html.slice(fallback) : html;
}

function sectionText(blocks, regexes, tokens, maxChars) {
  for (const re of regexes) {
    let matchIdx = -1;
    let fallbackIdx = -1;
    for (let i = 0; i < blocks.length; i += 1) {
      if (!/^h[1-3]$/.test(blocks[i].tag) || !re.test(blocks[i].text)) continue;
      const hay = (blocks[i].text + ' ' + blocks[i].id).toLowerCase();
      const onTopic = !tokens.length || tokens.some((t) => hay.includes(t));
      if (onTopic && matchIdx < 0) matchIdx = i;
      else if (fallbackIdx < 0) fallbackIdx = i;
    }
    const start = matchIdx >= 0 ? matchIdx : fallbackIdx;
    if (start < 0) continue;
    const parts = [];
    for (let j = start + 1; j < blocks.length && !/^h[1-3]$/.test(blocks[j].tag); j += 1) parts.push(blocks[j].text);
    let text = parts.join(' ').trim();
    if(!text) continue;
    if(text.length > maxChars) text = text.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
    return text;
    // const text = parts.join(' ').slice(0, maxChars);
    // if (text) return text;
  }
  return null;
}

function findTable(tables, headerPred) {
  for (const table of tables) {
    const header = table.rows[0].map(clean);
    if (headerPred(lc(header).join(' '), header)) return table.rows.map((r) => r.map(clean));
  }
  return null;
}

function trendOf(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => x != null);
  if (v.length < 2) return null;
  return v[v.length - 1] > v[0] ? 'up' : v[v.length - 1] < v[0] ? 'down' : 'flat';
}

function parseDetail(rawHtml, slug) {
  const tokens = slugTokens(slug);
  const html = mainRegion(stripInert(rawHtml), tokens);
  const tables = getTables(html);
  const blocks = getBlocks(html);
  const out = {};

  out.about = sectionText(
    blocks,
    [/about .* ipo/i, /^about\b/i, /(company|business) (overview|profile|description|snapshot)/i, /about (the )?company/i],
    tokens,
    1200
  );

  const fin = findTable(tables, (h) => /revenue/.test(h) && /(pat|profit)/.test(h));
  if (fin) {
    const H = fin[0];
    const iPer = idxOf(H, /period|year|ended|fiscal|fy/);
    const iRev = idxOf(H, /revenue/);
    const iExp = idxOf(H, /expense/);
    const iPat = idxOf(H, /pat|profit/);
    const iAss = idxOf(H, /asset/);
    out.financials = fin
      .slice(1)
      .map((c) => ({
        period: c[iPer >= 0 ? iPer : 0],
        revenue: num(c[iRev]),
        expense: num(c[iExp]),
        pat: num(c[iPat]),
        assets: num(c[iAss]),
      }))
      .filter((r) => r.period && !/period|ended/i.test(r.period));
    out.revenueTrend = trendOf(out.financials, 'revenue');
    out.patTrend = trendOf(out.financials, 'pat');
  }

  const kpi = findTable(tables, (h, header) => /kpi/.test(header[0] || '') || (header.length === 2 && /^values?$/i.test(header[1] || '')));
  if (kpi) {
    const kv = {};
    kpi.forEach((r) => {
      if (r.length >= 2 && r[0] && !/^kpi$/i.test(r[0]) && !/^values?$/i.test(r[1])) kv[r[0].replace(/:$/, '').trim().toLowerCase()] = r[1];
    });
    const getK = (re) => {
      for (const k in kv) if (re.test(k)) return kv[k];
      return null;
    };
    out.fundamentals = {
      roe: num(getK(/^roe|return on equity/)),
      ronw: num(getK(/ronw|return on net worth/)),
      ebitdaMargin: num(getK(/ebitda margin/)),
      patMargin: num(getK(/pat margin|net.*margin/)),
      debtEquity: num(getK(/debt.*equity/)),
      eps: num(getK(/earning.*per share|\beps\b/)),
      pe: num(getK(/p\/e|price\/earning/)),
      nav: num(getK(/nav|net asset value/)),
    };
    out.issuePE = out.fundamentals.pe;
  }

  const peerRows = findTable(tables, (h) => /p\/?e|pe ratio/.test(h) && /(company|name|eps)/.test(h));
  if (peerRows) {
    const H = peerRows[0];
    const iN = idxOf(H, /company|name/);
    const iPE = idxOf(H, /p\/?e|pe ratio/);
    out.peers = peerRows
      .slice(1)
      .map((c) => ({ name: c[iN >= 0 ? iN : 0], pe: num(c[iPE]) }))
      .filter((p) => p.name && !/listed peers/i.test(p.name) && p.pe != null && p.pe > 0);
    const pes = out.peers.map((p) => p.pe).sort((a, b) => a - b);
    if (pes.length) out.peerMedianPE = +(pes.length % 2 ? pes[(pes.length - 1) / 2] : (pes[pes.length / 2 - 1] + pes[pes.length / 2]) / 2).toFixed(2);
  }

  const hold = findTable(tables, (h) => /post ipo/.test(h) && /(promoter|particular|shares)/.test(h));
  if (hold) {
    const H = lc(hold[0]);
    let iPost = -1;
    H.forEach((x, i) => {
      if (/post.*%/.test(x)) iPost = i;
    });
    const prow = hold.find((r) => /promoter/i.test(r[0] || ''));
    if (prow && iPost >= 0) out.promoterPostPct = percent(prow[iPost]);
  }

  const bodyText = clean(html);
  const fm = bodyText.match(/fresh issue[^₹0-9]{0,40}₹?\s*([\d,]+(?:\.\d+)?)\s*(cr|crore)/i);
  const om = bodyText.match(/offer for sale[^₹0-9]{0,40}₹?\s*([\d,]+(?:\.\d+)?)\s*(cr|crore)/i);
  if (fm) out.freshCr = money(fm[1]);
  if (om) out.ofsCr = money(om[1]);

  const sub = findTable(tables, (h) => /(subscription|subscribed)/.test(h) && /(time|category|qib)/.test(h));
  if (sub) {
    const s = {};
    sub.slice(1).forEach((r) => {
      const k = (r[0] || '').toLowerCase();
      const v = num(r[r.length - 1]);
      if (v == null) return;
      if (/qib/.test(k)) s.qib = v;
      else if (/nii|hni|non.inst/.test(k)) s.nii = v;
      else if (/retail|rii/.test(k)) s.retail = v;
      else if (/total|overall/.test(k)) s.overall = v;
    });
    if (Object.keys(s).length) out.subscription = s;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    // eslint-disable-next-line no-await-in-loop
    const res = await Promise.all(batch.map((it, j) => fn(it, i + j)));
    out.push(...res);
  }
  return out;
}

async function main() {
  console.log('Fetching GMP list…');
  const listHtml = await fetchHtml(GMP_URL);
  const ipos = parseList(listHtml);
  const trackRecord = parseTrackRecord(listHtml);
  if (!ipos.length) throw new Error('Parsed 0 IPOs — source layout may have changed.');
  console.log(`Found ${ipos.length} IPOs. Enriching detail pages…`);

  await mapLimit(ipos, CONCURRENCY, async (ipo) => {
    if (!ipo.detailUrl) return;
    try {
      const detailHtml = await fetchHtml(ipo.detailUrl);
      Object.assign(ipo, parseDetail(detailHtml, ipo.slug));
    } catch (err) {
      ipo.enrichError = String(err && err.message ? err.message : err).slice(0, 120);
      console.warn(`  ! ${ipo.name}: ${ipo.enrichError}`);
    }
  });

  const data = {
    generatedAt: new Date().toISOString(),
    source: GMP_URL,
    disclaimer:
      'GMP (Grey Market Premium) is an unofficial, speculative indicator from the unregulated grey market ' +
      'and can change daily. Nothing here is investment advice.',
    trackRecord,
    ipos,
  };

  // Reuse the previous timestamp when nothing else changed, so the CI "commit if
  // changed" guard short-circuits instead of committing/redeploying on every run.
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const same = JSON.stringify({ ...prev, generatedAt: 0 }) === JSON.stringify({ ...data, generatedAt: 0 });
    if (same && prev.generatedAt) data.generatedAt = prev.generatedAt;
  } catch { /* no previous data.json — first run */ }

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  const enriched = ipos.filter((x) => x.financials || x.fundamentals).length;
  console.log(`Wrote ${OUT} — ${ipos.length} IPOs, ${enriched} enriched.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('SCRAPE FAILED:', err);
    process.exit(1);
  });
}

module.exports = { parseList, parseTrackRecord, parseDetail, getTables, getBlocks, clean, num, money, percent };
