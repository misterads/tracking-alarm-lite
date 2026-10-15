/**
 * Tracking Alarm Lite 1.0.0 - free edition (one account)
 * Google Ads Script that warns you when the conversion tracking of your
 * account looks broken. It ONLY READS statistics: it never pauses, edits or
 * creates anything in your account.
 *
 * Lite checks two rules (each one can be tuned or switched off in CONFIG):
 *   1. SPEND_NO_CONVERSIONS  money spent in the last 7 days and zero
 *                            conversions
 *   2. CVR_DROP              conversion rate collapses while clicks hold
 *
 * The full edition of Tracking Alarm (link at the end of every email) adds
 * more rules, a manager account (MCC) edition and an alert book in a Google
 * Sheet that escalates the alerts nobody reviews.
 *
 * Install: Google Ads > Tools > Bulk actions > Scripts > + New script.
 * Paste this whole file, put your email in ALERT_EMAILS, Authorize, Preview,
 * then Run. Schedule it Daily (early morning, after the previous day is
 * complete).
 *
 * This file is plain ASCII on purpose: the Google Ads script editor can
 * corrupt accented or other non-ASCII characters.
 *
 * License: MIT (see LICENSE). Copyright (c) 2026 CAES Marketing SL.
 */

var CONFIG = {
  // Who receives the email. One or more addresses, e.g. ['you@example.com'].
  ALERT_EMAILS: [],

  // When to email:
  //  'auto'   only when there is at least one finding, or when the account
  //           could not be checked.
  //  'always' after every run, even with nothing to say.
  //  'never'  no email (read the script log only).
  SEND_EMAIL: 'auto',
  // A Preview run sends the email too (subject marked [PREVIEW]) so you can
  // see what you will get. Set false to send nothing in Preview.
  EMAIL_IN_PREVIEW: true,

  // 'conversion_date' counts a conversion on the day it happened (best to see
  // when a tag stops firing). 'click_date' counts it on the day of the click,
  // like the default Google Ads columns.
  COUNT_CONVERSIONS_BY: 'conversion_date',

  // SPEND_NO_CONVERSIONS asks "could this silence be bad luck?" using the
  // account's own conversion rate. Below this chance a finding is STRONG (most
  // likely a break); above it, WEAK (check it, no need to panic).
  // 0.10 = 10%: a silence that random chance explains less than 1 time in 10.
  MAX_CHANCE: 0.10,

  RULES: {
    // 1. The account spends and records zero conversions in 7 days.
    SPEND_NO_CONVERSIONS: {
      ENABLED: true,
      MIN_COST: 50,                 // minimum 7-day spend, in the account's own currency
      MIN_CLICKS: 10,               // fewer 7-day clicks than this: too little traffic to judge
      STRONG_COST_MULTIPLIER: 3     // 7-day spend of 3x the account's usual cost per conversion
                                    // (30 days before) with 0 conversions is always STRONG
    },
    // 2. Conversion rate collapses while clicks hold (last 7 days vs 30 before).
    CVR_DROP: {
      ENABLED: true,
      MIN_CLICKS: 50,               // 7-day clicks needed; below this the rate is noise
      MIN_BASE_CONVERSIONS: 15,     // conversions in the 30 days before; avoids "-100%" on 2 conversions
      MAX_TRAFFIC_DROP: 0.20,       // traffic counts as "holding" if daily clicks fell less than 20%
      MIN_CVR_DROP: 0.60,           // alert when the conversion rate fell more than 60%
      SKIP_IF_SPEND_NO_CONVERSIONS: true // do not repeat what rule 1 already said
    }
  }
};

// Where the full edition is sold.
var TAL_STORE_URL = 'https://carlesmister.gumroad.com/l/tracking-alarm';

function main() {
  var cfg;
  try {
    cfg = taConfig(CONFIG);
  } catch (eCfg) {
    // A CONFIG error stops the run, but the log still ends with the full-version block.
    Logger.log('Tracking Alarm Lite ' + TA_VERSION + ' - CONFIG error: ' + taErr(eCfg) + '\n\n' + taUpgradeLines().join('\n'));
    throw eCfg;
  }
  var run = taStartRun();
  var result;
  try {
    result = taAnalyzeAccount(cfg);
  } catch (e) {
    var acc = AdsApp.currentAccount();
    result = taFailedResult(acc.getCustomerId(), acc.getName(), taErr(e));
  }
  return taFinish(cfg, run, result);
}

// ===========================================================================
// TRACKING ALARM LITE - do not edit below this line unless you know what you
// are doing. Everything you are meant to change is in CONFIG above.
// ===========================================================================
var TA_VERSION = '1.0.0';
var TA_RULES = ['SPEND_NO_CONVERSIONS', 'CVR_DROP'];
var TA_LOOKBACK_DAYS = 60;
var TA_EMAIL_ATTEMPTS = 2;
var TA_EMAIL_RETRY_MS = 5000;
var TA_FIELDS = {
  conversion_date: { conv: 'conversions_by_conversion_date' },
  click_date: { conv: 'conversions' }
};
var TA_RULE_TEXT = {
  SPEND_NO_CONVERSIONS: 'Spend without conversions: the account spent more than its threshold in the last 7 days and recorded zero conversions. Either the tracking is broken or the money is not working.',
  CVR_DROP: 'Conversion rate collapsed while traffic held: people keep arriving but conversions stop being recorded. Classic symptom of a broken tag.'
};
// Last block of every email and of the log: what the full edition adds.
var TA_UPGRADE_TITLE = 'Full version: all rules, MCC, alert book with escalation';
var TA_UPGRADE_POINTS = [
  'More rules: placeholder conversion values (a round average such as exactly 1.00 per conversion), one conversion action gone silent while the others keep recording, and tags that fire twice (more conversions than clicks).',
  'Manager account (MCC) edition: all your client accounts, an account label or a list of IDs, checked from the manager account with one consolidated email.',
  'Alert book in a Google Sheet: one row per problem; alerts nobody reviews climb a level after 24 h, 72 h and 7 days, and at the last level your escalation contacts get their own email. It also tells you when the script missed runs.'
];

// ---------------------------------------------------------------------------
// Configuration: validated copy of CONFIG. A typo stops the script with a
// clear message instead of silently changing what is checked.
// ---------------------------------------------------------------------------
function taConfig(raw) {
  var c = JSON.parse(JSON.stringify(raw || {}));
  var fail = function (msg) { throw new Error('CONFIG.' + msg); };
  var isObj = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
  var num = function (obj, key, path, min, max) {
    var v = obj[key];
    if (typeof v !== 'number' || !isFinite(v) || v < min || (max !== undefined && v > max)) {
      fail(path + ' must be a number ' + (max !== undefined ? 'between ' + min + ' and ' + max : 'of at least ' + min)
        + ' (now: ' + JSON.stringify(v) + ').');
    }
    return v;
  };
  var bool = function (obj, key, path) {
    if (typeof obj[key] !== 'boolean') fail(path + ' must be true or false (now: ' + JSON.stringify(obj[key]) + ').');
    return obj[key];
  };

  var emails = c.ALERT_EMAILS;
  if (emails === undefined || emails === null || emails === '') emails = [];
  if (typeof emails === 'string') emails = emails.split(',');
  if (!Array.isArray(emails)) fail('ALERT_EMAILS must be a list, for example [\'you@example.com\'].');
  c.ALERT_EMAILS = emails.map(function (x) { return String(x).trim(); }).filter(function (x) { return x; });
  c.ALERT_EMAILS.forEach(function (e) {
    if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(e)) fail('ALERT_EMAILS: "' + e + '" is not a valid email address.');
  });
  if (['auto', 'always', 'never'].indexOf(c.SEND_EMAIL) < 0) fail('SEND_EMAIL must be "auto", "always" or "never".');
  if (c.SEND_EMAIL !== 'never' && !c.ALERT_EMAILS.length) {
    fail('ALERT_EMAILS is empty. Add at least one address, or set SEND_EMAIL to "never".');
  }
  if (c.EMAIL_IN_PREVIEW === undefined) c.EMAIL_IN_PREVIEW = true;
  bool(c, 'EMAIL_IN_PREVIEW', 'EMAIL_IN_PREVIEW');
  if (!Object.prototype.hasOwnProperty.call(TA_FIELDS, c.COUNT_CONVERSIONS_BY)) {
    fail('COUNT_CONVERSIONS_BY must be "conversion_date" or "click_date".');
  }
  num(c, 'MAX_CHANCE', 'MAX_CHANCE', 0.001, 0.5);

  if (!isObj(c.RULES)) fail('RULES is missing.');
  Object.keys(c.RULES).forEach(function (name) {
    if (TA_RULES.indexOf(name) < 0) {
      fail('RULES: "' + name + '" is not a rule of Tracking Alarm Lite. Lite checks ' + TA_RULES.join(' and ')
        + '; the other rules are in the full edition.');
    }
  });
  TA_RULES.forEach(function (name) {
    if (!isObj(c.RULES[name])) fail('RULES.' + name + ' is missing.');
    bool(c.RULES[name], 'ENABLED', 'RULES.' + name + '.ENABLED');
  });

  var p = 'RULES.SPEND_NO_CONVERSIONS.', r1 = c.RULES.SPEND_NO_CONVERSIONS;
  num(r1, 'MIN_COST', p + 'MIN_COST', 0);
  num(r1, 'MIN_CLICKS', p + 'MIN_CLICKS', 0);
  num(r1, 'STRONG_COST_MULTIPLIER', p + 'STRONG_COST_MULTIPLIER', 1);

  p = 'RULES.CVR_DROP.';
  var r3 = c.RULES.CVR_DROP;
  num(r3, 'MIN_CLICKS', p + 'MIN_CLICKS', 1);
  num(r3, 'MIN_BASE_CONVERSIONS', p + 'MIN_BASE_CONVERSIONS', 1);
  num(r3, 'MAX_TRAFFIC_DROP', p + 'MAX_TRAFFIC_DROP', 0, 1);
  num(r3, 'MIN_CVR_DROP', p + 'MIN_CVR_DROP', 0, 1);
  bool(r3, 'SKIP_IF_SPEND_NO_CONVERSIONS', p + 'SKIP_IF_SPEND_NO_CONVERSIONS');
  return c;
}

// ---------------------------------------------------------------------------
// Small helpers. Dates are 'yyyy-MM-dd' strings in the account time zone;
// day arithmetic is done at UTC noon so daylight saving never shifts a day.
// ---------------------------------------------------------------------------
function taNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function taDigits(v) { return String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, ''); }
function taId(v) {
  var d = taDigits(v);
  return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : String(v === null || v === undefined ? '' : v);
}
function taCamel(s) { return s.replace(/_([a-z])/g, function (m, ch) { return ch.toUpperCase(); }); }
function taErr(e) { return e && e.message ? String(e.message) : String(e); }
function taFmt(ms, tz, pattern) { return Utilities.formatDate(new Date(ms), tz, pattern); }
function taPad(n) { return (n < 10 ? '0' : '') + n; }
function taDayMs(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : null;
}
function taAddDays(s, n) {
  var d = new Date(taDayMs(s) + n * 86400000);
  return d.getUTCFullYear() + '-' + taPad(d.getUTCMonth() + 1) + '-' + taPad(d.getUTCDate());
}
function taDaysBetween(a, b) {
  var x = taDayMs(a), y = taDayMs(b);
  return (x === null || y === null) ? 0 : Math.round((y - x) / 86400000);
}
function taMoney(x, cur) { return taNum(x).toFixed(2) + (cur ? ' ' + cur : ''); }
function taPct(x) { return (x * 100).toFixed(0) + '%'; }

// Windows used by the two rules, all made of complete days (yesterday is the
// last one).
function taWindows(today) {
  var d = function (n) { return taAddDays(today, -n); };
  return { today: today, yesterday: d(1), start: d(TA_LOOKBACK_DAYS),
           last7From: d(7), prior30From: d(37), prior30To: d(8) };
}

function taSum(rows, from, to) {
  var s = { clicks: 0, cost: 0, conv: 0 };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.date < from || r.date > to) continue;
    s.clicks += r.clicks; s.cost += r.cost; s.conv += r.conv;
  }
  return s;
}

function taLastConversion(rows, to) {
  var last = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].conv > 0 && rows[i].date <= to && (last === null || rows[i].date > last)) last = rows[i].date;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Reading the account. Read-only GAQL queries; nothing in this script
// creates, changes or removes anything in Google Ads.
// ---------------------------------------------------------------------------
function taQueryDaily(cfg, w) {
  var f = TA_FIELDS[cfg.COUNT_CONVERSIONS_BY];
  var q = 'SELECT segments.date, metrics.clicks, metrics.cost_micros, metrics.' + f.conv
    + ' FROM customer WHERE segments.date BETWEEN \'' + w.start + '\' AND \'' + w.yesterday + '\'';
  var it = AdsApp.search(q), byDate = {};
  while (it.hasNext()) {
    var row = it.next(), m = row.metrics || {}, date = String((row.segments || {}).date || '');
    if (!date) continue;
    var r = byDate[date] || (byDate[date] = { date: date, clicks: 0, cost: 0, conv: 0 });
    r.clicks += taNum(m.clicks);
    r.cost += taNum(m.costMicros) / 1000000;
    r.conv += taNum(m[taCamel(f.conv)]);
  }
  return Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
}

// Only to say "the account has NO enabled conversion action" when rule 1 fires.
function taQueryMeta() {
  var it = AdsApp.search('SELECT conversion_action.name, conversion_action.status FROM conversion_action');
  var meta = { total: 0, enabled: 0 };
  while (it.hasNext()) {
    var ca = it.next().conversionAction;
    if (!ca || !ca.name) continue;
    meta.total++;
    if (String(ca.status || '') === 'ENABLED') meta.enabled++;
  }
  return meta;
}

function taFinding(rule, severity, strength, d, text, detail) {
  return { rule: rule, severity: severity, strength: strength, account: d.id || '', accountName: d.name || '',
           headline: (d.id ? (d.name || d.id) + ' (' + d.id + '): ' : '') + text, detail: detail || '' };
}

// Reads the account the script runs in and evaluates the two Lite rules.
function taAnalyzeAccount(cfg) {
  var acc = AdsApp.currentAccount();
  var tz = acc.getTimeZone();
  var d = { id: taId(acc.getCustomerId()), name: String(acc.getName() || ''),
            currency: String(acc.getCurrencyCode() || '').toUpperCase(), notes: [], meta: null };
  var w = taWindows(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  d.daily = taQueryDaily(cfg, w);
  if (cfg.RULES.SPEND_NO_CONVERSIONS.ENABLED) {
    try {
      d.meta = taQueryMeta();
    } catch (e1) {
      d.notes.push('conversion action settings could not be read (' + taErr(e1) + '); the rules ran without them');
    }
  }
  return { ok: true, id: d.id, name: d.name, currency: d.currency, yesterday: w.yesterday,
           findings: taEvaluate(cfg, d, w), notes: d.notes };
}

function taFailedResult(id, name, error) {
  return { ok: false, id: taId(id), name: String(name || ''), error: String(error || 'unknown error'), findings: [], notes: [] };
}

function taEvaluate(cfg, d, w) {
  var out = [];
  var r1 = taRuleSpendNoConv(cfg, d, w);
  if (r1) out.push(r1);
  if (!(r1 && cfg.RULES.CVR_DROP.SKIP_IF_SPEND_NO_CONVERSIONS)) {
    var r3 = taRuleCvrDrop(cfg, d, w);
    if (r3) out.push(r3);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 1 - SPEND_NO_CONVERSIONS. 7 days over the cost threshold, 0 conversions.
// Strength: STRONG when there is no baseline at all, when the silence is too
// long to be bad luck (Poisson: chance = e^(-daily_rate * silent_days)), or
// when the 7-day spend is a multiple of the account's usual cost per
// conversion (30 days before). Otherwise WEAK.
// ---------------------------------------------------------------------------
function taRuleSpendNoConv(cfg, d, w) {
  var r = cfg.RULES.SPEND_NO_CONVERSIONS;
  if (!r.ENABLED) return null;
  var s7 = taSum(d.daily, w.last7From, w.yesterday);
  if (s7.conv > 0) return null;
  var min = r.MIN_COST;
  if (s7.cost <= 0 || s7.cost < min || s7.clicks < r.MIN_CLICKS) return null;

  var p30 = taSum(d.daily, w.prior30From, w.prior30To), base = p30.conv;
  var last = taLastConversion(d.daily, w.yesterday);
  var lastTxt = last ? 'Last conversion on ' + last + ', ' + taDaysBetween(last, w.yesterday) + ' days ago'
                     : 'No conversion at all in the last ' + TA_LOOKBACK_DAYS + ' days';
  var strength, why, tech;
  if (base <= 0) {
    strength = 'STRONG';
    why = lastTxt + ': there is no baseline, this is spend without any measured result.';
    tech = 'reason=no_baseline';
  } else {
    var days = taDaysBetween(last, w.yesterday);
    var p = Math.exp(-(base / 30) * days);
    var cpa = p30.cost > 0 ? p30.cost / base : 0;
    if (p <= cfg.MAX_CHANCE) {
      strength = 'STRONG';
      why = lastTxt + '; ' + base.toFixed(1) + ' conversions in the 30 days before. Chance that this silence is just bad luck: '
        + taPct(p) + '. This looks like a break, not a slow week.';
      tech = 'reason=chance; p_chance=' + (p * 100).toFixed(1) + '%';
    } else if (cpa > 0 && s7.cost >= r.STRONG_COST_MULTIPLIER * cpa) {
      // A quiet stretch is plausible, but not after spending several times
      // what one conversion usually costs this account.
      strength = 'STRONG';
      why = lastTxt + '; ' + base.toFixed(1) + ' conversions in the 30 days before, at about ' + taMoney(cpa, d.currency)
        + ' each. The account spent ' + (s7.cost / cpa).toFixed(1) + 'x its usual cost per conversion without a single conversion.';
      tech = 'reason=cost_over_' + r.STRONG_COST_MULTIPLIER + 'x_cpa; cpa_prior30=' + taMoney(cpa, d.currency)
        + '; p_chance=' + (p * 100).toFixed(1) + '%';
    } else {
      strength = 'WEAK';
      why = lastTxt + '; ' + base.toFixed(1) + ' conversions in the 30 days before. Chance that this silence is just bad luck: '
        + taPct(p) + '. With this volume a quiet week happens now and then: check it, no need to panic.';
      tech = 'reason=chance; p_chance=' + (p * 100).toFixed(1) + '%';
    }
  }
  var noAction = (d.meta && d.meta.enabled === 0) ? ' The account has NO enabled conversion action.' : '';
  return taFinding('SPEND_NO_CONVERSIONS', 'CRITICAL', strength, d,
    taMoney(s7.cost, d.currency) + ' spent and 0 conversions in the last 7 days (' + s7.clicks + ' clicks; threshold '
      + taMoney(min, d.currency) + '). ' + why + noAction,
    'cost7=' + taMoney(s7.cost, d.currency) + '; clicks7=' + s7.clicks + '; base_prior30=' + base.toFixed(1) + '; ' + tech);
}

// ---------------------------------------------------------------------------
// Rule 2 - CVR_DROP. Last 7 days vs the 30 days before them: clicks hold,
// conversion rate collapses.
// ---------------------------------------------------------------------------
function taRuleCvrDrop(cfg, d, w) {
  var r = cfg.RULES.CVR_DROP;
  if (!r.ENABLED) return null;
  var s7 = taSum(d.daily, w.last7From, w.yesterday);
  var p30 = taSum(d.daily, w.prior30From, w.prior30To);
  if (s7.clicks < r.MIN_CLICKS || p30.clicks <= 0 || p30.conv < r.MIN_BASE_CONVERSIONS) return null;
  var daily7 = s7.clicks / 7, daily30 = p30.clicks / 30;
  var trafficDrop = (daily30 - daily7) / daily30;
  if (trafficDrop >= r.MAX_TRAFFIC_DROP) return null;
  var cvr30 = p30.conv / p30.clicks, cvr7 = s7.conv / s7.clicks;
  var cvrDrop = (cvr30 - cvr7) / cvr30;
  if (cvrDrop <= r.MIN_CVR_DROP) return null;
  // Conversions per day must collapse too. When clicks rise (a new campaign,
  // broad match) and conversions per day hold, the tag still records: the
  // extra traffic only dilutes the rate.
  var conv30 = p30.conv / 30, conv7 = s7.conv / 7;
  if (1 - conv7 / conv30 <= r.MIN_CVR_DROP) return null;
  var move = trafficDrop >= 0 ? 'fell ' + taPct(trafficDrop) : 'rose ' + taPct(-trafficDrop);
  return taFinding('CVR_DROP', 'CRITICAL', 'STRONG', d,
    'conversion rate ' + (cvr30 * 100).toFixed(2) + '% -> ' + (cvr7 * 100).toFixed(2) + '% (-' + taPct(cvrDrop)
      + ') while daily clicks ' + move + ' (' + daily30.toFixed(1) + ' -> ' + daily7.toFixed(1) + '), on a baseline of '
      + p30.conv.toFixed(1) + ' conversions; daily conversions ' + conv30.toFixed(1) + ' -> ' + conv7.toFixed(1)
      + '. Classic symptom of a broken tag.',
    'cvr_prior30=' + (cvr30 * 100).toFixed(2) + '%; cvr7=' + (cvr7 * 100).toFixed(2) + '%; base_conv=' + p30.conv.toFixed(1));
}

// ---------------------------------------------------------------------------
// Run: email and log.
// ---------------------------------------------------------------------------
function taStartRun() {
  return { t0: Date.now(), tz: AdsApp.currentAccount().getTimeZone(),
           preview: AdsApp.getExecutionInfo().isPreview() === true };
}

// Most serious first: rule 1, then rule 2; STRONG before WEAK.
function taSorted(items) {
  return items.slice().sort(function (a, b) {
    var ox = TA_RULES.indexOf(a.rule), oy = TA_RULES.indexOf(b.rule);
    if (ox !== oy) return ox - oy;
    return (a.strength === 'STRONG' ? 0 : 1) - (b.strength === 'STRONG' ? 0 : 1);
  });
}

function taFinish(cfg, run, result) {
  run.now = Date.now();
  var report = { cfg: cfg, run: run, result: result, label: (result.name || result.id) + ' (' + result.id + ')',
                 findings: taSorted(result.findings), notes: result.notes, email: null };
  report.email = taDeliver(cfg, report);
  Logger.log(taText(report));
  // Make the run show as failed in Google Ads when something went wrong, so
  // it is not mistaken for a clean run.
  if (!result.ok) throw new Error('Tracking Alarm Lite could not check the account: ' + result.error);
  if (report.email.failed) throw new Error('Tracking Alarm Lite finished with problems - email: ' + report.email.status);
  return report;
}

function taShouldEmail(cfg, report) {
  if (cfg.SEND_EMAIL === 'never') return false;
  if (cfg.SEND_EMAIL === 'always') return true;
  return !report.result.ok || report.findings.length > 0;
}

// One message, one automatic retry. A full quota is not retried.
function taSend(to, subject, html) {
  var last = '';
  for (var attempt = 1; attempt <= TA_EMAIL_ATTEMPTS; attempt++) {
    try {
      var quota = null;
      try { if (typeof MailApp.getRemainingDailyQuota === 'function') quota = Number(MailApp.getRemainingDailyQuota()); } catch (eQ) { quota = null; }
      if (quota !== null && quota < 1) throw new Error('daily email quota exhausted');
      MailApp.sendEmail({ to: to.join(','), subject: subject, htmlBody: html });
      return { ok: true, status: attempt === 1 ? 'SENT' : 'SENT (attempt ' + attempt + ')' };
    } catch (e) {
      last = taErr(e);
      Logger.log('Email attempt ' + attempt + ' of ' + TA_EMAIL_ATTEMPTS + ' failed: ' + last);
      if (/quota/i.test(last)) break;
      if (attempt < TA_EMAIL_ATTEMPTS) Utilities.sleep(TA_EMAIL_RETRY_MS);
    }
  }
  return { ok: false, status: 'FAILED: ' + last };
}

function taDeliver(cfg, report) {
  if (!taShouldEmail(cfg, report)) return { status: cfg.SEND_EMAIL === 'never' ? 'DISABLED' : 'NOT_REQUIRED', failed: false };
  var mail = taEmail(report);
  if (report.run.preview && !cfg.EMAIL_IN_PREVIEW) {
    Logger.log('PREVIEW: email not sent (EMAIL_IN_PREVIEW is false). Subject would be: ' + mail.subject);
    return { status: 'PREVIEW_NOT_SENT', failed: false };
  }
  var sent = taSend(cfg.ALERT_EMAILS, mail.subject, mail.html);
  return { status: sent.status, failed: !sent.ok, subject: mail.subject };
}

function taEsc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function taTable(headers, rows) {
  var th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #ddd;font-size:12px;color:#555"';
  var td = 'style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top"';
  var h = '<table style="border-collapse:collapse;width:100%;margin:6px 0 18px 0"><tr>';
  for (var i = 0; i < headers.length; i++) h += '<th ' + th + '>' + taEsc(headers[i]) + '</th>';
  h += '</tr>';
  for (var r = 0; r < rows.length; r++) {
    h += '<tr>';
    for (var c = 0; c < rows[r].length; c++) h += '<td ' + td + '>' + taEsc(rows[r][c]) + '</td>';
    h += '</tr>';
  }
  return h + '</table>';
}

function taUpgradeHtml() {
  var li = '';
  for (var i = 0; i < TA_UPGRADE_POINTS.length; i++) li += '<li>' + taEsc(TA_UPGRADE_POINTS[i]) + '</li>';
  return '<div id="tracking-alarm-upgrade" style="margin-top:28px;padding:14px 16px;border:1px solid #cfd8e3;border-left:4px solid #FF6D2E;border-radius:6px;background:#f5f8fb;font-size:13px">'
    + '<p style="margin:0 0 8px;font-size:15px"><b>' + taEsc(TA_UPGRADE_TITLE) + '</b></p>'
    + '<ul style="margin:0 0 8px;padding-left:18px">' + li + '</ul>'
    + '<p style="margin:0">Get the full edition: <a href="' + taEsc(TAL_STORE_URL) + '" style="color:#FF6D2E">' + taEsc(TAL_STORE_URL) + '</a></p>'
    + '</div>';
}

function taEmail(report) {
  var cfg = report.cfg, run = report.run, res = report.result, list = report.findings;
  var crit = 0;
  for (var k = 0; k < list.length; k++) if (list[k].severity === 'CRITICAL') crit++;
  var status = !res.ok ? 'ERROR, account not checked'
    : list.length ? list.length + ' finding(s)' + (crit ? ', ' + crit + ' critical' : '') : 'no findings';
  var subject = 'Tracking Alarm Lite' + (run.preview ? ' [PREVIEW]' : '') + ' - ' + report.label + ' - '
    + taFmt(run.now, run.tz, 'dd-MM') + ': ' + status;

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:960px">'
    + '<h2 style="margin:0 0 4px 0">Tracking Alarm Lite - ' + taEsc(report.label) + '</h2>'
    + '<p style="margin:0 0 14px 0;color:#666;font-size:13px">' + taEsc(taFmt(run.now, run.tz, 'yyyy-MM-dd HH:mm')) + ' (' + taEsc(run.tz) + ')'
    + ' &middot; read-only: this script never changes anything in Google Ads &middot; conversions counted by '
    + (cfg.COUNT_CONVERSIONS_BY === 'conversion_date' ? 'conversion date' : 'click date') + '</p>';
  if (run.preview) {
    html += '<p style="background:#fff4e5;padding:8px;border-left:4px solid #f0a020">PREVIEW run: this is the email a live run would send.</p>';
  }
  if (!res.ok) {
    html += '<p style="background:#fdecea;padding:8px;border-left:4px solid #d93025"><b>The account could not be checked:</b> '
      + taEsc(res.error) + '<br>Unchecked is not the same as clean. The run is marked as failed in Google Ads.</p>';
  } else if (list.length) {
    html += '<h3>Findings in this run (' + list.length + ')</h3>'
      + taTable(['Severity', 'Strength', 'Rule', 'What we see'], list.map(function (x) { return [x.severity, x.strength, x.rule, x.headline]; }))
      + '<p style="font-size:13px;color:#666">STRONG: very unlikely to be chance, most likely a tracking break. '
      + 'WEAK: plausible as a quiet stretch for the volume of this account; check it, no need to panic.</p>';
    var legend = [], used = {};
    for (var i = 0; i < list.length; i++) used[list[i].rule] = true;
    for (var j = 0; j < TA_RULES.length; j++) if (used[TA_RULES[j]]) legend.push([TA_RULES[j], TA_RULE_TEXT[TA_RULES[j]]]);
    html += '<h3>What the rules mean</h3>' + taTable(['Rule', 'Meaning'], legend);
  } else {
    html += '<p>No findings in this run.</p>';
  }
  if (report.notes.length) {
    html += '<h3>Notes</h3><ul style="font-size:13px">';
    for (var n = 0; n < report.notes.length; n++) html += '<li>' + taEsc(report.notes[n]) + '</li>';
    html += '</ul>';
  }
  html += '<p style="font-size:12px;color:#888;border-top:1px solid #eee;padding-top:8px">Tracking Alarm Lite ' + TA_VERSION
    + '. It only reads statistics: it never pauses, edits or creates anything in your Google Ads account.</p>'
    + taUpgradeHtml()
    + '</div>';
  return { subject: subject, html: html };
}

// Text for the script log. The full-version block is always the last thing.
function taText(report) {
  var res = report.result;
  var lines = ['Tracking Alarm Lite ' + TA_VERSION + ' - ' + report.label + ': '
    + (res.ok ? report.findings.length + ' finding(s)' : 'NOT CHECKED (' + res.error + ')')
    + ', email ' + (report.email ? report.email.status : '-') + (report.run.preview ? ' [PREVIEW]' : '')];
  for (var i = 0; i < report.findings.length; i++) {
    var f = report.findings[i];
    lines.push('  [' + f.severity + '/' + f.strength + '] ' + f.rule + ' - ' + f.headline);
  }
  for (var j = 0; j < report.notes.length; j++) lines.push('Note: ' + report.notes[j]);
  lines.push('');
  return lines.concat(taUpgradeLines()).join('\n');
}

function taUpgradeLines() {
  var t = ['--- ' + TA_UPGRADE_TITLE + ' ---'];
  for (var k = 0; k < TA_UPGRADE_POINTS.length; k++) t.push('- ' + TA_UPGRADE_POINTS[k]);
  t.push('Get the full edition: ' + TAL_STORE_URL);
  return t;
}
