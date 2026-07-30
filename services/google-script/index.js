const config = {
	enableCodeRedemption: false, // Set to true to enable automatic code redemption
	// If true, promo codes are checked for ALL accounts on every run, even
	// those that were already signed in today. If false (default), codes are
	// only redeemed for accounts that just signed in (upstream behaviour).
	redeemCodesEvenIfSignedIn: false,
	genshin: {
		data: [
			// "account_cookie_1",
			// "account_cookie_2",
			// ... more account cookies
		]
	},
	honkai: {
		data: [
			// "account_cookie_1",
			// "account_cookie_2",
			// ... more account cookies
		]
	},
	starrail: {
		data: [
			// "account_cookie_1",
			// "account_cookie_2",
			// ... more account cookies
		]
	},
	zenless: {
		data: [
			// "account_cookie_1",
			// "account_cookie_2",
			// ... more account cookies
		]
	}
};

// Function to reset redeemed codes for all games
function resetAllRedeemedCodes () {
	const games = ["genshin", "honkai", "starrail", "zenless"];
	for (const game of games) {
		PropertiesService.getScriptProperties().deleteProperty(`${game}_redeemed_codes`);
	}
	console.log("Redeemed codes for all games have been reset.");
}

// Function to view all stored redeemed codes
function viewAllRedeemedCodes () {
	const games = ["genshin", "honkai", "starrail", "zenless"];
	const allCodes = {};

	for (const game of games) {
		const redeemedCodes = PropertiesService.getScriptProperties().getProperty(`${game}_redeemed_codes`);
		allCodes[game] = redeemedCodes ? JSON.parse(redeemedCodes) : [];
	}

	console.log("All redeemed codes:", allCodes);
	return allCodes;
}

const DISCORD_WEBHOOK = null; // Replace with your Discord webhook URL (optional)
const DISCORD_USER_ID = ""; // Optional: Discord user ID to ping on errors (e.g. "123456789012345678")

// Promo-code data sources. Both return the current set of active codes for a
// given game. Two are wired in: ennead.cc (torikushiii's aggregator) and
// Hum-Bao/hoyoverse-codes (GitHub-hosted txt files, open source). Each source
// defines a URL builder and a parser; the fetch layer is the same.
//
// fetchCodes() hits every source in CODE_SOURCE_ORDER in parallel and merges
// the results, so adding a third source is just appending to CODE_SOURCES and
// the order array.
const CODE_SOURCES = {
	ennead: {
		name: "ennead (api.ennead.cc)",
		urlFor: gameParam => {
			if (!["genshin", "starrail", "zenless"].includes(gameParam)) {
				throw new Error(`No ennead path for game "${gameParam}"`);
			}
			return `https://api.ennead.cc/mihoyo/${gameParam}/codes`;
		},
		parse: text => {
			const data = JSON.parse(text);
			if (!data || !Array.isArray(data.active)) {
				throw new Error(`Unexpected payload: ${text.substring(0, 120)}`);
			}
			return data.active;
		}
	},
	humBao: {
		name: "Hum-Bao (github.com/Hum-Bao/hoyoverse-codes)",
		urlFor: gameParam => {
			const file = { genshin: "GENSHIN", starrail: "HSR", zenless: "ZZZ" }[gameParam];
			if (!file) throw new Error(`No Hum-Bao file for game "${gameParam}"`);
			return `https://raw.githubusercontent.com/Hum-Bao/hoyoverse-codes/main/${file}.txt`;
		},
		// txt format: one code per line, blank lines ignored, no header.
		parse: text => text.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => /^[A-Z0-9]{4,}$/.test(line))
			.map(code => ({ code }))
	}
};

// Order matters in the union: when the same code appears in multiple sources
// we keep the first entry's metadata (e.g. `rewards` from ennead) and only
// backfill from later sources if the earlier one was sparse.
const CODE_SOURCE_ORDER = ["ennead", "humBao"];

async function fetchFromSource (source, gameParam) {
	const url = source.urlFor(gameParam);
	const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
	const code = response.getResponseCode();
	if (code !== 200) {
		throw new Error(`HTTP ${code}`);
	}
	return source.parse(response.getContentText());
}

async function fetchCodes (gameParam) {
	// Hit every source in parallel, merge by code. A source that fails or
	// returns 0 codes is logged but does not block the others. If all sources
	// fail we return an empty array, matching the behaviour of the original
	// single-source fetchCodes() so the caller sees the same shape.
	const results = await Promise.allSettled(
		CODE_SOURCE_ORDER.map(key => fetchFromSource(CODE_SOURCES[key], gameParam))
	);
	const byCode = new Map();
	const sourceHits = {};
	CODE_SOURCE_ORDER.forEach((key, i) => {
		const r = results[i];
		if (r.status === "fulfilled") {
			sourceHits[key] = r.value.length;
			for (const entry of r.value) {
				const existing = byCode.get(entry.code);
				if (!existing) {
					byCode.set(entry.code, entry);
				}
				else if (!existing.rewards && entry.rewards) {
					existing.rewards = entry.rewards;
				}
			}
		}
		else {
			sourceHits[key] = `failed: ${r.reason?.message || r.reason}`;
		}
	});
	return { codes: [...byCode.values()], sourceHits };
}

// Buffered notification messages. checkInGame() collects lines into a
// per-game buffer so concurrent games never interleave and a flush triggered
// by one game's failure can't steal another game's pending lines; buffers are
// merged into NOTIFICATIONS right before flushDiscordNotifications().
const NOTIFICATIONS = [];

// Retcodes from the cdkey redemption API that mean "this code is already
// redeemed on this account" — a normal, expected outcome, not an error.
// Verified against torikushiii/hoyolab-auto (node) and
// hashblen/hoyo-redeem-codes-script (independent GAS implementation).
const REDEEM_RETCODE_ALREADY_USED = [-2017, -2018];

// Retcodes meaning "code expired or never existed" — report as a warning,
// not as a scary error line.
const REDEEM_RETCODE_EXPIRED_OR_INVALID = [-2001, -2003];

const NOTIFICATION_ICONS = {
	info: "ℹ️",
	success: "✅",
	warn: "⚠️",
	error: "❌",
	code: "🎁",
	skip: "⏭️",
	summary: "📊"
};

// Strip " (123456789)" trailing account-UIDs from any message.
// HoYoLAB game_role_id is a 7-10 digit number; the {7,10} bound keeps
// legitimate parenthesised numbers in nicknames (e.g. "Alice (2)") intact.
const UID_PAREN_RE = /\s+\(\d{7,10}\)/g;

// Routes a line either into the shared NOTIFICATIONS buffer (legacy callers)
// or into a per-game buffer when one is supplied by checkInGame().
function logNotification (level, gameName, message, buffer) {
	const icon = NOTIFICATION_ICONS[level] || "ℹ️";
	const prefix = gameName ? `[${gameName}]` : "";
	const cleaned = message.replace(UID_PAREN_RE, "");
	(buffer || NOTIFICATIONS).push(`${icon} ${prefix} ${cleaned}`.trim());
}

// Voice lines for the Discord message wrapper, in the style of Ju Fufu
// (橘福福 / "Ju Fufu" — the tiger-agent from Zenless Zone Zero).
// Sets are picked by run context (see juFufuContextualLines):
//   errors   — something actually needs attention
//   codes    — new codes were claimed today (the "hunting" good day)
//   quiet    — everything done, but nothing new happened
//   ok       — fresh check-ins happened, no errors
const JU_FUFU = {
	intro: {
		errors: [
			"Fu-fu... 🐯 Come in. I've got good news and bad news — I'll start with the bad, so we end on the good.",
			"Mur... Sweetheart, don't be scared, but today wasn't all smooth. Let me walk you through it~ 🐾"
		],
		codes: [
			"Fu-fu-fu~ 🐯 The little tiger went hunting today — look what she dragged back!",
			"Mur-mur~ Come sit closer, dear. Today I actually have something to brag about~ 🐾"
		],
		quiet: [
			"Mur~ A quiet day, sunshine. Everything was already done before me — I just double-checked~ 🐾",
			"Fu-fu~ A calm morning. All rewards collected, all tails in order~ 🐯"
		],
		ok: [
			"Fu-fu-fu~ The family report is in! 🐯",
			"Nyam-nyam~ Another day, another report~ 🐾"
		]
	},
	outro: {
		errors: [
			"Take a look at the ❌ lines when you have a minute. It's usually just a stale cookie. Fu-fu believes in you~ 🐾",
			"Don't sit on those errors, dear — a cookie takes two minutes to refresh, and rewards hate waiting. I'm here if you need me~ 🐯"
		],
		codes: [
			"The loot is delivered, the tails are happy~ See you tomorrow, sunshine! 🐯",
			"Fu-fu-fu~ A fine hunt. Check your in-game mail — there are presents waiting~ 🐾"
		],
		quiet: [
			"Nothing new — and that's good too. Rest now, dear~ 🐯",
			"Fu-fu, all clean. See you tomorrow, sweetie~ 🐾"
		],
		ok: [
			"Have a lovely day, sunshine~ 🐾",
			"Take care, dear~ Fu-fu-fu, see you tomorrow~ 🐯"
		]
	}
};

function juFufuPick (arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

// Picks the intro/outro set that matches what actually happened in the run.
function juFufuContextualLines (lines) {
	const hasErrors = lines.some(line => line.includes("❌"));
	const hasNewCodes = lines.some(line => line.includes("🎁"));
	const hasCheckins = lines.some(line => line.includes("✅"));
	let mood = "ok";
	if (hasErrors) mood = "errors";
	else if (hasNewCodes) mood = "codes";
	else if (!hasCheckins) mood = "quiet";
	return { intro: juFufuPick(JU_FUFU.intro[mood]), outro: juFufuPick(JU_FUFU.outro[mood]), mood };
}

// Builds the compact per-account promo-code block:
//   🎁 [Game] Nick: +2 new — CODE1, CODE2
//   ⏭️ [Game] Nick: nothing new (11 already redeemed, 2 expired)
//   ❌ [Game] Nick: 1 failed — CODE3 (Invalid cookie)
function formatCodeReport (gameName, account, total, claimed, skipped, expired, failed, isForce = false) {
	const lines = [];
	const nick = `${account.nickname} (${account.uid})`.replace(UID_PAREN_RE, "");
	const label = isForce ? `${nick} (force-run)` : nick;

	if (claimed.length > 0) {
		lines.push(`🎁 [${gameName}] ${label}: +${claimed.length} new — ${claimed.join(", ")}`);
	}
	if (failed.length > 0) {
		for (const f of failed) {
			lines.push(`❌ [${gameName}] ${label}: failed — ${f}`);
		}
	}
	// The quiet line: only when there's nothing exciting to say, or to account
	// for the remaining codes after a partial success.
	const quietCount = skipped.length + expired.length;
	if (claimed.length === 0 && failed.length === 0) {
		const parts = [];
		if (skipped.length > 0) parts.push(`${skipped.length} already redeemed`);
		if (expired.length > 0) parts.push(`${expired.length} expired`);
		lines.push(`⏭️ [${gameName}] ${label}: nothing new (${parts.join(", ") || "0 active codes"})`);
	}
	else if (quietCount > 0) {
		const parts = [];
		if (skipped.length > 0) parts.push(`${skipped.length} already redeemed`);
		if (expired.length > 0) parts.push(`${expired.length} expired`);
		lines.push(`⏭️ [${gameName}] ${label}: rest — ${parts.join(", ")}`);
	}
	if (total === 0) {
		// No active codes at all — one line instead of an empty-looking report.
		return [`ℹ️ [${gameName}] ${label}: no active promo codes right now`];
	}
	return lines;
}

function splitMessage (text, maxLen) {
	if (text.length <= maxLen) {
		return [text];
	}
	const chunks = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}
		let cut = remaining.lastIndexOf("\n", maxLen);
		if (cut === -1 || cut < maxLen / 2) {
			cut = maxLen;
		}
		chunks.push(remaining.substring(0, cut));
		remaining = remaining.substring(cut).trimStart();
	}
	return chunks;
}

function flushDiscordNotifications () {
	if (!DISCORD_WEBHOOK || NOTIFICATIONS.length === 0) {
		NOTIFICATIONS.length = 0;
		return;
	}

	const hasErrors = NOTIFICATIONS.some(line => line.includes("❌"));
	const body = NOTIFICATIONS.join("\n");
	const { intro, outro } = juFufuContextualLines(NOTIFICATIONS);
	// ">>> " on every report line marks it as a block-quote, visually
	// separating Ju Fufu's commentary from the data she's reporting.
	const quoted = body.split("\n").map(line => `>>> ${line}`).join("\n");
	const wrapped = `${intro}\n${quoted}\n${outro}`;
	const chunks = splitMessage(wrapped, 1900); // Discord content limit is 2000

	for (let i = 0; i < chunks.length; i++) {
		let content = chunks[i];
		if (i === 0 && hasErrors && DISCORD_USER_ID) {
			content = `<@${DISCORD_USER_ID}> ${content}`;
		}
		try {
			UrlFetchApp.fetch(DISCORD_WEBHOOK, {
				method: "POST",
				contentType: "application/json",
				payload: JSON.stringify({ content }),
				muteHttpExceptions: true
			});
		}
		catch (e) {
			console.error("flushDiscordNotifications", `Failed to POST to Discord: ${e?.message || e}`);
		}
		if (i < chunks.length - 1) {
			Utilities.sleep(1000);
		}
	}

	NOTIFICATIONS.length = 0;
}

const DEFAULT_CONSTANTS = {
	genshin: {
		ACT_ID: "e202102251931481",
		game: "Genshin Impact",
		gameId: 2,
		url: {
			info: "https://sg-hk4e-api.hoyolab.com/event/sol/info",
			home: "https://sg-hk4e-api.hoyolab.com/event/sol/home",
			sign: "https://sg-hk4e-api.hoyolab.com/event/sol/sign"
		}
	},
	honkai: {
		ACT_ID: "e202110291205111",
		game: "Honkai Impact 3rd",
		gameId: 1,
		url: {
			info: "https://sg-public-api.hoyolab.com/event/mani/info",
			home: "https://sg-public-api.hoyolab.com/event/mani/home",
			sign: "https://sg-public-api.hoyolab.com/event/mani/sign"
		}
	},
	starrail: {
		ACT_ID: "e202303301540311",
		game: "Honkai: Star Rail",
		gameId: 6,
		url: {
			info: "https://sg-public-api.hoyolab.com/event/luna/os/info",
			home: "https://sg-public-api.hoyolab.com/event/luna/os/home",
			sign: "https://sg-public-api.hoyolab.com/event/luna/os/sign"
		}
	},
	zenless: {
		ACT_ID: "e202406031448091",
		game: "Zenless Zone Zero",
		gameId: 8,
		url: {
			info: "https://sg-public-api.hoyolab.com/event/luna/zzz/os/info",
			home: "https://sg-public-api.hoyolab.com/event/luna/zzz/os/home",
			sign: "https://sg-public-api.hoyolab.com/event/luna/zzz/os/sign"
		}
	}
};

// Extracts the ltuid from a HoYoLAB cookie string. Returns null instead of
// throwing a confusing TypeError when the cookie is stale or mis-pasted —
// this is the single most common setup failure for this script.
function extractLtuid (cookie) {
	const m = String(cookie).match(/ltuid(?:_v2)?=([^;]+)/);
	return m ? m[1] : null;
}

class Game {
	/**
     * @param {string} name - The short name of the game (e.g., "genshin").
     * @param {Object} config - The configuration object for the game.
     */
	constructor (name, config) {
		this.name = name;
		this.fullName = DEFAULT_CONSTANTS[name].game; // Get full name from constants
		this.config = { ...DEFAULT_CONSTANTS[name], ...config.config };
		this.data = config.data || [];
		this._codesCache = null; // Per-run cache for fetchCodes()
		this._recordCardCache = new Map(); // ltuid -> raw record-card payload

		if (this.data.length === 0) {
			console.warn(`No ${this.fullName} accounts provided. Skipping...`);
			return;
		}
	}

	async checkAndExecute (buffer) {
		const accounts = this.data;
		if (accounts.length === 0) {
			logNotification("warn", this.fullName, "No active accounts found", buffer);
			return [];
		}

		const success = [];
		for (const cookie of accounts) {
			try {
				const ltuid = extractLtuid(cookie);
				if (!ltuid) {
					logNotification("error", this.fullName, "Cookie is missing ltuid/ltuid_v2 — grab a fresh cookie (see README step 2)", buffer);
					continue;
				}
				const accountDetails = await this.getAccountDetails(cookie, ltuid);
				if (!accountDetails) {
					logNotification("error", this.fullName, `Failed to get account details for ltuid ${ltuid}`, buffer);
					continue;
				}

				const info = await this.getSignInfo(cookie);
				if (!info.success) {
					logNotification("error", this.fullName, `${accountDetails.nickname} (${accountDetails.uid}): Failed to get sign info`, buffer);
					continue;
				}

				const data = {
					total: info.data.total,
					today: info.data.today,
					isSigned: info.data.isSigned
				};

				if (data.isSigned) {
					logNotification("skip", this.fullName, `${accountDetails.nickname} (${accountDetails.uid}): Already signed in today (total: ${data.total})`, buffer);
					// Optionally still redeem codes for already-signed-in accounts
					// (config.redeemCodesEvenIfSignedIn). The account entry is
					// pushed to `success` marked with alreadySigned so the
					// caller can tell it apart from a fresh check-in.
					if (config.redeemCodesEvenIfSignedIn && this.name !== "honkai") {
						success.push({
							platform: this.name,
							alreadySigned: true,
							account: {
								uid: accountDetails.uid,
								nickname: accountDetails.nickname,
								rank: accountDetails.rank,
								region: accountDetails.region,
								cookie
							}
						});
					}
					continue;
				}

				const awardsData = await this.getAwardsData(cookie);
				if (!awardsData.success) {
					logNotification("error", this.fullName, `${accountDetails.nickname} (${accountDetails.uid}): Failed to get awards data`, buffer);
					continue;
				}

				const awards = awardsData.data;

				const totalSigned = data.total;
				// total_sign_day is normally the index of today's award, but guard
				// against any month-length surprise instead of crashing on undefined.
				const awardEntry = awards[totalSigned] || awards[totalSigned % awards.length] || null;
				const awardObject = awardEntry
					? {
						name: awardEntry.name,
						count: awardEntry.cnt,
						icon: awardEntry.icon
					}
					: { name: "Unknown reward", count: 0, icon: "" };

				const sign = await this.sign(cookie);
				if (!sign.success) {
					logNotification("error", this.fullName, `${accountDetails.nickname} (${accountDetails.uid}): Sign-in API call failed`, buffer);
					continue;
				}

				console.info(
					`${this.fullName}:CheckIn`,
					`Today's Reward: ${awardObject.name} x${awardObject.count}`
				);

				logNotification("success", this.fullName, `${accountDetails.nickname} (${accountDetails.uid}): Got ${awardObject.name} x${awardObject.count} (total: ${data.total + 1})`, buffer);

				success.push({
					platform: this.name,
					total: data.total + 1,
					account: {
						uid: accountDetails.uid,
						nickname: accountDetails.nickname,
						rank: accountDetails.rank,
						region: accountDetails.region,
						cookie
					},
					award: awardObject
				});
			}
			catch (e) {
				console.error(`${this.fullName}:CheckIn`, e);
				logNotification("error", this.fullName, `Unexpected error: ${e?.message || String(e)}`, buffer);
			}
			}

			return success;
			}

			// The record-card endpoint returns every game profile for the account in one
			// response; cache it per ltuid for the duration of this run so multi-game
			// accounts don't trigger one extra request per game.
			async getAccountDetails (cookieData, ltuid) {
			try {
			let data = this._recordCardCache.get(ltuid);
			if (!data) {
				const options = {
					method: "GET",
					headers: {
						"User-Agent": this.userAgent,
						Cookie: cookieData
					}
				};

				const url = `https://bbs-api-os.hoyolab.com/game_record/card/wapi/getGameRecordCard?uid=${ltuid}`;
				const response = await UrlFetchApp.fetch(url, options);
				data = JSON.parse(response.getContentText());

				if (response.getResponseCode() !== 200 || data.retcode !== 0) {
					throw new Error(`Failed to login to ${this.fullName} account: ${JSON.stringify(data)}`);
				}
				this._recordCardCache.set(ltuid, data);
			}

			const accountData = data.data.list.find(account => account.game_id === this.config.gameId);
			if (!accountData) {
				throw new Error(`No ${this.fullName} account found for ltuid: ${ltuid}`);
			}

			return {
				uid: accountData.game_role_id,
				nickname: accountData.nickname,
				rank: accountData.level,
				region: this.fixRegion(accountData.region)
			};
			}
			catch (e) {
			console.error(`${this.fullName}:login`, `Error: ${e?.message || String(e)}`);
			throw e; // Re-throw to be handled by the caller
			}
			}

	async sign (cookieData) {
		try {
			const payload = { act_id: this.config.ACT_ID };
			const options = {
				method: "POST",
				contentType: "application/json",
				headers: {
					"User-Agent": this.userAgent,
					Cookie: cookieData,
					"x-rpc-signgame": this.getSignGameHeader()
				},
				payload: JSON.stringify(payload)
			};

			const response = UrlFetchApp.fetch(this.config.url.sign, options);
			const data = JSON.parse(response.getContentText());

			if (response.getResponseCode() !== 200 || data.retcode !== 0) {
				console.error(`${this.fullName}:sign`, "Failed to sign in.", data);
				return { success: false };
			}

			return { success: true };
		}
		catch (e) {
			console.error(`${this.fullName}:sign`, `Error: ${e?.message || String(e)}`);
			return { success: false };
		}
	}

	getSignGameHeader () {
		switch (this.name) {
			case "starrail":
				return "hkrpg";
			case "genshin":
				return "hk4e";
			case "zenless":
				return "zzz";
			default:
				return "";
		}
	}

	async getSignInfo (cookieData) {
		try {
			const url = `${this.config.url.info}?act_id=${this.config.ACT_ID}`;
			const response = await UrlFetchApp.fetch(url, {
				headers: {
					Cookie: cookieData,
					"x-rpc-signgame": this.getSignGameHeader()
				}
			});
			const data = JSON.parse(response.getContentText());

			if (response.getResponseCode() !== 200 || data.retcode !== 0) {
				console.error(
					`${this.fullName}:getSignInfo`,
					"Failed to get sign info.",
					data
				);
				return { success: false };
			}

			return {
				success: true,
				data: {
					total: data.data.total_sign_day,
					today: data.data.today,
					isSigned: data.data.is_sign
				}
			};
		}
		catch (e) {
			console.error(`${this.fullName}:getSignInfo`, `Error: ${e?.message || String(e)}`);
			return { success: false };
		}
	}

	async getAwardsData (cookieData) {
		try {
			const url = `${this.config.url.home}?act_id=${this.config.ACT_ID}`;
			const response = await UrlFetchApp.fetch(url, {
				headers: {
					Cookie: cookieData,
					"x-rpc-signgame": this.getSignGameHeader()
				}
			});
			const data = JSON.parse(response.getContentText());

			if (response.getResponseCode() !== 200 || data.retcode !== 0) {
				console.error(
					`${this.fullName}:getAwardsData`,
					"Failed to get awards data.",
					data
				);
				return { success: false };
			}

			if (data.data.awards.length === 0) {
				console.warn(
					`${this.fullName}:getAwardsData`,
					"No awards data available."
				);
			}

			return { success: true, data: data.data.awards };
		}
		catch (e) {
			console.error(
				`${this.fullName}:getAwardsData`,
				`Error: ${e?.message || String(e)}`
			);
			return { success: false };
		}
	}

	fixRegion (region) {
		switch (region) {
			case "os_cht":
			case "prod_gf_sg":
			case "prod_official_cht":
				return "TW";
			case "os_asia":
			case "prod_gf_jp":
			case "prod_official_asia":
				return "SEA";
			case "eur01":
			case "os_euro":
			case "prod_gf_eu":
			case "prod_official_eur":
				return "EU";
			case "usa01":
			case "os_usa":
			case "prod_gf_us":
			case "prod_official_usa":
				return "NA";
			default:
				return "Unknown";
		}
	}

	get userAgent () {
		return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
	}

	async redeemCodes (account, buffer) {
		const codes = await this.fetchCodes(buffer);
		const redeemedCodes = this.getRedeemedCodes();

		// Collect outcomes per code, then emit ONE grouped block per account
		// instead of a line per code — with ~10 active codes the old per-line
		// style flooded the Discord report.
		const claimed = [];
		const skipped = [];
		const expired = [];
		const failed = [];

		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (redeemedCodes.includes(code.code)) {
				console.log(`Code ${code.code} already redeemed for ${this.fullName}`);
				skipped.push(code.code);
				continue;
			}

			const result = await this.redeemCode(account, code.code);
			// Rate-limit pause between redemption calls — but never after the
			// final code, where it would just add 6 dead seconds to the run.
			if (i < codes.length - 1) {
				Utilities.sleep(6000);
			}

			if (result && result.success) {
				this.saveRedeemedCode(code.code);
				claimed.push(code.code);
			}
			else if (result && result.alreadyUsed) {
				// Server says the code was already redeemed — remember it so we
				// never try it again, and report as a skip rather than an error.
				this.saveRedeemedCode(code.code);
				skipped.push(code.code);
			}
			else if (result && result.expired) {
				expired.push(code.code);
			}
			else {
				const msg = String(result ? result.message : "Unknown error");
				failed.push(`${code.code} (${msg.length > 80 ? msg.substring(0, 80) + "…" : msg})`);
			}
		}

		(buffer || NOTIFICATIONS).push(...formatCodeReport(this.fullName, account, codes.length, claimed, skipped, expired, failed));
	}

	// Force redemption of all codes regardless of previous redemption status
	async forceRedeemCodes (account, buffer) {
		const codes = await this.fetchCodes(buffer);

		const claimed = [];
		const skipped = [];
		const expired = [];
		const failed = [];

		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			console.log(`Attempting to redeem code ${code.code} for ${this.fullName}`);
			const result = await this.redeemCode(account, code.code);
			if (i < codes.length - 1) {
				Utilities.sleep(6000);
			}

			if (result && result.success) {
				// Keep the local redeemed-list in sync so a normal run tomorrow
				// doesn't retry codes the force-run already claimed.
				this.saveRedeemedCode(code.code);
				claimed.push(code.code);
			}
			else if (result && result.alreadyUsed) {
				this.saveRedeemedCode(code.code);
				skipped.push(code.code);
			}
			else if (result && result.expired) {
				expired.push(code.code);
			}
			else {
				failed.push(`${code.code} — ${result ? result.message : "Unknown error"}`);
			}
		}

		(buffer || NOTIFICATIONS).push(...formatCodeReport(this.fullName, account, codes.length, claimed, skipped, expired, failed, true));

		console.log(`Completed forced code redemption for ${this.fullName}`);
	}

	async fetchCodes (buffer) {
		// Cache even an empty result: if both sources returned 0 codes (or the
		// fetch failed and the caller already logged an error), there is no
		// point re-hitting the same URLs for every account of this game.
		if (this._codesCache) return this._codesCache;

		const gameParam = this.getGameParam();
		try {
			const { codes, sourceHits } = await fetchCodes(gameParam);
			const hits = Object.entries(sourceHits)
				.map(([k, v]) => `${k}=${v}`).join(", ");
			console.log(`${this.fullName}:fetchCodes`, `${hits} -> ${codes.length} unique`);
			this._codesCache = codes;
			return codes;
		}
		catch (e) {
			console.error(`${this.fullName}:fetchCodes`, `Error: ${e?.message || e}`);
			logNotification("error", this.fullName, `Failed to fetch promo codes: ${e?.message || e}`, buffer);
			this._codesCache = [];
			return [];
		}
	}

	getGameParam () {
		switch (this.name) {
			case "genshin": return "genshin";
			case "starrail": return "starrail";
			case "zenless": return "zenless";
			default: throw new Error(`Unknown game: ${this.name}`);
		}
	}

	async redeemCode (account, code) {
		const url = this.getRedemptionUrl(account, code);
		const options = {
			method: this.name === "starrail" ? "POST" : "GET",
			headers: {
				"User-Agent": this.userAgent,
				Cookie: account.cookie
			}
		};

		try {
			const response = await UrlFetchApp.fetch(url, options);
			const data = JSON.parse(response.getContentText());

			// Check for authentication errors and other failures
			if (data.retcode !== 0) {
				if (data.retcode === -1071) {
					const msg = "cookie expired — grab a fresh one (README step 2)";
					console.error(`Authentication error for code ${code} in ${this.fullName}: ${data.message}`);
					return { success: false, message: msg };
				}
				// Benign outcomes: code already used on this account, or code
				// expired/never valid. Callers report these as skip/warn, never
				// as errors. Retcode values cross-checked against
				// torikushiii/hoyolab-auto (node) and hashblen's GAS version.
				if (REDEEM_RETCODE_ALREADY_USED.includes(data.retcode)) {
					console.log(`Code ${code} already used for ${this.fullName} (retcode ${data.retcode})`);
					return { success: false, alreadyUsed: true, message: data.message || "Already redeemed" };
				}
				if (REDEEM_RETCODE_EXPIRED_OR_INVALID.includes(data.retcode)) {
					console.log(`Code ${code} expired/invalid for ${this.fullName} (retcode ${data.retcode})`);
					return { success: false, expired: true, message: data.message || "Expired or invalid code" };
				}
				console.error(`Code ${code} redemption failed for ${this.fullName}:`, data);
				return { success: false, message: data.message || `retcode ${data.retcode}` };
			}
			console.log(`Code ${code} successfully redeemed for ${this.fullName}:`, data);
			return { success: true, message: data.message || "OK" };
		}
		catch (e) {
			console.error(`Error redeeming code ${code} for ${this.fullName}:`, e);
			return { success: false, message: e?.message || String(e) };
		}
	}

	getRedemptionUrl (account, code) {
		const baseUrl = this.getBaseRedemptionUrl();
		const internalRegion = this.mapToInternalRegion(account.region);
		const params = [
			`t=${Date.now()}`,
			`lang=en`,
			`uid=${account.uid}`,
			`region=${internalRegion}`,
			`cdkey=${code}`
		];

		switch (this.name) {
			case "genshin":
				params.push("sLangKey=en-us", "game_biz=hk4e_global");
				break;
			case "starrail":
				params.push("game_biz=hkrpg_global");
				break;
			case "zenless":
				params.push("game_biz=nap_global");
				break;
		}

		return `${baseUrl}?${params.join("&")}`;
	}

	mapToInternalRegion (region) {
		const regionMappings = {
			genshin: {
				SEA: "os_asia",
				NA: "os_usa",
				EU: "os_euro",
				TW: "os_cht"
			},
			starrail: {
				NA: "prod_official_usa",
				EU: "prod_official_eur",
				SEA: "prod_official_asia",
				TW: "prod_official_cht"
			},
			zenless: {
				TW: "prod_gf_sg",
				SEA: "prod_gf_jp",
				EU: "prod_gf_eu",
				NA: "prod_gf_us"
			}
		};

		const gameMapping = regionMappings[this.name];
		if (!gameMapping) {
			throw new Error(`Unknown game: ${this.name}`);
		}

		const internalRegion = gameMapping[region];
		if (!internalRegion) {
			throw new Error(`Unknown region ${region} for game ${this.name}`);
		}

		return internalRegion;
	}

	getBaseRedemptionUrl () {
		switch (this.name) {
			case "genshin": return "https://sg-hk4e-api.hoyoverse.com/common/apicdkey/api/webExchangeCdkey";
			case "starrail": return "https://sg-hkrpg-api.hoyoverse.com/common/apicdkey/api/webExchangeCdkeyRisk";
			case "zenless": return "https://public-operation-nap.hoyoverse.com/common/apicdkey/api/webExchangeCdkey";
			default: throw new Error(`Unknown game: ${this.name}`);
		}
	}

	getRedeemedCodes () {
		const redeemedCodes = PropertiesService.getScriptProperties().getProperty(`${this.name}_redeemed_codes`);
		return redeemedCodes ? JSON.parse(redeemedCodes) : [];
	}

	saveRedeemedCode (code) {
		const redeemedCodes = this.getRedeemedCodes();
		redeemedCodes.push(code);
		PropertiesService.getScriptProperties().setProperty(`${this.name}_redeemed_codes`, JSON.stringify(redeemedCodes));
	}
}

function checkInGame (gameName) {
	const game = new Game(gameName, config[gameName]);
	// Per-game notification buffer: games run concurrently via Promise.all in
	// checkInAllGames, and writing into one shared array would interleave lines
	// and let a failure-triggered flush steal another game's pending messages.
	const buffer = [];

	return game.checkAndExecute(buffer)
		.then(async (successes) => {
			console.log(`Successful check-ins for ${gameName}:`, successes);

			if (!config.enableCodeRedemption) {
				console.log(`Code redemption is disabled in config for ${gameName}`);
				return { successes, buffer };
			}

			if (gameName === "honkai") {
				return { successes, buffer };
			}

			// If no new sign-ins happened, codes are NOT re-checked (this is
			// documented upstream behaviour). Tell the user so the Discord
			// message doesn't look like we forgot about codes.
			if (successes.length === 0) {
				const hasAccounts = Array.isArray(config[gameName]?.data) && config[gameName].data.length > 0;
				if (hasAccounts) {
					logNotification("info", gameName, "No new check-ins; promo codes not re-checked (run manuallyRedeemCodes() to force)", buffer);
				}
				return { successes, buffer };
			}

			for (const success of successes) {
				await game.redeemCodes(success.account, buffer);
			}

			return { successes, buffer };
		})
		.catch((e) => {
			console.error(`An error occurred during ${gameName} check-in:`, e);
			logNotification("error", gameName, `Unhandled error: ${e?.message || String(e)}`, buffer);
			// Attach the buffer so the caller can still report what this game
			// managed to log before failing, then re-throw.
			e.notificationBuffer = buffer;
			throw e;
		});
}

function checkInAllGames () {
	const games = ["genshin", "honkai", "starrail", "zenless"];

	NOTIFICATIONS.length = 0;

	return Promise.allSettled(games.map(checkInGame))
		.then((results) => {
			// Merge per-game buffers in stable game order (not completion order).
			for (const r of results) {
				if (r.status === "fulfilled") {
					NOTIFICATIONS.push(...r.value.buffer);
				}
				else if (r.reason && Array.isArray(r.reason.notificationBuffer)) {
					NOTIFICATIONS.push(...r.reason.notificationBuffer);
				}
			}

			const failures = results.filter(r => r.status === "rejected");
			if (failures.length > 0) {
				console.error("Error during check-in process:", failures[0].reason);
				flushDiscordNotifications();
				// Re-throw so the Apps Script Executions tab marks this run as
				// FAILED instead of a misleading "Completed".
				throw failures[0].reason;
			}

			console.log("All games checked in successfully");
			flushDiscordNotifications();
			return results.flatMap(r => r.value ? r.value.successes : []);
		});
}

function manuallyRedeemCodes (gameName, forceRedeem = false) {
	NOTIFICATIONS.length = 0;

	if (![
		"genshin", "honkai", "starrail", "zenless"
	].includes(gameName)) {
		logNotification("error", gameName, `Invalid game name. Must be one of: genshin, honkai, starrail, zenless`);
		flushDiscordNotifications();
		return Promise.reject(new Error(`Invalid game name: ${gameName}`));
	}

	if (gameName === "honkai") {
		logNotification("warn", gameName, "Code redemption is not supported for Honkai Impact 3rd");
		flushDiscordNotifications();
		return Promise.resolve({ success: false, message: "Code redemption is not supported for Honkai Impact 3rd" });
	}

	// Check if code redemption is enabled (can be bypassed with forceRedeem)
	if (!config.enableCodeRedemption && !forceRedeem) {
		logNotification("warn", gameName, "Code redemption is disabled in config (use forceRedeem=true to bypass)");
		flushDiscordNotifications();
		return Promise.resolve({ success: false, message: "Code redemption is disabled in config" });
	}

	const game = new Game(gameName, config[gameName]);
	const accounts = config[gameName].data;

	if (accounts.length === 0) {
		logNotification("warn", gameName, "No accounts provided. Cannot redeem codes.");
		flushDiscordNotifications();
		return Promise.resolve({ success: false, message: `No ${gameName} accounts provided` });
	}

	return Promise.all(accounts.map(async (cookieData) => {
		try {
			const ltuid = extractLtuid(cookieData);
			if (!ltuid) {
				logNotification("error", gameName, "Cookie is missing ltuid/ltuid_v2 — grab a fresh cookie (see README step 2)");
				return { success: false, message: `Invalid cookie for ${gameName}: no ltuid` };
			}
			const accountDetails = await game.getAccountDetails(cookieData, ltuid);

			if (!accountDetails) {
				return { success: false, message: `Failed to get account details for ${gameName}` };
			}

			const account = {
				uid: accountDetails.uid,
				nickname: accountDetails.nickname,
				rank: accountDetails.rank,
				region: accountDetails.region,
				cookie: cookieData
			};

			console.log(`Redeeming codes for ${gameName} account: ${account.nickname} (${account.uid})`);

			if (forceRedeem) {
				await game.forceRedeemCodes(account);
				return { success: true, account, message: `Force redeemed all codes for ${account.nickname} (${account.uid})` };
			}
			else {
				await game.redeemCodes(account);
				return { success: true, account, message: `Redeemed new codes for ${account.nickname} (${account.uid})` };
			}
		}
		catch (e) {
			console.error(`Error redeeming codes for ${gameName}:`, e);
			logNotification("error", gameName, `Error: ${e?.message || String(e)}`);
			return { success: false, message: e?.message || String(e) };
		}
	})).finally(() => {
		flushDiscordNotifications();
	});
}

function redeemGenshinCodes (forceRedeem = false) {
	return manuallyRedeemCodes("genshin", forceRedeem);
}

function redeemStarRailCodes (forceRedeem = false) {
	return manuallyRedeemCodes("starrail", forceRedeem);
}

function redeemZenlessCodes (forceRedeem = false) {
	return manuallyRedeemCodes("zenless", forceRedeem);
}
