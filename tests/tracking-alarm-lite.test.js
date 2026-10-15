// Tracking Alarm Lite tests. Run: node tests/tracking-alarm-lite.test.js
// Loads the Lite script in a sandbox with test doubles for AdsApp, MailApp and
// Utilities, plus a fake clock. Nothing here talks to Google or to the network.
//
// What these tests prove:
//   - the two Lite rules (SPEND_NO_CONVERSIONS, CVR_DROP) fire and stay quiet
//     when they should;
//   - the rules of the full edition are not in Lite, and Lite never touches a
//     Google Sheet, a manager account or anything that changes the account;
//   - every email and every log ends with the full-version block and the
//     store link.
// Optional: TA_FULL_EDITION=/path/to/tracking-alarm.js runs one more test that
// compares Lite with the full edition (not included in this repository).
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const LITE = fs.readFileSync(path.join(__dirname, '..', 'tracking-alarm-lite.js'), 'utf8');
const FULL_PATH = process.env.TA_FULL_EDITION || '';
const STORE = 'https://carlesmister.gumroad.com/l/tracking-alarm';
const UPGRADE_TITLE = 'Full version: all rules, MCC, alert book with escalation';
let passed = 0, skipped = 0;
function test(name, fn) { fn(); passed++; console.log('OK   ' + name); }
function skip(name, why) { skipped++; console.log('SKIP ' + name + ' (' + why + ')'); }

const DAY = 24 * 3600000;
const T0 = Date.UTC(2026, 9, 5, 7, 0, 0);            // 2026-10-05 07:00 UTC
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const camel = s => s.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
const iter = items => { let n = 0; return { hasNext: () => n < items.length, next: () => items[n++] }; };

// --- account double ------------------------------------------------------------
// spec: {id, name, currency, daily(off) -> {clicks, cost, conv, value}, actions:[{key, name, meta, series(off)}]}
// off = days ago (1 = yesterday). Per-action rows exist only for the full
// edition (parity test); Lite must never ask for them.
const HEALTHY = () => ({ clicks: 100, cost: 50, conv: 5, value: 186.5 });
function action(name, series, meta) {
  return { key: 'customers/1/conversionActions/' + name.replace(/\W/g, ''), name, series,
           meta: Object.assign({ status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', primary: true,
                                 counting: 'ONE_PER_CLICK', defaultValue: 1, alwaysDefault: false }, meta || {}) };
}
function acct(over) {
  const spec = Object.assign({ id: '111-111-1111', name: 'Shop A', currency: 'EUR', daily: HEALTHY }, over || {});
  if (!spec.actions) spec.actions = [action('Purchase', off => { const d = spec.daily(off); return { all: d.conv, conv: d.conv, value: d.value }; })];
  return spec;
}
function makeAccount(spec, st, clock) {
  const account = { getCustomerId: () => spec.id, getName: () => spec.name, getCurrencyCode: () => spec.currency, getTimeZone: () => 'UTC' };
  const metric = (field, v) => {
    if (field === 'clicks') return v.clicks;
    if (field === 'cost_micros') return String(Math.round(v.cost * 1e6));   // int64 comes as a string
    if (/^conversions(_by_conversion_date)?$/.test(field)) return v.conv;
    if (/^conversions_value(_by_conversion_date)?$/.test(field)) return v.value;
    if (/^all_conversions(_by_conversion_date)?$/.test(field)) return v.all === undefined ? v.conv : v.all;
    throw new Error('unexpected metric ' + field);
  };
  const search = q => {
    st.queries.push(q);
    assert(/^SELECT /.test(q), 'only SELECT queries: ' + q);
    if (spec.failAll) throw new Error('account not accessible');
    if (/FROM conversion_action\b/.test(q)) {
      if (spec.failMeta) throw new Error('meta denied');
      return iter(spec.actions.map(a => ({ conversionAction: { resourceName: a.key, name: a.name, status: a.meta.status,
        type: a.meta.type, category: a.meta.category, primaryForGoal: a.meta.primary, countingType: a.meta.counting,
        valueSettings: { defaultValue: a.meta.defaultValue, alwaysUseDefaultValue: a.meta.alwaysDefault } } })));
    }
    const m = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(q);
    assert(m, 'query without a date range: ' + q);
    const from = m[1], to = m[2];
    assert(to < ymd(clock.t), 'a query includes today (incomplete day): ' + q);
    const fields = (q.split(' FROM ')[0].match(/metrics\.[a-z_]+/g) || []).map(x => x.slice(8));
    const rows = [];
    const perAction = /segments\.conversion_action\b/.test(q);
    for (const a of (perAction ? spec.actions : [null])) for (let off = 1; off <= 70; off++) {
      const date = ymd(clock.t - off * DAY);
      if (date < from || date > to) continue;
      const v = a ? a.series(off) : spec.daily(off), metrics = {};
      fields.forEach(f => { metrics[camel(f)] = metric(f, v); });
      rows.push(a ? { segments: { date, conversionAction: a.key, conversionActionName: a.name }, metrics } : { segments: { date }, metrics });
    }
    return iter(rows);
  };
  return { account, search };
}

// --- sandbox -----------------------------------------------------------------------
function sandbox(source, spec, opts) {
  opts = opts || {};
  const clock = { t: opts.t0 || T0 };
  const st = { emails: [], queries: [], sleeps: [], logs: [], access: new Set(), forbidden: [], mailFails: opts.mailFails || 0 };
  const acc = makeAccount(spec, st, clock);
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }
  const adsImpl = {
    currentAccount: () => acc.account,
    getExecutionInfo: () => ({ isPreview: () => !!opts.preview }),
    search: q => acc.search(q)
  };
  const record = obj => new Proxy(obj, { get: (_, k) => { st.access.add(String(k)); return obj[k]; } });
  // Services Lite must never use: any access is recorded and fails.
  const trap = name => new Proxy({}, { get: (_, k) => { st.forbidden.push(name + '.' + String(k)); throw new Error(name + ' is not used by Lite'); } });
  const fmt = (d, tz, p) => {
    const s = d.toISOString();
    if (p === 'yyyy-MM-dd') return s.slice(0, 10);
    if (p === 'yyyy-MM-dd HH:mm') return s.slice(0, 16).replace('T', ' ');
    if (p === 'yyyy-MM-dd HH:mm:ss') return s.slice(0, 19).replace('T', ' ');
    if (p === 'dd-MM') return s.slice(8, 10) + '-' + s.slice(5, 7);
    throw new Error('unexpected date pattern ' + p);
  };
  const c = {
    Logger: { log: s => st.logs.push(String(s)) }, Date: FakeDate,
    Utilities: { formatDate: fmt, sleep: ms => st.sleeps.push(ms) },
    AdsApp: record(adsImpl),
    MailApp: {
      getRemainingDailyQuota: () => 100,
      sendEmail: m => { if (st.mailFails > 0) { st.mailFails--; throw new Error('mail server busy'); } st.emails.push(m); }
    },
    SpreadsheetApp: trap('SpreadsheetApp'), AdsManagerApp: trap('AdsManagerApp'),
    PropertiesService: trap('PropertiesService'), UrlFetchApp: trap('UrlFetchApp')
  };
  vm.createContext(c);
  vm.runInContext(source || LITE, c);
  c.CONFIG.ALERT_EMAILS = ['alerts@example.com'];
  patchConfig(c.CONFIG, opts.config || {});
  c.st = st;
  return c;
}
function patchConfig(target, patch) {
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) patchConfig(target[k], patch[k]);
    else target[k] = patch[k];
  }
}
const run = c => c.main();
const rules = r => r.findings.map(f => f.rule).sort();
const only = (r, rule) => r.findings.filter(f => f.rule === rule);
const throws = (fn, re) => { let msg = ''; try { fn(); } catch (e) { msg = e.message; } assert(re.test(msg), 'expected error ' + re + ', got: "' + msg + '"'); };
const lastLog = c => c.st.logs[c.st.logs.length - 1];
function assertReadOnly(c) {
  assert.deepEqual(c.st.forbidden, [], 'forbidden service used: ' + c.st.forbidden.join(', '));
  for (const k of c.st.access) assert(['currentAccount', 'getExecutionInfo', 'search'].includes(k), 'AdsApp member used that is not read-only: ' + k);
  c.st.queries.forEach(q => assert(!/segments\.conversion_action\b/.test(q), 'per-action query (full edition only): ' + q));
}
function assertUpgradeLast(text) {
  const i = text.lastIndexOf(UPGRADE_TITLE);
  assert(i >= 0, 'full-version block missing');
  assert(text.indexOf(STORE, i) > i, 'store link missing after the full-version block');
}

// Typical broken-tracking patterns ------------------------------------------------
const NO_CONV_7D = off => off <= 7 ? { clicks: 90, cost: 40, conv: 0, value: 0 } : HEALTHY(off);          // 280 EUR, 630 clicks
const NO_CONV_7D_SMALL = off => off <= 7 ? { clicks: 20, cost: 10, conv: 0, value: 0 } : HEALTHY(off);    // 70 EUR, 140 clicks
const CVR_DROP = off => off <= 7 ? { clicks: 100, cost: 50, conv: 1, value: 37 } : HEALTHY(off);
const CVR_ROSE = off => off <= 7 ? { clicks: 130, cost: 50, conv: 1, value: 37 } : HEALTHY(off);
const NO_BASE = () => ({ clicks: 20, cost: 10, conv: 0, value: 0 });
// 5 conversions a month at 60 each; budget tripled in the last 7 days: 210 spent = 3.5 usual CPAs.
const SURGE = off => off <= 7 ? { clicks: 20, cost: 30, conv: 0, value: 0 } : { clicks: 20, cost: 10, conv: [8, 14, 20, 26, 32].includes(off) ? 1 : 0, value: 0 };
// 5 conversions a month, 7 quiet days -> e^(-5/30*7) = 31%.
const LOW_VOL = off => off <= 7 ? { clicks: 20, cost: 10, conv: 0, value: 0 } : { clicks: 20, cost: 10, conv: [8, 14, 20, 26, 32].includes(off) ? 1 : 0, value: 0 };

// =============================================================================
// Static checks
// =============================================================================
test('pure ASCII (safe to paste in the Google Ads editor)', () => {
  const bad = [...LITE].findIndex(ch => ch.charCodeAt(0) > 127);
  assert.equal(bad, -1, 'non-ASCII character at index ' + bad);
});
test('no third-party domains or branding: example.com is the only domain besides the store link', () => {
  const domains = LITE.split(STORE).join('').match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|es|net|org|io|co|br|de|fr|uk|app|ai)\b/gi) || [];
  domains.forEach(d => assert.equal(d.toLowerCase(), 'example.com', 'unexpected domain in script: ' + d));
});
test('the store link appears exactly once, in TAL_STORE_URL', () => {
  assert.equal(LITE.split(STORE).length - 1, 1);
  assert(LITE.includes("var TAL_STORE_URL = '" + STORE + "';"));
});
test('read-only by construction: no Google Ads mutation call, no Sheet, no MCC, no other service', () => {
  const bad = LITE.match(/\.(pause|enable|remove|applyLabel|removeLabel|createLabel|setStatus|setAmount|setCpc|bidding|newCampaignBuilder|bulkUploads|mutate|mutateAll)\s*\(/g);
  assert.equal(bad, null, 'mutation call found: ' + bad);
  for (const w of ['SpreadsheetApp', 'AdsManagerApp', 'executeInParallel', 'PropertiesService', 'UrlFetchApp', 'DriveApp'])
    assert(!LITE.includes(w), 'forbidden token in Lite source: ' + w);
  (LITE.match(/'SELECT [^']*/g) || []).forEach(q => assert(!/\b(INSERT|UPDATE|DELETE|MUTATE)\b/i.test(q)));
});
test('only the two Lite rules: the rules and features of the full edition are not in the code', () => {
  for (const w of ['FIXED_VALUE', 'SILENT_ACTION', 'DUPLICATES', 'NOT_CHECKED', 'MISSED_RUN', 'ESCALATION', 'SHEET_URL', 'MUTE',
    'segments.conversion_action', 'all_conversions', 'BRAND_', 'REPORT_LANGUAGE'])
    assert(!LITE.includes(w), 'full-edition token in Lite source: ' + w);
  const c = sandbox(LITE, acct());
  assert.deepEqual(Object.keys(c.CONFIG.RULES), ['SPEND_NO_CONVERSIONS', 'CVR_DROP']);
  assert.deepEqual(Array.from(c.TA_RULES), ['SPEND_NO_CONVERSIONS', 'CVR_DROP']);
});
test('defaults as documented; version 1.0.0', () => {
  const c = sandbox(LITE, acct());
  const cfg = c.taConfig(c.CONFIG);
  assert.equal(c.TA_VERSION, '1.0.0');
  assert.equal(cfg.SEND_EMAIL, 'auto'); assert.equal(cfg.EMAIL_IN_PREVIEW, true); assert.equal(cfg.COUNT_CONVERSIONS_BY, 'conversion_date');
  assert.equal(cfg.MAX_CHANCE, 0.10);
  assert.deepEqual(JSON.parse(JSON.stringify(cfg.RULES)), {
    SPEND_NO_CONVERSIONS: { ENABLED: true, MIN_COST: 50, MIN_CLICKS: 10, STRONG_COST_MULTIPLIER: 3 },
    CVR_DROP: { ENABLED: true, MIN_CLICKS: 50, MIN_BASE_CONVERSIONS: 15, MAX_TRAFFIC_DROP: 0.2, MIN_CVR_DROP: 0.6, SKIP_IF_SPEND_NO_CONVERSIONS: true }
  });
});

// =============================================================================
// Configuration
// =============================================================================
test('config validation stops on typos before reading anything; full-edition rule names are refused clearly', () => {
  const bad = [
    [{ ALERT_EMAILS: ['not-an-email'] }, /not a valid email/],
    [{ ALERT_EMAILS: [] }, /ALERT_EMAILS is empty/],
    [{ SEND_EMAIL: 'yes' }, /SEND_EMAIL must be/],
    [{ EMAIL_IN_PREVIEW: 'no' }, /EMAIL_IN_PREVIEW must be true or false/],
    [{ COUNT_CONVERSIONS_BY: 'day' }, /COUNT_CONVERSIONS_BY/],
    [{ MAX_CHANCE: 2 }, /MAX_CHANCE must be a number between 0.001 and 0.5/],
    [{ RULES: { SPEND_NO_CONVERSIONS: { MIN_COST: '50' } } }, /MIN_COST must be a number/],
    [{ RULES: { CVR_DROP: { MIN_CVR_DROP: 60 } } }, /MIN_CVR_DROP must be a number between 0 and 1/],
    [{ RULES: { CVR_DROP: { ENABLED: 'true' } } }, /ENABLED must be true or false/],
    [{ RULES: { FIXED_VALUE: { ENABLED: true } } }, /"FIXED_VALUE" is not a rule of Tracking Alarm Lite\. Lite checks SPEND_NO_CONVERSIONS and CVR_DROP; the other rules are in the full edition/],
    [{ RULES: { DUPLICATES: { ENABLED: true } } }, /"DUPLICATES" is not a rule of Tracking Alarm Lite/],
    [{ RULES: { SPEND_NO_CONVERSION: { ENABLED: false } } }, /"SPEND_NO_CONVERSION" is not a rule/]
  ];
  for (const [patch, re] of bad) {
    const c = sandbox(LITE, acct(), { config: patch });
    throws(() => c.main(), re);
    assert.equal(c.st.queries.length, 0, 'nothing is read when CONFIG is wrong');
    assert.equal(c.st.emails.length, 0);
  }
  const ok = sandbox(LITE, acct(), { config: { ALERT_EMAILS: 'a@example.com, b@example.com' } });
  assert.deepEqual(Array.from(ok.taConfig(ok.CONFIG).ALERT_EMAILS), ['a@example.com', 'b@example.com']);
});
test('full-edition settings pasted into Lite (SHEET_URL, ESCALATION_EMAILS, MUTE) are ignored: no Sheet, one email to ALERT_EMAILS only', () => {
  const c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { config: {
    SHEET_URL: 'https://docs.google.com/spreadsheets/d/TEST/edit', ESCALATION_EMAILS: ['boss@example.com'],
    MUTE: ['SPEND_NO_CONVERSIONS'], ESCALATION: { LEVEL1_HOURS: 1, LEVEL2_HOURS: 2, LEVEL3_HOURS: 3, MISSED_RUN_HOURS: 1 } } });
  const r = run(c);
  assertReadOnly(c);
  assert.deepEqual(rules(r), ['SPEND_NO_CONVERSIONS'], 'MUTE does not exist in Lite');
  assert.equal(c.st.emails.length, 1);
  assert.equal(c.st.emails[0].to, 'alerts@example.com');
});

// =============================================================================
// Queries
// =============================================================================
test('queries: two read-only SELECTs, complete days only, no per-action data', () => {
  const c = sandbox(LITE, acct());
  run(c);
  assertReadOnly(c);
  const qs = c.st.queries;
  assert.equal(qs.length, 2);
  assert.equal(qs[0], "SELECT segments.date, metrics.clicks, metrics.cost_micros, metrics.conversions_by_conversion_date, metrics.conversions_value_by_conversion_date FROM customer WHERE segments.date BETWEEN '2026-08-06' AND '2026-10-04'");
  assert.equal(qs[1], 'SELECT conversion_action.name, conversion_action.status FROM conversion_action');
  const k = sandbox(LITE, acct(), { config: { COUNT_CONVERSIONS_BY: 'click_date' } });
  run(k);
  assert(/metrics\.conversions, metrics\.conversions_value FROM customer/.test(k.st.queries[0]) && !/by_conversion_date/.test(k.st.queries[0]));
  const off = sandbox(LITE, acct(), { config: { RULES: { SPEND_NO_CONVERSIONS: { ENABLED: false } } } });
  run(off);
  assert.equal(off.st.queries.length, 1, 'the conversion action list is only read for rule 1');
});
test('healthy account: no finding, no email (SEND_EMAIL auto); the log still ends with the full-version block', () => {
  const c = sandbox(LITE, acct());
  const r = run(c);
  assert.equal(r.findings.length, 0);
  assert.equal(c.st.emails.length, 0);
  assert.equal(r.email.status, 'NOT_REQUIRED');
  assert(/^Tracking Alarm Lite 1\.0\.0 - Shop A \(111-111-1111\): 0 finding\(s\), email NOT_REQUIRED/.test(lastLog(c)));
  assertUpgradeLast(lastLog(c));
  assert(lastLog(c).endsWith('Get the full edition: ' + STORE));
});

// =============================================================================
// Rule 1 - SPEND_NO_CONVERSIONS
// =============================================================================
test('SPEND_NO_CONVERSIONS fires: spend over threshold, enough clicks, 0 conversions in 7 days', () => {
  const r = run(sandbox(LITE, acct({ daily: NO_CONV_7D })));
  const f = only(r, 'SPEND_NO_CONVERSIONS');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'CRITICAL');
  assert(/^Shop A \(111-111-1111\): 280\.00 EUR spent and 0 conversions in the last 7 days \(630 clicks; threshold 50\.00 EUR\)/.test(f[0].headline), f[0].headline);
  assert(/Last conversion on 2026-09-27, 7 days ago/.test(f[0].headline));
  assert(!rules(r).includes('CVR_DROP'), 'CVR_DROP does not repeat rule 1');
});
test('SPEND_NO_CONVERSIONS does not fire: below cost threshold, below MIN_CLICKS, or one conversion', () => {
  const low = off => off <= 7 ? { clicks: 20, cost: 6, conv: 0, value: 0 } : HEALTHY(off);          // 42 EUR
  assert(!rules(run(sandbox(LITE, acct({ daily: low })))).includes('SPEND_NO_CONVERSIONS'));
  const fewClicks = off => off <= 7 ? { clicks: 1, cost: 40, conv: 0, value: 0 } : HEALTHY(off);    // 280 EUR, 7 clicks
  assert(!rules(run(sandbox(LITE, acct({ daily: fewClicks })))).includes('SPEND_NO_CONVERSIONS'));
  const one = off => off === 3 ? { clicks: 80, cost: 40, conv: 1, value: 37 } : NO_CONV_7D(off);
  assert(!rules(run(sandbox(LITE, acct({ daily: one })))).includes('SPEND_NO_CONVERSIONS'));
  const higher = sandbox(LITE, acct({ daily: NO_CONV_7D }), { config: { RULES: { SPEND_NO_CONVERSIONS: { MIN_COST: 300 } } } });
  assert.deepEqual(rules(run(higher)), ['CVR_DROP'], 'MIN_COST is honoured (280 < 300); the collapse is then reported by rule 2');
});
test('SPEND_NO_CONVERSIONS strength: STRONG on no baseline, unlikely silence or 3x the usual cost per conversion; WEAK on plausible bad luck', () => {
  let f = only(run(sandbox(LITE, acct({ daily: NO_BASE }))), 'SPEND_NO_CONVERSIONS')[0];
  assert.equal(f.strength, 'STRONG'); assert(/No conversion at all in the last 60 days: there is no baseline/.test(f.headline));
  f = only(run(sandbox(LITE, acct({ daily: NO_CONV_7D }))), 'SPEND_NO_CONVERSIONS')[0];
  assert.equal(f.strength, 'STRONG'); assert(/Chance that this silence is just bad luck: 0%/.test(f.headline));
  f = only(run(sandbox(LITE, acct({ daily: NO_CONV_7D_SMALL }))), 'SPEND_NO_CONVERSIONS')[0];
  assert.equal(f.strength, 'STRONG');
  f = only(run(sandbox(LITE, acct({ daily: SURGE }))), 'SPEND_NO_CONVERSIONS')[0];
  assert.equal(f.strength, 'STRONG');
  assert(/at about 60\.00 EUR each\. The account spent 3\.5x its usual cost per conversion/.test(f.headline), f.headline);
  f = only(run(sandbox(LITE, acct({ daily: LOW_VOL }))), 'SPEND_NO_CONVERSIONS')[0];
  assert.equal(f.strength, 'WEAK'); assert(/bad luck: 31%/.test(f.headline), f.headline);
});
test('SPEND_NO_CONVERSIONS says when the account has no enabled conversion action; a failed read is a note, not an error', () => {
  const spec = acct({ daily: NO_CONV_7D });
  spec.actions = [action('Old form', () => ({ all: 0, conv: 0, value: 0 }), { status: 'REMOVED' })];
  assert(/NO enabled conversion action/.test(only(run(sandbox(LITE, spec)), 'SPEND_NO_CONVERSIONS')[0].headline));
  const c = sandbox(LITE, acct({ daily: NO_CONV_7D, failMeta: true }));
  const r = run(c);
  assert.deepEqual(rules(r), ['SPEND_NO_CONVERSIONS']);
  assert(/conversion action settings could not be read \(meta denied\)/.test(r.notes[0]));
  assert(c.st.emails[0].htmlBody.includes('meta denied'));
});
test('SPEND_NO_CONVERSIONS can be switched off', () => {
  const r = run(sandbox(LITE, acct({ daily: NO_CONV_7D }), { config: { RULES: { SPEND_NO_CONVERSIONS: { ENABLED: false } } } }));
  assert.deepEqual(rules(r), ['CVR_DROP'], 'with rule 1 off, the collapse is reported by rule 2');
});

// =============================================================================
// Rule 2 - CVR_DROP
// =============================================================================
test('CVR_DROP fires when conversion rate collapses and clicks hold (and says if clicks rose)', () => {
  let f = only(run(sandbox(LITE, acct({ daily: CVR_DROP }))), 'CVR_DROP');
  assert.equal(f.length, 1); assert.equal(f[0].strength, 'STRONG'); assert.equal(f[0].severity, 'CRITICAL');
  assert(/conversion rate 5\.00% -> 1\.00% \(-80%\) while daily clicks fell 0% \(100\.0 -> 100\.0\), on a baseline of 150\.0 conversions/.test(f[0].headline), f[0].headline);
  f = only(run(sandbox(LITE, acct({ daily: CVR_ROSE }))), 'CVR_DROP');
  assert(/daily clicks rose 30%/.test(f[0].headline), 'never prints a negative drop when traffic rose');
});
test('CVR_DROP does not fire: traffic fell too, small baseline, too few clicks, moderate drop, switched off', () => {
  const trafficFell = off => off <= 7 ? { clicks: 50, cost: 25, conv: 0.5, value: 18 } : HEALTHY(off);
  assert(!rules(run(sandbox(LITE, acct({ daily: trafficFell })))).includes('CVR_DROP'));
  const smallBase = off => off <= 7 ? { clicks: 100, cost: 50, conv: 0.1, value: 4 } : { clicks: 100, cost: 50, conv: off % 3 === 0 ? 1 : 0, value: 37 };
  assert(!rules(run(sandbox(LITE, acct({ daily: smallBase })))).includes('CVR_DROP'), '10 conversions < 15 baseline');
  const fewClicks = off => off <= 7 ? { clicks: 6, cost: 5, conv: 0.05, value: 2 } : { clicks: 6, cost: 5, conv: 1, value: 37 };
  assert(!rules(run(sandbox(LITE, acct({ daily: fewClicks })))).includes('CVR_DROP'));
  const moderate = off => off <= 7 ? { clicks: 100, cost: 50, conv: 3, value: 111 } : HEALTHY(off);
  assert(!rules(run(sandbox(LITE, acct({ daily: moderate })))).includes('CVR_DROP'), '-40% is not a collapse');
  const justUnder = off => off <= 7 ? { clicks: 85, cost: 42.5, conv: 1.75, value: 65 } : HEALTHY(off);
  assert(!rules(run(sandbox(LITE, acct({ daily: justUnder })))).includes('CVR_DROP'), 'rate -59% is under MIN_CVR_DROP 60%, even with conversions per day -65%');
  const diluted = off => off <= 7 ? { clicks: 300, cost: 150, conv: 5, value: 186.5 } : HEALTHY(off);
  assert(!rules(run(sandbox(LITE, acct({ daily: diluted })))).includes('CVR_DROP'), 'clicks tripled and conversions per day held: the tag still records');
  assert.deepEqual(rules(run(sandbox(LITE, acct({ daily: CVR_DROP }), { config: { RULES: { CVR_DROP: { ENABLED: false } } } }))), []);
});
test('how fast: when all tracking stops, CVR_DROP fires on the 5th silent day and SPEND_NO_CONVERSIONS on the 7th', () => {
  const silentFor = k => off => off <= k ? { clicks: 100, cost: 50, conv: 0, value: 0 } : HEALTHY(off);
  assert.deepEqual(rules(run(sandbox(LITE, acct({ daily: silentFor(4) })))), []);
  assert.deepEqual(rules(run(sandbox(LITE, acct({ daily: silentFor(5) })))), ['CVR_DROP']);
  assert.deepEqual(rules(run(sandbox(LITE, acct({ daily: silentFor(6) })))), ['CVR_DROP']);
  assert.deepEqual(rules(run(sandbox(LITE, acct({ daily: silentFor(7) })))), ['SPEND_NO_CONVERSIONS']);
});
test('CVR_DROP is skipped when SPEND_NO_CONVERSIONS already fired, unless SKIP_IF_SPEND_NO_CONVERSIONS is false', () => {
  assert.deepEqual(rules(run(sandbox(LITE, acct({ daily: NO_CONV_7D })))), ['SPEND_NO_CONVERSIONS']);
  const r = run(sandbox(LITE, acct({ daily: NO_CONV_7D }), { config: { RULES: { CVR_DROP: { SKIP_IF_SPEND_NO_CONVERSIONS: false } } } }));
  assert.deepEqual(rules(r), ['CVR_DROP', 'SPEND_NO_CONVERSIONS']);
});

// =============================================================================
// The rules of the full edition do not exist in Lite
// =============================================================================
// Accounts that make the full edition fire its other rules.
const FULL_ONLY = {
  // Average value exactly 1.00 per conversion.
  FIXED_VALUE: () => acct({ daily: () => ({ clicks: 100, cost: 50, conv: 5, value: 5 }) }),
  // 2 conversions per click.
  DUPLICATES: () => acct({ daily: () => ({ clicks: 100, cost: 50, conv: 200, value: 7000 }) }),
  // One of two actions silent for 5 days while the other keeps recording.
  SILENT_ACTION: () => {
    const spec = acct({ daily: off => ({ clicks: 100, cost: 50, conv: off <= 5 ? 4 : 6, value: 150 }) });
    spec.actions = [action('Purchase', () => ({ all: 4, conv: 4, value: 150 })),
                    action('Contact form', off => ({ all: off <= 5 ? 0 : 2, conv: off <= 5 ? 0 : 2, value: 0 }), { category: 'CONTACT' })];
    return spec;
  }
};
test('full-edition signals never fire in Lite: round conversion value, double-firing tag, one silent action', () => {
  for (const name of Object.keys(FULL_ONLY)) {
    const c = sandbox(LITE, FULL_ONLY[name]());
    assert.deepEqual(run(c).findings, [], name + ' scenario must not produce a finding in Lite');
    assertReadOnly(c);
    assert.equal(c.st.emails.length, 0);
  }
});

// =============================================================================
// Email and log
// =============================================================================
test('email: findings, rule legend, and the full-version block with the store link as the last thing', () => {
  const c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { config: { RULES: { CVR_DROP: { SKIP_IF_SPEND_NO_CONVERSIONS: false } } } });
  run(c);
  assertReadOnly(c);
  assert.equal(c.st.emails.length, 1);
  const m = c.st.emails[0];
  assert.equal(m.subject, 'Tracking Alarm Lite - Shop A (111-111-1111) - 05-10: 2 finding(s), 2 critical');
  assert.equal(m.to, 'alerts@example.com');
  const i = m.htmlBody.indexOf('id="tracking-alarm-upgrade"');
  assert(i > 0);
  for (const sec of ['Findings in this run (2)', 'What the rules mean', 'Spend without conversions:', 'Conversion rate collapsed', 'never changes anything in Google Ads'])
    assert(m.htmlBody.indexOf(sec) > 0 && m.htmlBody.indexOf(sec) < i, 'section "' + sec + '" must come before the full-version block');
  const block = m.htmlBody.slice(i);
  assert(block.includes('<b>' + UPGRADE_TITLE + '</b>'));
  assert(/placeholder conversion values/.test(block) && /Manager account \(MCC\) edition/.test(block) && /Alert book in a Google Sheet/.test(block));
  assert(block.includes('<a href="' + STORE + '" style="color:#FF6D2E">' + STORE + '</a>'));
  assert(m.htmlBody.endsWith('</a></p></div></div>'), 'nothing after the full-version block');
  assertUpgradeLast(lastLog(c));
  assert(/\[CRITICAL\/STRONG\] SPEND_NO_CONVERSIONS - Shop A/.test(lastLog(c)));
});
test('email: SEND_EMAIL always sends an all-clear that also ends with the full-version block; never sends nothing', () => {
  let c = sandbox(LITE, acct(), { config: { SEND_EMAIL: 'always' } });
  run(c);
  assert.equal(c.st.emails.length, 1);
  assert(/: no findings$/.test(c.st.emails[0].subject));
  assert(c.st.emails[0].htmlBody.includes('No findings in this run.') && c.st.emails[0].htmlBody.includes(UPGRADE_TITLE));
  c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { config: { SEND_EMAIL: 'never', ALERT_EMAILS: [] } });
  const r = run(c);
  assert.equal(c.st.emails.length, 0);
  assert.equal(r.email.status, 'DISABLED');
  assert(/SPEND_NO_CONVERSIONS/.test(lastLog(c)));
  assertUpgradeLast(lastLog(c));
});
test('preview: [PREVIEW] in the subject; EMAIL_IN_PREVIEW false sends nothing', () => {
  let c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { preview: true });
  run(c);
  assert(/^Tracking Alarm Lite \[PREVIEW\] - /.test(c.st.emails[0].subject));
  assert(c.st.emails[0].htmlBody.includes('PREVIEW run'));
  c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { preview: true, config: { EMAIL_IN_PREVIEW: false } });
  const r = run(c);
  assert.equal(c.st.emails.length, 0);
  assert.equal(r.email.status, 'PREVIEW_NOT_SENT');
});
test('email: account names are HTML-escaped', () => {
  const c = sandbox(LITE, acct({ daily: NO_CONV_7D, name: 'Shop <b>"A"</b> & Co' }));
  run(c);
  const h = c.st.emails[0].htmlBody;
  assert(h.includes('Shop &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; Co'));
  assert(!h.includes('<b>"A"</b>'));
});
test('account that cannot be read: email with the error and the full-version block, then the run fails', () => {
  const c = sandbox(LITE, acct({ failAll: true }));
  throws(() => c.main(), /Tracking Alarm Lite could not check the account: account not accessible/);
  assert.equal(c.st.emails.length, 1);
  assert(/: ERROR, account not checked$/.test(c.st.emails[0].subject));
  assert(c.st.emails[0].htmlBody.includes('The account could not be checked:</b> account not accessible'));
  assert(c.st.emails[0].htmlBody.includes('tracking-alarm-upgrade'));
  assert(/NOT CHECKED \(account not accessible\)/.test(lastLog(c)));
  assertUpgradeLast(lastLog(c));
});
test('email: one retry after 5 s; if it still fails the run fails, after logging the findings and the store link', () => {
  let c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { mailFails: 1 });
  let r = run(c);
  assert.equal(r.email.status, 'SENT (attempt 2)');
  assert.deepEqual(c.st.sleeps, [5000]);
  c = sandbox(LITE, acct({ daily: NO_CONV_7D }), { mailFails: 2 });
  throws(() => c.main(), /finished with problems - email: FAILED: mail server busy/);
  assert(/SPEND_NO_CONVERSIONS/.test(lastLog(c)));
  assertUpgradeLast(lastLog(c));
});
test('changing TAL_STORE_URL changes the link in the email and in the log', () => {
  const src = LITE.replace(STORE, 'https://store.example.com/full');
  const c = sandbox(src, acct({ daily: NO_CONV_7D }));
  run(c);
  assert(c.st.emails[0].htmlBody.includes('<a href="https://store.example.com/full"'));
  assert(!c.st.emails[0].htmlBody.includes(STORE));
  assert(lastLog(c).endsWith('Get the full edition: https://store.example.com/full'));
});

// =============================================================================
// Optional: same findings as the full edition for the two Lite rules
// =============================================================================
if (FULL_PATH && fs.existsSync(FULL_PATH)) {
  test('same SPEND_NO_CONVERSIONS / CVR_DROP findings as the full edition (' + path.basename(FULL_PATH) + '), whose other rules do fire on the Lite-silent accounts', () => {
    const FULL = fs.readFileSync(FULL_PATH, 'utf8');
    const removed = acct({ daily: NO_CONV_7D });
    removed.actions = [action('Old form', () => ({ all: 0, conv: 0, value: 0 }), { status: 'REMOVED' })];
    const cases = [
      [acct()], [acct({ daily: NO_CONV_7D })], [acct({ daily: NO_CONV_7D_SMALL })], [acct({ daily: CVR_DROP })],
      [acct({ daily: CVR_ROSE })], [acct({ daily: NO_BASE })], [acct({ daily: SURGE })], [acct({ daily: LOW_VOL })], [removed],
      [acct({ daily: NO_CONV_7D }), { RULES: { CVR_DROP: { SKIP_IF_SPEND_NO_CONVERSIONS: false } } }],
      [acct({ daily: NO_CONV_7D }), { COUNT_CONVERSIONS_BY: 'click_date', MAX_CHANCE: 0.001 }],
      [acct({ daily: CVR_DROP }), { RULES: { CVR_DROP: { MIN_CVR_DROP: 0.9 } } }]
    ];
    const pick = r => r.findings.filter(f => ['SPEND_NO_CONVERSIONS', 'CVR_DROP'].includes(f.rule))
      .map(f => [f.rule, f.severity, f.strength, f.headline, f.detail]).sort();
    let compared = 0;
    for (const [spec, config] of cases) {
      const lite = pick(run(sandbox(LITE, spec, { config })));
      const fullCtx = sandbox(FULL, spec, { config });
      const full = pick(run(fullCtx));
      assert.deepEqual(lite, full, 'differs from the full edition for ' + JSON.stringify(config || {}));
      compared += lite.length;
    }
    assert(compared >= 10, 'the cases produce findings to compare (' + compared + ')');
    // The accounts used to prove that Lite lacks the other rules do make the full edition fire them.
    for (const name of Object.keys(FULL_ONLY)) {
      const r = run(sandbox(FULL, FULL_ONLY[name]()));
      assert(r.findings.some(f => f.rule === name), 'the full edition reports ' + name + ' for its scenario');
    }
  });
} else {
  skip('same findings as the full edition', 'set TA_FULL_EDITION to the path of tracking-alarm.js; the full edition is not in this repository');
}

console.log('\n' + passed + ' tests passed' + (skipped ? ', ' + skipped + ' skipped' : ''));
