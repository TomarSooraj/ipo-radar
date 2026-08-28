'use strict';

/**
 * Offline unit tests for the zero-dep parser in scrape.js.
 * Uses small handcrafted HTML that mirrors ipowatch.in's real structure —
 * including a decoy foreign-IPO block placed BEFORE the target's own <h1>, to
 * prove the "main region" logic skips cross-article noise.
 *
 *   node scripts/test-parse.js
 */

const assert = require('assert');
const { parseList, parseTrackRecord, parseDetail } = require('./scrape');

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
};

/* ---- list parsing ---- */
const LIST_HTML = `
<h2>Current Mainboard IPO</h2>
<table>
<tr><th>IPO Name</th><th>IPO GMP*</th><th>Trend</th><th>Price Band</th><th>Est. Listing</th><th>Date</th><th>Status</th><th>Last Updated</th></tr>
<tr><td><a href="https://ipowatch.in/foo-bar-ipo/">Foo Bar</a></td><td>₹285</td><td>🟢</td><td>₹429</td><td>₹714 (66.43%)</td><td>28-1 September</td><td>Upcoming</td><td>25 Aug</td></tr>
</table>
<h2>Current SME IPO</h2>
<table>
<tr><th>IPO Name</th><th>IPO GMP*</th><th>Trend</th><th>Price Band</th><th>Est. Listing</th><th>Date</th><th>Status</th><th>Last Updated</th></tr>
<tr><td><a href="https://ipowatch.in//baz-qux-ipo/">Baz Qux</a></td><td>₹0</td><td>🟡</td><td>₹100</td><td>₹- (0.00%)</td><td>1-3 Sep</td><td>Upcoming</td><td>25 Aug</td></tr>
</table>
<h3>Recently Listed IPO</h3>
<table>
<tr><th>IPO Name</th><th>IPO Price</th><th>IPO GMP</th><th>Listing Price</th></tr>
<tr><td>A</td><td>100</td><td>20</td><td>130</td></tr>
<tr><td>B</td><td>100</td><td>10</td><td>90</td></tr>
<tr><td>C</td><td>100</td><td>50</td><td>180</td></tr>
<tr><td>D</td><td>100</td><td>0</td><td>101</td></tr>
<tr><td>E</td><td>100</td><td>30</td><td>140</td></tr>
</table>`;

console.log('parseList:');
const ipos = parseList(LIST_HTML);
const foo = ipos.find((x) => x.name === 'Foo Bar');
const baz = ipos.find((x) => x.name === 'Baz Qux');
check('parses two IPOs', ipos.length === 2);
check('mainboard segment', foo.segment === 'mainboard');
check('SME segment', baz.segment === 'sme');
check('GMP number', foo.gmp === 285);
check('expected gain %', foo.estGainPct === 66.43);
check('upper price band', foo.priceBandUpper === 429);
check('trend up from 🟢', foo.trend === 'up');
check('detail URL captured', foo.detailUrl === 'https://ipowatch.in/foo-bar-ipo/');
check('double-slash URL normalized', baz.detailUrl === 'https://ipowatch.in/baz-qux-ipo/');
check('zero GMP handled', baz.gmp === 0);

console.log('parseTrackRecord:');
const track = parseTrackRecord(LIST_HTML);
// positive-GMP rows: A(+),B(-),C(+),E(+) -> 4 with GMP>0, 3 green => 75%
check('track record sample size', track.sampleSize === 5);
check('positive-GMP count', track.positiveGmpCount === 4);
check('accuracy % (3 of 4 green)', track.positiveGmpAccuracyPct === 75);

/* ---- detail parsing with decoy noise before the real H1 ---- */
const DETAIL_HTML = `
<h1>Q-Line Biotech NSE SME IPO review</h1>
<h2>Company Financial Report</h2>
<table><tr><th>Period Ended</th><th>Revenue</th><th>Expense</th><th>PAT</th><th>Assets</th></tr>
<tr><td>2024</td><td>₹999</td><td>₹1</td><td>₹999</td><td>₹1</td></tr></table>
<h1>Foo Bar IPO Date, Review, Price, Allotment Details</h1>
<h2 id="h-about-foo-bar-ipo">About Foo Bar IPO</h2>
<p>Foo Bar Limited makes premium widgets for enterprises.</p>
<h2>Company Financial Report</h2>
<table><tr><th>Period Ended</th><th>Revenue</th><th>Expense</th><th>PAT</th><th>Assets</th></tr>
<tr><td>2024</td><td>₹100</td><td>₹90</td><td>₹10</td><td>₹200</td></tr>
<tr><td>2025</td><td>₹150</td><td>₹120</td><td>₹30</td><td>₹250</td></tr></table>
<h2>Key Performance Indicator</h2>
<table><tr><td>KPI</td><td>Values</td></tr>
<tr><td>ROE:</td><td>25.12%</td></tr>
<tr><td>Debt to equity ratio</td><td>0.08</td></tr>
<tr><td>Price/Earning P/E Ratio</td><td>N/A</td></tr>
<tr><td>PAT Margin</td><td>(38.49)%</td></tr></table>
<h2>Promoters and Holding Pattern</h2>
<table><tr><th>Particular</th><th>Pre IPO % Shares</th><th>Post IPO % Shares</th></tr>
<tr><td>Promoter and Promoter Group</td><td>60.00%</td><td>39.47%</td></tr></table>
<h2>Peer Group Comparison</h2>
<table><tr><th>Company</th><th>EPS</th><th>PE Ratio</th></tr>
<tr><td>Alpha Ltd</td><td>10</td><td>22.24</td></tr>
<tr><td>Beta Ltd</td><td>5</td><td>10.08</td></tr></table>
<p>The company plans a Fresh Issue of ₹720 Cr.</p>`;

console.log('parseDetail (skips decoy, parses fundamentals):');
const d = parseDetail(DETAIL_HTML, 'foo-bar-ipo');
check('about text from correct company', /premium widgets/.test(d.about || ''));
check('financials skip the decoy (revenue 100 not 999)', d.financials[0].revenue === 100);
check('financials rows = 2', d.financials.length === 2);
check('revenue trend up', d.revenueTrend === 'up');
check('PAT trend up', d.patTrend === 'up');
check('ROE parsed', d.fundamentals.roe === 25.12);
check('debt/equity parsed', d.fundamentals.debtEquity === 0.08);
check('P/E is null when N/A', d.fundamentals.pe === null);
check('negative PAT margin from parentheses', d.fundamentals.patMargin === -38.49);
check('promoter post-holding %', d.promoterPostPct === 39.47);
check('peers parsed', d.peers.length === 2 && d.peerMedianPE === 16.16);
check('fresh issue ₹ crore', d.freshCr === 720);

console.log(`\nAll ${passed} checks passed.`);
