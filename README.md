# HoyoLab Auto — Google Apps Script edition

A self-contained [Google Apps Script](https://script.google.com/) that signs you into Genshin Impact, Honkai: Star Rail, Honkai Impact 3rd, and Zenless Zone Zero every day, and (optionally) redeems active promo codes. Runs entirely on Google's infrastructure — no local machine, no Docker, no cost.

This is a fork of [torikushiii/hoyolab-auto](https://github.com/torikushiii/hoyolab-auto) trimmed down to just the Apps Script file, with a fixed Discord notification flow that actually works for code redemption.

## What's different from upstream

| Area | Upstream (Google Script) | This fork |
| --- | --- | --- |
| Discord notifications on check-in | ✅ (but only when a new sign-in happens) | ✅ (always — even when already signed in) |
| Discord notifications on code redemption | ❌ | ✅ |
| Discord notifications on errors | ❌ | ✅ |
| Number of webhook POSTs per run | up to 4 × accounts | exactly 1 |
| `checkInAllGames()` flushes the buffer | ❌ | ✅ |
| `manuallyRedeemCodes()` flushes the buffer | ❌ (had no notifications at all) | ✅ |
| Files in the repo | 100+ (Node.js, Docker, …) | 5 |

## Repository layout

```text
hoyolab-auto/
├── LICENSE                                  # AGPL-3.0, inherited from upstream
├── README.md                                # you are here
├── .gitignore
├── services/
│   └── google-script/
│       ├── index.js                         # the actual script — paste this into Apps Script
│       └── README.md                        # original upstream setup guide (kept for reference)
└── setup/
    └── DISCORD_WEBHOOK.md                   # how to create a Discord webhook URL
```

## Quick start

### 1. Create the script

1. Open [https://script.google.com/](https://script.google.com/) and click **+ New project**.
2. Delete the placeholder `function myFunction() { … }` in the editor.
3. Open [`services/google-script/index.js`](services/google-script/index.js) in this repo, select all, copy, and paste it into the Apps Script editor.
4. Click the 💾 floppy-disk icon to save. Name the project anything you like (e.g. "HoyoLab Auto").

### 2. Add your accounts

In the same editor, scroll to the top of the file. You'll see:

```javascript
const config = {
	enableCodeRedemption: false, // set to true once everything else works
	genshin:  { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
	honkai:   { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
	starrail: { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
	zenless:  { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
};
```

Replace the placeholders with your real cookies, one per line. For multiple accounts in the same game, add more strings inside the same `data: []` array.

#### How to get the cookie

The cleanest way is the one that works for both **check-in and code redemption** (the original repo warns that the check-in-page cookie often doesn't carry the right tokens for code redemption):

1. Open [HoyoLab](https://www.hoyolab.com/) in your browser and sign in.
2. Press `F12` to open DevTools and switch to the **Network** tab.
3. Refresh the page; in the network log, search for `getGameRecordCard` and click the matching request.
4. In the right-hand pane, open the **Headers** tab, scroll to **Request Headers**, and copy the entire `cookie` value.
5. Paste that string into the right `data: []` array in `config`.

### 3. (Optional) Enable Discord notifications

A few lines below the `config` object you'll see:

```javascript
const DISCORD_WEBHOOK = null;  // replace with your Discord webhook URL (optional)
const DISCORD_USER_ID = "";    // optional, pings you when something goes wrong
```

Follow [`setup/DISCORD_WEBHOOK.md`](setup/DISCORD_WEBHOOK.md) to create a webhook, then paste the URL into `DISCORD_WEBHOOK` (inside quotes). To also get a `@mention` whenever an error appears in the report, paste your numeric Discord user ID into `DISCORD_USER_ID`.

With the webhook set, **every** run ends with a single Discord message that looks like this:

```text
✅ [Genshin Impact] Alice (800000001): Got Primogem x20 (total: 31)
⏭️ [Honkai: Star Rail] Bob (800000002): Already signed in today (total: 14)
✅ [Zenless Zone Zero] Carol (800000003): Got Polychrome x50 (total: 8)
🎁 [Genshin Impact] Code GENSHIN2026 claimed for Alice (800000001)
⏭️ [Honkai: Star Rail] Code STARRAIL1 already redeemed for Bob
```

### 4. (Optional) Enable code redemption

Once the basic check-in is working for a day or two, set:

```javascript
enableCodeRedemption: true,
```

This will additionally call `redeemCodes()` for each account that just signed in. Codes you've already redeemed are remembered in Apps Script's `PropertiesService`, so they will not be claimed twice.

If you ever need to force-redeem a code (e.g. the API didn't return it in time), pick one of these functions in the toolbar and run it once:

- `redeemGenshinCodes(forceRedeem = true)` — Genshin
- `redeemStarRailCodes(forceRedeem = true)` — Star Rail
- `redeemZenlessCodes(forceRedeem = true)` — Zenless Zone Zero

For Honkai Impact 3rd, code redemption is not supported by this script.

### 5. Set up a daily trigger

1. In the Apps Script editor, click the clock icon ⏰ on the left ("Triggers").
2. Click **+ Add Trigger** in the bottom-right.
3. Configure:
   - **Choose which function to run:** `checkInAllGames`
   - **Which deployment should run:** `Head`
   - **Select event source:** `Time-driven`
   - **Select type of time-based trigger:** `Day timer`
   - **Select time of day:** see [Daily reset schedule](#daily-reset-schedule) below — pick **05:00–06:00 server time** for the latest region you play on, not your own morning.
4. Save. Google will ask you to authorise the script to access external services and your script properties — accept.

### 6. Run it once manually

Click the ▶ **Run** button with `checkInAllGames` selected in the toolbar. The first run will pop up an authorisation dialog — accept it. Open the **Executions** tab in the left sidebar to see logs and any errors.

If you set `DISCORD_WEBHOOK`, you should see the report message arrive in Discord within a few seconds.

## Daily reset schedule

The daily check-in bonus for **all four supported games** (Genshin Impact, Honkai Impact 3rd, Honkai: Star Rail, Zenless Zone Zero) refreshes at the same wall-clock moment: **04:00 server time**. The reset is server-relative, not UTC-relative, so the actual UTC tick depends on which region your account is on.

| Region | Server TZ | Reset in server time | Reset in UTC | Reset in Moscow (UTC+3) |
|---|---|---|---|---|
| **NA** (America) | UTC−5 (EST) / UTC−4 (EDT) | 04:00 | 09:00 (winter) / 08:00 (summer) | 12:00 (winter) / 11:00 (summer) |
| **EU** (Europe) | UTC+1 (CET) / UTC+2 (CEST) | 04:00 | 03:00 (winter) / 02:00 (summer) | 06:00 (winter) / 05:00 (summer) |
| **SEA** (Southeast Asia) | UTC+8 (SGT) | 04:00 | 20:00 (previous day, all year) | 23:00 (previous day, all year) |
| **TW** (Taiwan / HK / MO) | UTC+8 (CST) | 04:00 | 20:00 (previous day, all year) | 23:00 (previous day, all year) |

### How to find your region

The cookie you pasted is tied to a specific region — that's the region the account was created on, and you can't change it later. To find out which one you have:

1. Open the **Executions** tab in Apps Script after running `checkInAllGames` at least once.
2. Click the latest successful run and open the logs.
3. Look for a line like `Successful check-ins for genshin: [...]` — each entry's `region` field (one of `NA`, `EU`, `SEA`, `TW`) is your region for that game.

Or, the easy way: just look at which one matches your in-game server name in the title screen.

### Picking a trigger time

The script's `sign()` call is a no-op if you've already signed in today (`is_sign` returns `true` from the API). So **any time after the reset works** — but you want a small buffer to absorb server clock drift and any DST transitions.

Rule of thumb:

- **One region:** set the trigger to **05:00–05:30 server time** in that region.
- **Multiple regions:** set the trigger to **05:00–05:30 server time in the *latest* region** (i.e. the one whose reset fires last in your local timezone). The NA region (09:00 UTC) is almost always the last to reset; if you have any NA accounts, schedule around their reset.
- **Just use UTC if you're not sure:** in winter, 09:30 UTC is safe for all four regions; in summer (Northern DST), 08:30 UTC is safe. Apps Script's trigger UI uses your account's timezone, so pick something like `5:00pm – 6:00pm` if your local timezone is UTC+8 (SEA / TW).

You can also set **two triggers** if you have accounts in two non-overlapping resets and want each one signed in close to its reset (e.g. one at 04:00 SGT and another at 04:00 EST). The script is idempotent — extra runs just log `⏭️ Already signed in today`.

## What the script actually does

`checkInAllGames()` does, in order:

1. Resets the in-memory notification buffer.
2. For each of the four games (Genshin, Honkai, Star Rail, Zenless):
   - Calls `checkAndExecute()`, which for each cookie:
     - looks up the account (`getAccountDetails`),
     - reads today's sign-in status (`getSignInfo`),
     - reads the award pool (`getAwardsData`),
     - if the account hasn't signed in yet, performs the sign-in (`sign`).
   - If `enableCodeRedemption` is on, redeems any new promo codes for each successful account (`redeemCodes`).
3. Flushes the entire buffer to Discord as a single message (`flushDiscordNotifications`).

`manuallyRedeemCodes(gameName, forceRedeem)` is the same idea but only for code redemption, without the check-in step. It's used by the convenience wrappers `redeemGenshinCodes`, `redeemStarRailCodes`, and `redeemZenlessCodes`.

## Troubleshooting

**Nothing happens in Discord.**
- Check that `DISCORD_WEBHOOK` is the full URL (`https://discord.com/api/webhooks/…`).
- Check the **Executions** tab in Apps Script for a `flushDiscordNotifications` error.
- Make sure `NOTIFICATIONS.length > 0`. If every account was already signed in *and* there are no code events and no errors, the buffer is empty and the script deliberately sends nothing.

**I get `Error: undefined` in the report.**
This is what the script writes when the underlying error has no `.message` field. Look at the surrounding text (e.g. `Failed to fetch promo codes: undefined`) — the function name usually tells you which API call failed. The full error is also in the **Executions** tab.

**Code redemption says "retcode -1071".**
Your cookie has expired. Repeat step 2 to grab a fresh one. The error message in the report includes the exact `retcode` and the API's own message.

**My account was already signed in and codes weren't claimed.**
This is the original upstream behaviour and we didn't change it: in `checkInAllGames`, code redemption only runs for accounts that *just* signed in. If everything was already signed in for the day, use `redeemGenshinCodes(true)` / `redeemStarRailCodes(true)` / `redeemZenlessCodes(true)` from the toolbar to force it.

## License

[AGPL-3.0](LICENSE), inherited from the upstream project. If you fork and run this as a service, the AGPL requires you to publish your modifications under the same licence.
