# Discord Webhooks

This is an **OPTIONAL** feature. If you want to receive a Discord notification
when the check-in runs (including codes redeemed and errors), create a Discord
webhook and put its URL into the script.

## 1. Create a webhook in your Discord server

1. Go to your server's settings (create a server first if you don't have one).

   ![](https://i.imgur.com/FWfK3My.png)

2. Open the **Integrations** tab and click **Create Webhook**.

   ![](https://i.imgur.com/DnELZJl.png)

3. Give the webhook a name (e.g. "HoyoLab Auto") and click **Copy Webhook URL**.

   ![](https://i.imgur.com/AkfTTBB.png)

4. Optional: add `-avatar` customization in Discord settings if you want a custom icon.

## 2. Wire the URL into the script

You have two options — **Script Properties** is safer if you ever push/share the
source file; the inline constant is simpler for a personal project.

**Option A — inline constant (simplest):**

In `services/google-script/index.js`, find:

```javascript
const DISCORD_WEBHOOK = null; // Replace with your Discord webhook URL (optional)
```

and replace `null` with your webhook URL inside quotes:

```javascript
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/…";
```

**Option B — Script Properties (keeps secrets out of the file):**

In the Apps Script editor, open **Project Settings → Script Properties** and add:

| Key | Value |
| --- | --- |
| `WEBHOOK_URL` | your Discord webhook URL |
| `DISCORD_ID` | (optional) your numeric Discord user ID, pings you on errors |

The script prefers the properties value and falls back to the inline constant,
so either style works. To copy the inline values into properties quickly, run
`storeSecretsFromConfig()` once from the toolbar, then blank them out of the source.

## 3. Verify

Run `checkInAllGames()` once manually. Within a few seconds you should see a
single Discord message in the channel: a short Ju Fufu voice line, the check-in
report (grouped per account), and promo-code lines if redemption is enabled.

If nothing arrives:

- The URL must be the full `https://discord.com/api/webhooks/…` value.
- If every account was already signed in and there were no code events or
  errors, the buffer is empty and the script deliberately sends nothing.
- Check the **Executions** tab for a `flushDiscordNotifications` error.
