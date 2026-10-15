# Tracking Alarm Lite

A free Google Ads Script that emails you when the conversion tracking of your account looks broken: money spent with zero conversions, or a conversion rate that collapses while the clicks keep coming.

- **Read-only.** It reads statistics and sends an email. It never pauses, edits or creates anything in your account, and it writes to no spreadsheet.
- **Judged against the account's own history.** No industry benchmarks: "normal" is what the account did in the 30 days before. A silence that could just be bad luck for a small account is marked WEAK, not shouted as an emergency.
- **One file, no dependencies.** `tracking-alarm-lite.js`, for one Google Ads account. Plain ASCII on purpose: the Google Ads script editor can corrupt accented or other non-ASCII characters.

## What it does

Each run:

1. Reads the last 60 complete days of the account (clicks, cost, conversions and conversion value; yesterday is the last day, today is never read because it is incomplete) and the list of conversion actions, only to tell you when none of them is enabled.
2. Checks two rules:

| Rule | Fires when (defaults) | Severity |
|---|---|---|
| `SPEND_NO_CONVERSIONS` | 7-day spend of at least 50 (in the account's own currency) and at least 10 clicks, with 0 conversions | Critical |
| `CVR_DROP` | Last 7 days against the 30 days before them: daily clicks fell less than 20% (or rose), the conversion rate fell more than 60% and conversions per day fell more than 60% too. Needs at least 50 clicks in the 7 days and 15 conversions in the 30 days before | Critical |

3. Marks every `SPEND_NO_CONVERSIONS` finding as **STRONG** or **WEAK**:
   - With *r* conversions per day in the 30 days before and *d* days since the last conversion, the chance of that silence by pure luck is e^(-r*d) (Poisson). Under `MAX_CHANCE` (10%) the finding is STRONG.
   - It is also STRONG when there was no conversion at all in the 30 days before, or when the 7-day spend is 3 times the account's usual cost per conversion or more.
   - Otherwise it is WEAK: an account with 5 conversions a month that is quiet for 7 days has a 31% chance of that happening by luck. Check it, no need to panic.
   - `CVR_DROP` findings are always STRONG.
4. Does not repeat itself: when `SPEND_NO_CONVERSIONS` fires, `CVR_DROP` is not reported for the same account (`SKIP_IF_SPEND_NO_CONVERSIONS`).
5. Sends one HTML email (by default only when there is a finding) and writes the same findings to the script log.

Conversions are counted **by conversion date** by default, so a long click-to-conversion lag does not look like a broken tag. You can switch to click date.

How fast it reacts, with one run a day: if all tracking stops at once, `CVR_DROP` fires on the 5th silent day (when the account meets its minimums) and `SPEND_NO_CONVERSIONS` on the 7th. It tells you within days, not weeks; it is not a real-time monitor.

## Installation (5 steps)

1. In your Google Ads account, go to **Tools > Bulk actions > Scripts** and click **+** (New script). Name it, for example, `Tracking Alarm Lite`.
2. Delete the sample code and paste the whole content of [`tracking-alarm-lite.js`](tracking-alarm-lite.js).
3. Edit the `CONFIG` block at the top: at least `ALERT_EMAILS`, for example `ALERT_EMAILS: ['ppc@example.com']`.
4. Click **Authorize** and accept with a Google user that has access to the account. Click **Preview** and read the log at the bottom. With the default `SEND_EMAIL: 'auto'` an email is only sent when there is a finding; to see one now, set `SEND_EMAIL: 'always'` for this first run. In Preview the email is marked `[PREVIEW]` in the subject (`EMAIL_IN_PREVIEW: false` sends none).
5. Schedule it **Daily**, early in the morning, so the previous day is complete.

## Configuration

| Key | Default | What it does |
|---|---|---|
| `ALERT_EMAILS` | `[]` | Recipients. Required unless `SEND_EMAIL` is `'never'`. A comma-separated text also works. |
| `SEND_EMAIL` | `'auto'` | `'auto'` (only when there is a finding or the account could not be read), `'always'` or `'never'`. |
| `EMAIL_IN_PREVIEW` | `true` | Send the email in Preview runs too, marked `[PREVIEW]`. |
| `COUNT_CONVERSIONS_BY` | `'conversion_date'` | `'conversion_date'` or `'click_date'`. |
| `MAX_CHANCE` | `0.10` | Below this chance of "bad luck" a `SPEND_NO_CONVERSIONS` finding is STRONG. Between 0.001 and 0.5. |
| `RULES.SPEND_NO_CONVERSIONS.ENABLED` | `true` | Switch the rule off with `false`. |
| `RULES.SPEND_NO_CONVERSIONS.MIN_COST` | `50` | Minimum 7-day spend, in the account currency. Raise it for currencies such as JPY. |
| `RULES.SPEND_NO_CONVERSIONS.MIN_CLICKS` | `10` | Fewer 7-day clicks than this: too little traffic to judge. |
| `RULES.SPEND_NO_CONVERSIONS.STRONG_COST_MULTIPLIER` | `3` | 7-day spend of this many times the usual cost per conversion, with 0 conversions, is always STRONG. |
| `RULES.CVR_DROP.ENABLED` | `true` | Switch the rule off with `false`. |
| `RULES.CVR_DROP.MIN_CLICKS` | `50` | 7-day clicks needed; below this the rate is noise. |
| `RULES.CVR_DROP.MIN_BASE_CONVERSIONS` | `15` | Conversions needed in the 30 days before. |
| `RULES.CVR_DROP.MAX_TRAFFIC_DROP` | `0.20` | Traffic counts as "holding" if daily clicks fell less than this. |
| `RULES.CVR_DROP.MIN_CVR_DROP` | `0.60` | Alert when the conversion rate (and the conversions per day) fell more than this. |
| `RULES.CVR_DROP.SKIP_IF_SPEND_NO_CONVERSIONS` | `true` | Do not repeat what `SPEND_NO_CONVERSIONS` already said. |

Invalid values (for example `MIN_COST: '50'` as text, or `ENABLED: 'true'` in quotes) stop the script with a clear error before anything is read. A rule name that is not one of the two Lite rules, a typo or a rule of the full edition such as `FIXED_VALUE`, also stops it. Top-level settings that only exist in the full edition (`SHEET_URL`, `ESCALATION_EMAILS`, `MUTE`...) are ignored: Lite has no code for them. The two Lite rules use the same key names as the full edition, so your thresholds carry over if you upgrade.

## What you get

- **Email** (one per run at most). Subject like `Tracking Alarm Lite - Shop (123-456-7890) - 05-10: 1 finding(s), 1 critical`. Body: a table with severity, strength, rule and a plain-language explanation with the numbers (for example "280.00 EUR spent and 0 conversions in the last 7 days (630 clicks; threshold 50.00 EUR). Last conversion on 2026-09-27, 7 days ago..."), what each rule means, notes, and at the end a short block about the full edition with its link.
- **Script log**: the same findings, ending with the same block.
- **If the account cannot be read**: the email says so and the run is marked as failed in Google Ads. Unchecked is not the same as clean.
- **If the email cannot be sent**: one retry after 5 seconds; if it still fails, the findings stay in the log and the run is marked as failed.

## Limitations

- One account per script. There is no manager account (MCC) edition of Lite.
- Two rules only. Lite looks at the account's **Conversions** column as a whole: secondary conversion actions are not watched, and one broken tag among several working ones can be hidden by the totals.
- Complete days only, so it needs some silent days before it can tell a break from a quiet day (see "How fast it reacts").
- No memory between runs: while a problem lasts, every daily run reports it again. There is no list of open alerts, no "reviewed by" and no escalation.
- Conversions imported with a delay (offline imports and similar) count only once they arrive: a late import can look like a silence.
- `MIN_COST` is in the account currency and is never converted: 50 is very little in JPY or HUF.
- Tested with Node.js test doubles of the Google Ads objects (`tests/tracking-alarm-lite.test.js`), not against a live account by the author of this package.

## Need more?

Lite tells you when the tracking of one account looks broken. The full edition, **Tracking Alarm**, watches more and keeps track of every alert until someone deals with it:

| | Lite (free, this repo) | Tracking Alarm (full) |
|---|---|---|
| `SPEND_NO_CONVERSIONS` and `CVR_DROP`, STRONG / WEAK | Yes | Yes |
| `FIXED_VALUE`: placeholder conversion value (a round average such as exactly 1.00 per conversion), naming the action behind it | No | Yes |
| `SILENT_ACTION`: one conversion action goes silent while the others keep recording (secondary actions included) | No | Yes |
| `DUPLICATES`: more conversions than clicks, the tag fires twice | No | Yes |
| Alert book in a Google Sheet: one row per problem, a "Reviewed by" column, unreviewed alerts climb a level after 24 h, 72 h and 7 days, separate email to escalation contacts | No | Yes |
| Tells you when the script itself missed runs | No | Yes (with the alert book) |
| Mute a rule for one account | No | Yes |
| Manager account (MCC) edition: all client accounts, an account label or a list of IDs, one consolidated email | No | Yes (MCC / Agency edition) |
| License | MIT | Commercial |

Get Tracking Alarm: https://carlesmister.gumroad.com/l/tracking-alarm

## Tests

Requires Node.js, no dependencies to install (last run with Node.js 22.18.0):

```
node tests/tracking-alarm-lite.test.js
```

The tests load the script in a sandbox with test doubles for `AdsApp`, `MailApp` and `Utilities` and a fake clock; nothing talks to Google or to the network. `SpreadsheetApp`, `AdsManagerApp`, `PropertiesService` and `UrlFetchApp` are traps: the tests fail if the script touches any of them, or any `AdsApp` member other than `currentAccount`, `getExecutionInfo` and `search`. They also check that the rules of the full edition are not in the code and never fire, and that every email and every log ends with the link to the full edition.

One test compares Lite with the full edition and is skipped in this repository, because the full edition is not included.

## License

MIT, Copyright (c) 2026 CAES Marketing SL. See [`LICENSE`](LICENSE).
