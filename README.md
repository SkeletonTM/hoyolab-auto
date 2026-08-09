# HoyoLab Auto — Google Apps Script edition

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Automatically signs you into **Genshin Impact, Honkai Impact 3rd, Honkai: Star Rail, and Zenless Zone Zero** every day — and can redeem active promo codes for you.

Runs entirely on Google's free infrastructure: **no local machine, no Docker, no cost.**

This is a trimmed-down fork of [torikushiii/hoyolab-auto](https://github.com/torikushiii/hoyolab-auto) with fixed Discord notifications so code redemption actually reports correctly.

---

## 📑 Contents

- [Quick start](#quick-start)
- [How the script works](#how-the-script-works)
- [Configuration reference](#configuration-reference)
- [Daily reset schedule](#daily-reset-schedule)
- [Troubleshooting](#troubleshooting)
- [Upstream comparison](#upstream-comparison)

---

## Quick start

> ⏱️ **5 minutes** to get a daily auto-check-in running. Everything happens in your browser.

### 1. Create the script

1. Open [script.google.com](https://script.google.com/) and click **+ New project**.
2. Delete the placeholder `function myFunction() { … }`.
3. Open [`services/google-script/index.js`](services/google-script/index.js), **select all → copy**, and paste it into the editor.
4. Click the 💾 save icon. Name the project anything (e.g. "HoyoLab Auto").

### 2. Add your accounts (cookies)

At the top of the file you'll see a `config` object. Put your cookie strings into the `data: []` array of each game you play (one string per account):

```javascript
const config = {
    enableCodeRedemption: false,      // turn on later (step 4)
    redeemCodesEvenIfSignedIn: false, // optional, see step 4
    redeemSleepMs: 6000,              // pause between code redemptions (rate-limit guard)
    genshin:  { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
    honkai:   { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
    starrail: { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
    zenless:  { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
};
```

Add **one string per account** inside the array. Multiple accounts = multiple strings.

#### 📎 How to get a cookie

1. Open [HoyoLab](https://www.hoyolab.com/) and sign in.
2. Press **F12** → **Network** tab.
3. Refresh the page; in the log, find the request named `getGameRecordCard` and click it.
4. In **Request Headers**, copy the entire `cookie` value.
5. Paste it into the right `data: []` array above.

> 💡 This method gives a cookie that works for **both** check-in and code redemption. The check-in-page-only cookie often lacks the tokens needed for redemption.

### 3. (Optional) Add Discord notifications

Find these lines a bit below `config`:

```javascript
const DISCORD_WEBHOOK = null;  // replace with your webhook URL
const DISCORD_USER_ID = "";    // optional: your Discord user ID (pings you on errors)
```

- Follow [`setup/DISCORD_WEBHOOK.md`](setup/DISCORD_WEBHOOK.md) to create a webhook, then paste the URL into `DISCORD_WEBHOOK`.
- Want an `@mention` on errors? Put your numeric Discord user ID into `DISCORD_USER_ID`.

With a webhook set, **every** run posts a single Discord message — a short voice line from Ju Fufu 🐯, the check-in report grouped per account (each line in a quote block), and promo-code lines if redemption is on:

```text
Fu-fu~ A calm morning. All rewards collected, all tails in order~ 🐯
> ✅ [Genshin Impact] Alice: Got Primogem x20 (total: 31)
> ⏭️ [Honkai: Star Rail] Bob: Already signed in today (total: 14)
> 🎁 [Genshin Impact] Alice: +2 new — GENSHIN2026, NEWCODE01
> ⏭️ [Genshin Impact] Alice: rest — 3 already redeemed, 1 expired
> ⚠️ [Genshin Impact] Alice: 2 in cooldown — retried next run

Nothing new — and that's good too. Rest now, dear~ 🐯
```

Report lines use a single `>` quote prefix so Ju Fufu's sign-off (after the blank line) stays outside the quote block.

Promo codes are **grouped per account** (one line for new claims + one compact summary), not one line per code.

> 🔒 **Prefer keeping secrets out of the file?** You can store cookies and the webhook in Apps Script **Script Properties** instead — see [Configuration reference](#storing-secrets-in-script-properties).

### 4. (Optional) Enable code redemption

Once basic check-in works for a day or two, set `enableCodeRedemption: true`. Now the script also redeems active promo codes for every account that just signed in.

Already-redeemed codes are remembered in `PropertiesService`, so they won't be claimed twice.

**Want codes checked even for already-signed-in accounts?** Set `redeemCodesEvenIfSignedIn: true` — useful if you run twice a day or a limited code drops after the morning check-in.

> 📖 The full list of code outcomes and how the script reacts to each is in [Configuration reference → Code outcomes](#code-outcomes).

**Force a one-off redemption** from the toolbar (e.g. the API missed a fresh code):

- `redeemGenshinCodes(true)` — Genshin
- `redeemStarRailCodes(true)` — Star Rail
- `redeemZenlessCodes(true)` — Zenless Zone Zero

> ℹ️ Code redemption is not supported for Honkai Impact 3rd.

### 5. Set up a daily trigger

1. Click the **⏰ clock** icon in the editor (left sidebar).
2. Click **+ Add Trigger**.
3. Configure:
   - **Function:** `checkInAllGames`
   - **Deployment:** `Head`
   - **Event source:** `Time-driven`
   - **Type:** `Day timer`
   - **Time:** pick **05:00–06:00 server time** for your region — see [Daily reset schedule](#daily-reset-schedule).
4. Save and accept the authorisation prompts.

### 6. Run it once manually

Click ▶ **Run** with `checkInAllGames` selected. Accept the authorisation dialog. Open the **Executions** tab to see logs and errors.

If you set a webhook, the Discord report arrives within seconds.

---

## How the script works

`checkInAllGames()` does three things, in order:

1. **Reset** the in-memory notification buffer.
2. **For each game** (Genshin, Honkai, Star Rail, Zenless), for each account:
   - look up the account (`getAccountDetails`),
   - read today's sign-in status (`getSignInfo`),
   - read the award pool (`getAwardsData`),
   - if not signed in yet, sign in (`sign`).
   - If `enableCodeRedemption` is on, redeem new promo codes (`redeemCodes`).
3. **Flush** everything to Discord as a single message (`flushDiscordNotifications`).

`manuallyRedeemCodes(gameName, forceRedeem)` does the same but **only** redeems codes (no check-in). It's what the `redeemGenshinCodes` / `redeemStarRailCodes` / `redeemZenlessCodes` helpers call.

---

## Configuration reference

### Flags

| Flag | Default | What it does |
|---|---|---|
| `enableCodeRedemption` | `false` | Redeem active promo codes for accounts that just signed in |
| `redeemCodesEvenIfSignedIn` | `false` | Also redeem codes for accounts already signed in today |
| `redeemSleepMs` | `6000` | Pause (ms) between individual code redemptions — protects against HoYoLAB rate limits. The script enforces a hard floor of 2000 ms, so values below that are clamped up |

### Code outcomes

How the script classifies each redemption attempt (by API retcode):

| Retcode / response | Meaning | Script reaction |
|---|---|---|
| `-2017` / `-2018` | Already redeemed on this account | Skip, remember, never retry |
| `-2001` / `-2003` | Expired / invalid | Warning (⚠️), remembered, never retried |
| `-2016` (cooldown), `-1048` (API busy) | Transient | Not remembered, retried next run |
| `-1071` / `-100` / `-10001` | Cookie expired | Stop the rest of this account's codes, clear message |
| `1034` / `10035` / `10041`, or `gt_result.is_risk` | CAPTCHA / risk gate | Stop, asks you to solve manually |
| Region/platform-locked (message like *"Your current region is not eligible…"*) | Never eligible on this account | Added to a per-account **blocklist**, skipped on later runs (reported once as 🚫) |

### Code sources

Active promo codes are pulled from **two** community aggregators in parallel and merged (deduplicated):

- [api.ennead.cc](https://api.ennead.cc/mihoyo/genshin/codes) — torikushiii's JSON aggregator
- [Hum-Bao/hoyoverse-codes](https://github.com/Hum-Bao/hoyoverse-codes) — GitHub-hosted txt files, updated daily

Running both in parallel means a single outage doesn't block redemption. If both fail, the run reports 0 codes and moves on. To add a third source, append an entry to `CODE_SOURCES` and to `CODE_SOURCE_ORDER` in `index.js`.

> 📊 Measured on 2026-07-04: Genshin 4, Star Rail 11, Zenless 8 unique codes after dedup.

### Storing secrets in Script Properties

Keeping cookies and the webhook in the source is fine for a personal project, but they **leak if you ever push or share the file**. The script can instead read them from Apps Script **Script Properties**.

**What to add** (Project Settings → Script Properties → Add script property):

| Key | Value |
|---|---|
| `COOKIE_genshin` | JSON array of Genshin cookies: `["ltoken_v2=…; ltuid_v2=…;", "..."]` |
| `COOKIE_honkai` | same, for Honkai Impact 3rd |
| `COOKIE_starrail` | same, for Honkai: Star Rail |
| `COOKIE_zenless` | same, for Zenless Zone Zero |
| `WEBHOOK_URL` | Discord webhook URL (optional) |
| `DISCORD_ID` | your numeric Discord user ID, pings on errors (optional) |

**Two ways to fill them in:**

- **By hand** — paste each key as a JSON array of cookie strings.
- **Automatically** — fill the inline `config` and `DISCORD_WEBHOOK` as usual, then run `storeSecretsFromConfig()` **once** from the toolbar. It copies everything into Script Properties for you.

**After that:**

- Properties **take precedence** over the inline values (same for `WEBHOOK_URL`/`DISCORD_ID`).
- Once populated, you can **blank out the secrets in the source** (empty `data: []`, `DISCORD_WEBHOOK = null`) before pushing — the script keeps working.
- Redeemed codes are stored per account (`<game>_redeemed_codes_<uid>`), so a code redeemed by account A is still redeemed on account B of the same game. `resetAllRedeemedCodes()` and `viewAllRedeemedCodes()` handle both legacy and per-account keys.

---

## Daily reset schedule

All four games reset their daily check-in at the same wall-clock moment: **04:00 server time**. Because it's server-relative, the UTC time depends on your account's region.

| Region | UTC | US (ET) | Moscow (UTC+3) | Japan (JST, UTC+9) |
|---|---|---|---|---|
| **NA** | 09:00 | 04:00 | 12:00 | 18:00 |
| **EU** | 03:00 | 22:00 prev day | 06:00 | 12:00 |
| **SEA** | 20:00 prev day | 15:00 prev day | 23:00 prev day | 05:00 next day |
| **TW** | 20:00 prev day | 15:00 prev day | 23:00 prev day | 05:00 next day |

> 🕐 During northern-hemisphere summer (US/EU DST): NA → **08:00 UTC**, EU → **02:00 UTC**. SEA/TW unaffected.

**Picking a trigger time — the easy rule:**

Schedule for **05:00 server time** in your region (or the latest region, if you have several). In UTC: **NA only** → 09:30 UTC (08:30 summer); **EU only** → 03:30 UTC (02:30 summer); **SEA/TW only** → 20:30 UTC. Or schedule for NA's reset (`09:30 UTC` winter / `08:30 UTC` summer) to cover everything.

**How to find your region:** after the first run, open **Executions → latest run → logs**, and look at the `region` field of each account (`NA`/`EU`/`SEA`/`TW`). Or just check your in-game server name.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Nothing in Discord** | Check `DISCORD_WEBHOOK` is the full `https://discord.com/api/webhooks/…` URL. Check **Executions** for a `flushDiscordNotifications` error. If every account was already signed in and nothing else happened, the buffer is empty and the script deliberately sends nothing. |
| **"HoYoLAB server unavailable (HTTP 5xx/429) — retry later"** | Transient — the API is down or rate-limiting. Nothing is broken; nothing is marked redeemed; the next run retries. If it persists for hours, check HoYoLAB announcements. |
| **"Cookie is missing ltuid/ltuid_v2"** | The cookie is a partial copy or expired. Re-grab the full cookie (step 2, from the `getGameRecordCard` request). |
| **`Error: undefined`** | The underlying error had no `.message`. The function name in the surrounding text tells you which API call failed; full error is in **Executions**. |
| **"cookie expired — grab a fresh one"** | Cookie expired (`-1071`/`-100`/`-10001`). The script stops that account's codes and reports once. Re-grab the cookie. |
| **Already signed in, but codes not claimed** | Default: codes only redeem for accounts that *just* signed in. Set `redeemCodesEvenIfSignedIn: true`, or force once with `redeemGenshinCodes(true)` etc. |
| **"Unknown region" for a whole account** | Your account is on a server the script doesn't recognise yet. The account is skipped with a single error line; no codes are attempted. Report the region name in an issue so it can be mapped. |

---

## Upstream comparison

| Area | Upstream (Google Script) | This fork |
|---|---|---|
| Discord notifications on check-in | ✅ (only on a new sign-in) | ✅ (always) |
| Discord notifications on code redemption | ❌ | ✅ |
| Discord notifications on errors | ❌ | ✅ |
| Webhook POSTs per run | up to 4 × accounts | exactly 1 |
| Files in the repo | 100+ | 9 |
| Code source | `api.ennead.cc` only | `api.ennead.cc` + Hum-Bao, merged in parallel |

---

## License

[AGPL-3.0](LICENSE), inherited from the upstream project. If you fork and run this as a service, the AGPL requires you to publish your modifications under the same licence.

---

## Tests

The repo has a smoke-test harness that stubs the GAS runtime and drives the main flows against canned responses — no Google account needed:

```bash
npm test
# or, without npm:
node services/google-script/__tests__/smoke-test.js
```

It covers check-in, per-account code redemption, retcode classification, HTTP 429/5xx handling, legacy-key migration, and the Discord report format.
