// Smoke-test harness: stubs the GAS runtime APIs, loads index.js, and drives
// the main flows end-to-end with canned HTTP responses. Run: node smoke-test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

let passed = 0, failed = 0;
function t (name, fn) {
	return Promise.resolve().then(fn).then(() => { passed++; console.log(`  PASS ${name}`); })
		.catch(e => { failed++; console.log(`  FAIL ${name}: ${e.message}`); });
}

// ---- canned data -----------------------------------------------------------
const COOKIE = "ltuid_v2=12345678; ltoken_v2=abc; other=1";
const BROKEN_COOKIE = "session_id=zzz; no-uid-here=1";

const RECORD_CARD = {
	retcode: 0,
	data: {
		list: [
			{ game_id: 2, game_role_id: "800000001", nickname: "Alice (2)", level: 58, region: "os_euro" },
			{ game_id: 6, game_role_id: "800000002", nickname: "Bob", level: 70, region: "prod_official_usa" },
			{ game_id: 8, game_role_id: "800000003", nickname: "Carol", level: 55, region: "prod_gf_us" },
			{ game_id: 1, game_role_id: "800000004", nickname: "Dave", level: 88, region: "os_usa" }
		]
	}
};
const SIGN_INFO_FRESH = { retcode: 0, data: { total_sign_day: 3, today: "2026-07-30", is_sign: false } };
const SIGN_INFO_SIGNED = { retcode: 0, data: { total_sign_day: 4, today: "2026-07-30", is_sign: true } };
const AWARDS = { retcode: 0, data: { awards: Array.from({ length: 30 }, (_, i) => ({ name: `Reward${i}`, cnt: 20, icon: "" })) } };
const SIGN_OK = { retcode: 0, message: "OK" };
const ENNEAD = { active: [{ code: "TESTCODE1", rewards: ["Primogem ×60"] }] };
const HUMBAO = "TESTCODE2\nTESTCODE1\n\n";
const REDEEM_OK = { retcode: 0, message: "Redeemed" };
const REDEEM_ALREADY = { retcode: -2017, message: "Redemption code has been used already" };
const REDEEM_EXPIRED = { retcode: -2001, message: "Expired redemption code" };

let fetchLog = [];
let fetchOptsLog = []; // { url, mute } per UrlFetchApp call (muteHttpExceptions assertions)
let signBodies = []; // POST bodies captured from /sign requests (regression: act_id payload)
let responseMap = {};
let properties = {};
let propertyReads = {}; // per-key getProperty call counter (device-id caching assertion)
let postedToDiscord = [];
let postedPayloads = []; // full webhook JSON bodies (allowed_mentions assertions)
let clockSkewMs = 0;     // simulated elapsed time for budget tests
let slowUrls = new Set(); // url patterns whose stub burns wall-clock time
let sleepAdvancesClock = false; // Utilities.sleep() consumes the budget in pacing tests
const RealDate = Date;
let consoleLog = []; // every console.* call from index.js, arguments serialized
let lockAvailable = true; // LockService stub: false simulates another instance running
let lockHeld = false; // LockService state: true while a run holds the script lock
let sleepCalls = []; // Utilities.sleep(ms) invocations (429 retry, redeem pacing)
let triggerLog = []; // ScriptApp actions: {action, handler, hour?} (createDailyTrigger assertions)
let headerLog = []; // opts.headers from every UrlFetchApp call (device_id assertions)
let uuidCounter = 0;
let discordResponder = null; // optional per-test Discord responder; null = default 204

// console shim: records every call (serialized) so tests can assert what the
// script writes to the Apps Script execution log, then forwards to the real
// console. Object arguments are JSON-serialized exactly like GAS Cloud Logging
// would persist them — that is what makes a leaked cookie detectable.
function makeConsole () {
	const serialize = args => args.map(a => {
		if (typeof a === "string") return a;
		try { return JSON.stringify(a); } catch (e) { return String(a); }
	}).join(" ");
	const wrap = fn => (...args) => { consoleLog.push(serialize(args)); fn(...args); };
	return {
		log: wrap(console.log),
		info: wrap(console.info),
		warn: wrap(console.warn),
		error: wrap(console.error)
	};
}

function makeSandbox () {
	return {
		console: makeConsole(),
		JSON, Math, Date, Array, Object, String, Number, Map, Promise, Error, RegExp,
		Utilities: {
			sleep: ms => { sleepCalls.push(ms); if (sleepAdvancesClock) clockSkewMs += ms; },
			getUuid: () => `uuid-${++uuidCounter}`
		},
		ScriptApp: {
			newTrigger: (handler) => ({
				timeBased: () => ({
					everyDays: (n) => ({
						atHour: (h) => {
							const entry = { action: "create", handler, hour: h, everyDays: n };
							const builder = {
								// Optional timezone, mirroring ClockTriggerBuilder.inTimezone().
								inTimezone: (tz) => {
									// Stand-in for ClockTriggerBuilder's rejection of an
									// unknown zone (the real API throws at create()).
									if (tz === "Invalid/Zone") throw new Error(`Invalid timezone: ${tz}`);
									entry.timezone = tz; return builder;
								},
								create: () => { triggerLog.push(entry); }
							};
							return builder;
						}
					})
				})
			}),
			getProjectTriggers: () => triggerLog.filter(t => t.action === "create").map((t, i) => ({
				getHandlerFunction: () => t.handler
			})),
			deleteTrigger: (t) => {
				const handler = t.getHandlerFunction();
				// Remove the matching create entry so getProjectTriggers reflects
				// reality (a deleted trigger is gone, not still listed).
				const idx = triggerLog.findIndex(x => x.action === "create" && x.handler === handler);
				if (idx >= 0) triggerLog.splice(idx, 1);
				triggerLog.push({ action: "delete", handler });
			}
		},
		LockService: {
			getScriptLock: () => ({
				// Stateful stub: a held lock stays held until releaseLock() runs,
				// so a missing release in production code really blocks the next
				// run. The previous stateless `tryLock: () => lockAvailable`
				// returned true regardless and could not catch a lock leak.
				tryLock: () => {
					if (!lockAvailable || lockHeld) return false;
					lockHeld = true;
					return true;
				},
				releaseLock: () => { lockHeld = false; }
			})
		},
		PropertiesService: {
			getScriptProperties: () => ({
				getProperty: k => { propertyReads[k] = (propertyReads[k] || 0) + 1; return (k in properties ? properties[k] : null); },
				getProperties: () => Object.assign({}, properties),
				setProperty: (k, v) => { properties[k] = v; },
				deleteProperty: k => { delete properties[k]; }
			})
		},
		UrlFetchApp: {
			fetch: (url, opts = {}) => {
				fetchLog.push(url);
				fetchOptsLog.push({ url, mute: opts.muteHttpExceptions === true, timeoutSeconds: opts.timeoutSeconds });
				if (opts && opts.headers) headerLog.push(opts.headers);
				if (url.includes("/sign") && opts && opts.method === "POST") signBodies.push(opts.payload || "");
				for (const [pattern, responder] of Object.entries(responseMap)) {
					if (url.includes(pattern)) {
						if (slowUrls.has(pattern)) clockSkewMs += 5000; // stalled request
						const body = typeof responder === "function" ? responder(url, opts) : responder;
						// Raw-response stubs (for HTTP-level tests: 429/5xx) return an
						// object with getResponseCode; pass them through untouched.
						if (body && typeof body === "object" && typeof body.getResponseCode === "function") {
							return body;
						}
						return {
							getResponseCode: () => 200,
							getContentText: () => (typeof body === "string" ? body : JSON.stringify(body))
						};
					}
				}
				if (url.includes("discord.com")) {
					if (slowUrls.has("discord.com")) clockSkewMs += 5000; // stalled POST
					postedToDiscord.push(JSON.parse(opts.payload || "{}").content);
					postedPayloads.push(JSON.parse(opts.payload || "{}"));
					if (typeof discordResponder === "function") return discordResponder(url, opts);
					return { getResponseCode: () => 204, getContentText: () => "" };
				}
				throw new Error("UNSTUBBED URL: " + url);
			}
		}
	};
}

function load (overrides = {}) {
	fetchLog = []; fetchOptsLog = []; signBodies = []; postedToDiscord = []; postedPayloads = []; sleepCalls = []; headerLog = [];
	consoleLog = []; lockHeld = false;
	uuidCounter = 0; discordResponder = null;
	properties = {}; propertyReads = {}; triggerLog = []; clockSkewMs = 0; slowUrls = new Set(); sleepAdvancesClock = false; // fresh state per scenario
	// Object-spread would let defaults overwrite same-key overrides; instead
	// build an ordered entries array where overrides always match first.
	const defaults = {
		"getGameRecordCard": RECORD_CARD,
		"/info?act_id": SIGN_INFO_FRESH,
		"/home?act_id": AWARDS,
		"/sign": SIGN_OK,
		"api.ennead.cc": ENNEAD,
		"raw.githubusercontent.com": HUMBAO,
		// seriaati/hoyo-codes answers with an empty list by default so existing
		// scenarios see no extra codes; tests that exercise it override this.
		"hoyo-codes.seria.moe": { codes: [] },
		"webExchangeCdkey": REDEEM_OK,
		"webExchangeCdkeyRisk": REDEEM_OK
	};
	responseMap = Object.assign({}, defaults, overrides); // override VALUES win
	responseMap.__order = [...Object.keys(overrides), ...Object.keys(defaults).filter(k => !(k in overrides))];
	const order = responseMap.__order;
	delete responseMap.__order;
	// Rebuild with overrides inserted first so first-match wins on substring patterns.
	const ordered = {};
	for (const k of order) ordered[k] = responseMap[k];
	responseMap = ordered;
	const sandbox = makeSandbox();
	// Time-warpable Date: budget tests advance clockSkewMs to simulate requests
	// that actually consume their timeout.
	sandbox.__slowSet = slowUrls; // same Set instance the fetch stub reads
	sandbox.Date = Object.assign(
		function (...args) { return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + clockSkewMs); },
		{ now: () => RealDate.now() + clockSkewMs, parse: RealDate.parse, UTC: RealDate.UTC, prototype: RealDate.prototype }
	);
	vm.createContext(sandbox);
	// enableCodeRedemption defaults to true, so tests no longer patch it.
	const src = fs.readFileSync(__dirname + "/../index.js", "utf8")
		.replace(/DISCORD_WEBHOOK = null/, 'DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1234567890/testhook"');
		vm.runInContext(src + "\n;this.__api = { checkInAllGames, checkInGame, manuallyRedeemCodes, createDailyTrigger, config, NOTIFICATIONS, extractLtuid, getWebhook, splitMessage, fetchCodes, viewAllRedeemedCodes, resetAllRedeemedCodes, juFufuContextualLines, formatCodeReport, Game, browserHeaders, getCookies, storeSecretsFromConfig, redactWebhook, parseJson, outOfTimeBudget, writeCookieProperty, readCookieProperty, requestTimeoutSeconds, timeBudgetLeftMs, flushDiscordNotifications, __sleepAdvancesClock: (v) => { sleepAdvancesClock = v; }, __setScriptStart: (ms) => { SCRIPT_START_TIME = ms; }, __slow: (pattern) => __slowSet.add(pattern) };", sandbox);
	return sandbox.__api;
}

(async () => {
	// 1. extractLtuid sanity
	await t("extractLtuid parses ltuid_v2 and classic ltuid, null on garbage", () => {
		const api = load();
		assert.strictEqual(api.extractLtuid(COOKIE), "12345678");
		assert.strictEqual(api.extractLtuid("ltuid=999; x=1"), "999");
		assert.strictEqual(api.extractLtuid(BROKEN_COOKIE), null);
	});

	// 2. happy path: full check-in for all 4 games, codes redeemed
	await t("checkInAllGames: 4 games sign in, codes claimed, single Discord POST", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.starrail.data = [COOKIE];
		api.config.zenless.data = [COOKIE];
		api.config.honkai.data = [COOKIE];
		await api.checkInAllGames();
		assert.strictEqual(postedToDiscord.length, 1, "exactly one webhook POST");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Reward3 x20"), "award line present");
		assert.ok(msg.includes("+2 new — TESTCODE1, TESTCODE2"), "grouped codes line");
		// codes persisted per-account (new scheme: <game>_redeemed_codes_<uid>)
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"]);
		assert.deepStrictEqual(stored.sort(), ["TESTCODE1", "TESTCODE2"]);
	});

	// 3. record-card cache: 4 games, 1 account each -> ONE record-card call per
	// ltuid shared across ALL Game instances (global cache), not one per game.
	await t("getGameRecordCard fetched once per ltuid across games (global cache)", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.starrail.data = [COOKIE];
		api.config.zenless.data = [COOKIE];
		api.config.honkai.data = [COOKIE];
		await api.checkInAllGames();
		const rcCalls = fetchLog.filter(u => u.includes("getGameRecordCard")).length;
		assert.strictEqual(rcCalls, 1, `record-card calls ${rcCalls} == 1 (one per ltuid, shared across games)`);
	});

	// 3b. PropertiesService has a 9KB per-value limit. saveRedeemedCodes appends
	// codes forever; cap the stored array to the last 200 so it can never blow
	// past the limit (old codes are expired anyway).
	await t("saveRedeemedCodes caps stored codes to the last 200", async () => {
		const api = load();
		const game = new api.Game("genshin", { data: [COOKIE] });
		const codes = Array.from({ length: 250 }, (_, i) => `CODE${String(i).padStart(3, "0")}`);
		game.saveRedeemedCodes(codes, "800000001");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.strictEqual(stored.length, 200, "capped to 200");
		assert.strictEqual(stored[0], "CODE050", "oldest kept code is the 51st (index 50)");
		assert.strictEqual(stored[199], "CODE249", "newest code preserved");
	});

	// 3c. getRedemptionUrl is called inside redeemCode's try/catch so an unknown
	// region (mapToInternalRegion throws) fails that one code without killing
	// the whole redemption loop.
	await t("redeemCode with unknown region returns error, does not throw", async () => {
		const api = load();
		const game = new api.Game("genshin", { data: [COOKIE] });
		const result = await game.redeemCode({ cookie: COOKIE, region: "Unknown" }, "TESTCODE1");
		assert.strictEqual(result.success, false, "returns failure object, not throw");
		assert.ok(result.message, "has a message");
	});

	// 3d. getAccountDetails must not throw TypeError when the API returns a
	// success retcode with an empty/missing data payload (server maintenance) —
	// it should fall through to the existing "no account found" error path.
	await t("getAccountDetails with empty data payload gives readable error, no TypeError", async () => {
		const api = load({ "getGameRecordCard": { retcode: 0, data: null } });
		const game = new api.Game("genshin", { data: [COOKIE] });
		await assert.rejects(
			() => game.getAccountDetails(COOKIE, "12345678"),
			/No Genshin Impact account found/,
			"readable error instead of TypeError"
		);
	});

	// 4. broken cookie -> clear error line, no TypeError
	await t("broken cookie produces readable error, run completes", async () => {
		const api = load();
		api.config.genshin.data = [BROKEN_COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("missing ltuid"), "explicit cookie error in report");
	});

	// 5. with redeemCodesEvenIfSignedIn off -> skip line, codes NOT redeemed
	await t("already-signed account with redeemCodesEvenIfSignedIn off skips codes", async () => {
		const api = load({ "/info?act_id": SIGN_INFO_SIGNED });
		api.config.redeemCodesEvenIfSignedIn = false;
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Already signed in today"), "skip line");
		assert.ok(msg.includes("promo codes not re-checked"), "info line");
	});

	// 6. redeemCodesEvenIfSignedIn -> codes redeemed even when signed
	await t("redeemCodesEvenIfSignedIn redeems codes for signed-in accounts", async () => {
		const api = load({ "/info?act_id": SIGN_INFO_SIGNED });
		api.config.redeemCodesEvenIfSignedIn = true;
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("+2 new — TESTCODE1, TESTCODE2"), "grouped claim line despite signed-in");
	});

	// 7. already-used retcode -> skip, saved to properties, no ❌
	await t("retcode -2017 treated as skip + persisted, not error", async () => {
		const api = load({ "webExchangeCdkey": REDEEM_ALREADY });
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("nothing new (2 already redeemed)"), "skip counted in grouped line");
		assert.ok(!msg.split("\n").some(l => l.includes("❌") && l.includes("TESTCODE")), "no error line for codes");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("TESTCODE1"), "code persisted via alreadyUsed path");
	});

	// 8. expired code -> warn, not error
	await t("retcode -2001 treated as warn (expired)", async () => {
		const api = load({ "webExchangeCdkey": REDEEM_EXPIRED });
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("nothing new (2 expired)"), "expired counted in grouped line");
		assert.ok(!msg.includes("❌"), "no error icons");
	});

	// 8b. expired codes (-2001/-2003) are final states — an expired code can
	// never become valid again, so persist it to stop retrying it every run
	// (and stop the ⚠️ spam in reports). Unlike cooldown/busy, which are
	// transient and must NOT be persisted.
	await t("retcode -2001 expired: code persisted as redeemed (never retried)", async () => {
		const api = load({ "webExchangeCdkey": REDEEM_EXPIRED });
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("TESTCODE1") && stored.includes("TESTCODE2"), "expired codes persisted so later runs skip them");
	});

	// 8c. Unknown account region: mapToInternalRegion throws, and without a
	// guard every code in the batch would fail with "Unknown region …" —
	// one error per code. Fail fast: report the region problem once.
	await t("unknown account region reported once, not per-code", async () => {
		const UNKNOWN_REGION_CARD = {
			retcode: 0,
			data: { list: [{ game_id: 2, game_role_id: "800000001", nickname: "Alice", level: 58, region: "os_mars" }] }
		};
		const api = load({
			"getGameRecordCard": UNKNOWN_REGION_CARD,
			"webExchangeCdkey": REDEEM_OK
		});
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const msg = postedToDiscord[0];
		const occurrences = (msg.match(/Unknown region/g) || []).length;
		assert.strictEqual(occurrences, 1, "region reported once, not once per code");
	});

	// 9. force redeem persists codes (regression test for old bug)
	await t("forceRedeemCodes saves claimed codes to PropertiesService", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", true);
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("TESTCODE1") && stored.includes("TESTCODE2"), "both codes saved after force run");
	});

	// 10. one game's sign endpoint dies -> per-account error, run completes
	await t("failing game: sign error reported per-account, run completes", async () => {
		const api = load({
			// NOTE: key order matters — first matching pattern wins in the stub.
			"event/luna/os/sign": () => { throw new Error("network boom"); }
		});
		// Move the specific override before the generic "/sign" by rebuilding:
		// the stub iterates Object.entries in insertion order, and load() puts
		// "/sign" before overrides — so instead of relying on order, match on
		// the absence of the luna path in the generic responder.
		api.config.genshin.data = [COOKIE];
		api.config.starrail.data = [COOKIE];
		await api.checkInAllGames();
		assert.strictEqual(postedToDiscord.length, 1, "report still sent");
		assert.ok(postedToDiscord[0].includes("Sign-in API call failed"), "sign failure reported");
	});

	// 10b. genuinely unhandled error -> run rejects AND flushes
	await t("run-level exception re-throws so Executions marks the run Failed", async () => {
		// Break redeemCodes AFTER the game has produced a buffer: the failure
		// surfaces through checkInGame's .catch, the partial buffer must still
		// be flushed, and the run must reject (Failed in Executions).
		postedToDiscord.length = 0; // this test builds its own sandbox; reset the shared stub
		const src = `
			config.genshin.data = ["ltuid_v2=1; ltoken_v2=abc; x=1"];
			Game.prototype.redeemCodes = async function () { throw new Error("redeem boom"); };
			checkInAllGames();
		`;
		const vm2 = require("vm");
		const fs2 = require("fs");
		const sandbox = makeSandbox();
		vm2.createContext(sandbox);
		let code = fs2.readFileSync(__dirname + "/../index.js", "utf8")
			.replace(/DISCORD_WEBHOOK = null/, 'DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1234567890/testhook"');
		vm2.runInContext(code, sandbox);
		let rejected = false;
		try {
			await vm2.runInContext(src, sandbox);
		} catch (e) { rejected = true; }
		assert.ok(rejected, "checkInAllGames rejects on run-level error");
		assert.strictEqual(postedToDiscord.length, 1, "report still flushed before re-throw");
	});

	// 11. UID stripper keeps short parenthesised numbers in nicknames
	await t("nickname 'Alice (2)' survives UID-stripping", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		assert.ok(postedToDiscord[0].includes("Alice (2)"), "short number kept");
		assert.ok(!postedToDiscord[0].includes("(800000001)"), "UID stripped");
	});

	// 12. grouped code report: many codes collapse into 1-2 lines per account
	await t("10 codes produce a compact grouped report, not 10 lines", async () => {
		const api = load({
			"api.ennead.cc": { active: Array.from({ length: 10 }, (_, i) => ({ code: `CODE${i}` })) },
			"raw.githubusercontent.com": ""
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("+10 new — CODE0, CODE1, CODE2, CODE3, CODE4, CODE5, CODE6, CODE7, CODE8, CODE9"), "one grouped line");
		assert.ok(!msg.includes("Checking 10 promo"), "no verbose per-code info lines");
	});

	// 13. quiet day mood: all signed, no codes -> quiet intro/outro
	await t("quiet day picks the 'quiet' Ju Fufu mood", async () => {
		const api = load({ "/info?act_id": SIGN_INFO_SIGNED });
		api.config.genshin.data = [COOKIE];
		const { mood } = api.juFufuContextualLines(["⏭️ [Genshin Impact] Alice: Already signed in today (total: 4)"]);
		assert.strictEqual(mood, "quiet");
	});

	// 14. codes day beats plain-ok day
	await t("new codes pick the 'codes' mood over plain ok", async () => {
		const api = load();
		const { mood } = api.juFufuContextualLines(["✅ [Genshin Impact] A: Got X", "🎁 [Genshin Impact] A: +2 new — C1, C2"]);
		assert.strictEqual(mood, "codes");
	});

	// 15. errors beat everything
	await t("errors pick the 'errors' mood regardless of codes", async () => {
		const api = load();
		const { mood } = api.juFufuContextualLines(["🎁 [G] A: +1 new — C1", "❌ [G] B: Sign-in API call failed"]);
		assert.strictEqual(mood, "errors");
	});

	// 16. formatCodeReport shapes
	await t("formatCodeReport renders all four outcome shapes", async () => {
		const api = load();
		const acc = { nickname: "Alice", uid: "800000001" };
		const j = (...a) => JSON.stringify(a);
		assert.strictEqual(j(api.formatCodeReport("G", acc, 2, ["A", "B"], [], [], [])),
			j(["🎁 [G] Alice: +2 new — A, B"]));
		assert.strictEqual(j(api.formatCodeReport("G", acc, 3, [], ["A", "B"], ["C"], [])),
			j(["⏭️ [G] Alice: nothing new (2 already redeemed, 1 expired)"]));
		assert.strictEqual(j(api.formatCodeReport("G", acc, 3, ["A"], ["B"], [], ["C (bad)"])),
			j(["🎁 [G] Alice: +1 new — A",
			   "❌ [G] Alice: failed — C (bad)",
			   "⏭️ [G] Alice: rest — 1 already redeemed"]));
		assert.strictEqual(j(api.formatCodeReport("G", acc, 0, [], [], [], [])),
			j(["ℹ️ [G] Alice: no active promo codes right now"]));
	});

	// 16b. Discord blockquote layout: every report line gets a "> " prefix.
	// A single ">" quote is closed by a blank line, so the outro (Ju Fufu's
	// sign-off) stays OUTSIDE the quote block. (">>> " would eat everything
	// to the end of the message, blank line or not.)
	await t("outro is separated from the quoted report by a blank line", async () => {
		const api = load({
			"getGameRecordCard": RECORD_CARD,
			"/info?act_id": SIGN_INFO_FRESH,
			"/home?act_id": AWARDS,
			"/sign": SIGN_OK,
			"api.ennead.cc": ENNEAD,
			"raw.githubusercontent.com": HUMBAO,
			"webExchangeCdkey": REDEEM_OK,
			"webExchangeCdkeyRisk": REDEEM_OK
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		const lines = msg.split("\n");
		const reportLines = lines.filter(l => l.startsWith("> "));
		assert.ok(reportLines.length > 0, "report lines are quoted");
		// outro is the last non-empty line and is NOT prefixed with "> "
		const lastNonEmpty = [...lines].reverse().find(l => l.trim() !== "");
		const outroIdx = lines.lastIndexOf(lastNonEmpty);
		assert.ok(outroIdx > -1, "outro present");
		const lastQuoteIdx = lines.map((l, i) => l.startsWith("> ") ? i : -1).filter(i => i > -1).pop();
		assert.strictEqual(outroIdx, lastQuoteIdx + 2, "blank line between last quoted line and outro");
		assert.ok(!lines[outroIdx].startsWith(">"), "outro itself is not quoted");
	});

	// 16c. Discord webhook errors must be visible in Executions — with
	// muteHttpExceptions:true a 404/429 response is NOT thrown, so the old code
	// silently dropped the message. The fix logs the HTTP code + body.
	await t("discord webhook 404 is logged, not silently dropped", async () => {
		const errLog = [];
		const origErr = console.error;
		console.error = (...a) => errLog.push(a.join(" "));
		try {
			const api = load({
				"discord.com": () => ({ getResponseCode: () => 404, getContentText: () => '{"message":"Unknown Webhook"}' })
			});
			api.config.genshin.data = [COOKIE];
			await api.checkInAllGames();
			assert.ok(errLog.some(l => l.includes("404")), "404 logged to Executions");
		} finally {
			console.error = origErr;
		}
	});

	// 17. two accounts of the same game -> BOTH redeem, keys stored per uid
	await t("2 accounts of one game: both redeem, redeemed stored separately by uid", async () => {
		// getGameRecordCard must return a DIFFERENT game_role_id per ltuid so the
		// per-uid keys are distinct (111 -> 800000001, 222 -> 800000002).
		const api = load({
			"getGameRecordCard": (url) => {
				const m = url.match(/uid=(\d+)/);
				const uid = m ? m[1] : "0";
				return {
					retcode: 0,
					data: {
						list: [{
							game_id: 2,
							game_role_id: uid === "111" ? "800000001" : "800000002",
							nickname: uid === "111" ? "Alice" : "Bob",
							level: 55,
							region: "os_euro"
						}]
					}
				};
			}
		});
		api.config.genshin.data = ["ltuid_v2=111; ltoken_v2=abc; x=1", "ltuid_v2=222; ltoken_v2=abc; y=2"];
		await api.checkInAllGames();
		// Each account must claim the codes independently
		const a = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		const b = JSON.parse(properties["genshin_redeemed_codes_800000002"] || "[]");
		assert.ok(a.includes("TESTCODE1") && a.includes("TESTCODE2"), "account A redeemed both");
		assert.ok(b.includes("TESTCODE1") && b.includes("TESTCODE2"), "account B redeemed both (not skipped by A's list)");
		assert.ok(!properties["genshin_redeemed_codes"], "legacy per-game key not used for multi-account");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("[Genshin Impact] Alice: +2 new"), "Alice claim line");
		assert.ok(msg.includes("[Genshin Impact] Bob: +2 new"), "Bob claim line");
	});

	// 18. retcode -2016 (cooldown) -> NOT persisted, shown as cooldown line
	await t("retcode -2016 cooldown: code not saved as redeemed, reported as cooldown", async () => {
		const api = load({ "webExchangeCdkey": { retcode: -2016, message: "Redemption in cooldown" } });
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.deepStrictEqual(stored, [], "cooldown codes must NOT be persisted");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("2 in cooldown — retried next run"), "cooldown summary line");
	});

	// 19. retcode -100 (cookie invalid) -> processing stops after first code
	await t("retcode -100 cookie invalid: stops redeeming remaining codes", async () => {
		let redemptionCalls = 0;
		const api = load({
			"webExchangeCdkey": () => {
				redemptionCalls++;
				return { retcode: -100, message: "Invalid cookie" };
			}
		});
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		assert.ok(redemptionCalls < 2, `early-stop: only ${redemptionCalls} redemption call(s)`);
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("cookie invalid/expired") && msg.includes("skipping remaining codes"), "early-stop message");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.deepStrictEqual(stored, [], "nothing persisted after cookie failure");
	});

	// 20. legacy per-game key seeds the first per-uid write (migration fix B1)
	await t("legacy redeemed codes seed the first per-uid write", async () => {
		const api = load();
		properties["genshin_redeemed_codes"] = '["OLD1","OLD2"]'; // simulate pre-upgrade state
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("OLD1") && stored.includes("OLD2"), "legacy codes carried into per-uid key");
		assert.ok(stored.includes("TESTCODE1"), "new codes also present");
	});

	// 20a. legacy per-game key must NOT seed EVERY account — only the first
	// post-upgrade run's getRedeemedCodes call (migration flag). Without the
	// flag, account B inherits account A's redeemed list and silently skips
	// codes it never redeemed.
	await t("legacy redeemed codes seed only the first account (migration flag)", async () => {
		const api = load({
			"api.ennead.cc": { active: [{ code: "LEGACY_ACTIVE", rewards: ["Primogem ×60"] }] },
			"getGameRecordCard": (url) => {
				const m = url.match(/uid=(\d+)/);
				const uid = m ? m[1] : "0";
				return {
					retcode: 0,
					data: {
						list: [{
							game_id: 2,
							game_role_id: uid === "111" ? "800000001" : "800000002",
							nickname: uid === "111" ? "Alice" : "Bob",
							level: 55,
							region: "os_euro"
						}]
					}
				};
			}
		});
		properties["genshin_redeemed_codes"] = '["LEGACY_ACTIVE"]'; // still-live code from pre-upgrade state
		api.config.genshin.data = ["ltuid_v2=111; ltoken_v2=abc; x=1", "ltuid_v2=222; ltoken_v2=abc; y=2"];
		await api.manuallyRedeemCodes("genshin", false);
		// The bug: account B inherits A's redeemed list and NEVER attempts the
		// legacy-live code. The fix (migration flag): only the first account is
		// seeded from legacy, so B must hit the cdkey endpoint — while A (who
		// actually redeemed it in the past) correctly does not re-attempt.
		const legacyAttempts = fetchLog.filter(u => u.includes("cdkey=LEGACY_ACTIVE"));
		assert.strictEqual(legacyAttempts.length, 1, `only account B attempts the legacy-live code (got ${legacyAttempts.length})`);
		const b = JSON.parse(properties["genshin_redeemed_codes_800000002"] || "[]");
		assert.ok(b.includes("LEGACY_ACTIVE"), "account B persisted the legacy-live code after redeeming it");
		assert.ok(properties["genshin_legacy_migrated"] === "1", "migration flag recorded");
	});

	// 20b. saveBlockedCodes must cap the list at 200 entries like
	// saveRedeemedCodes does (9KB Script Properties value limit) — otherwise a
	// long-running user eventually hits setProperty throwing.
	await t("saveBlockedCodes caps the blocked list at 200 entries", async () => {
		const api = load();
		const game = new api.Game("genshin", { data: [COOKIE] });
		const many = Array.from({ length: 250 }, (_, i) => `CODE_${i}`);
		await game.saveBlockedCodes(many, "800000001");
		const stored = JSON.parse(properties["genshin_blocked_codes_800000001"] || "[]");
		assert.strictEqual(stored.length, 200, `blocked list capped at 200 (got ${stored.length})`);
		assert.ok(stored[0] === "CODE_50", "keeps the NEWEST entries (slice(-200))");
		assert.ok(stored[199] === "CODE_249", "last entry preserved");
	});

	// 20c. Every Game HTTP call must set muteHttpExceptions:true — otherwise
	// UrlFetchApp throws on 403/429/5xx BEFORE guardResponse runs, and the
	// whole transient/blocked/cookie-expired classification becomes dead code.
	await t("all Game API calls send muteHttpExceptions:true (guardResponse reachable)", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		// getAccountDetails, getSignInfo, getAwardsData, sign, redeemCode
		const game = new api.Game("genshin", { data: [COOKIE] });
		await game.getAccountDetails({}, "12345678");
		await game.getSignInfo(COOKIE);
		await game.getAwardsData(COOKIE);
		await game.sign(COOKIE);
		await game.redeemCode({ cookie: COOKIE, region: "EU", uid: "800000001" }, "TESTCODE1");
		const bad = fetchOptsLog.filter(e => !e.mute);
		assert.strictEqual(bad.length, 0, `every fetch opts muteHttpExceptions (unmuted: ${bad.map(e => e.url.slice(0, 60)).join(", ") || "none"})`);
	});

	// 20d. cdkey must be URL-encoded in the redemption URL — a non-alphanumeric
	// character in a code would otherwise silently corrupt the query string.
	await t("getRedemptionUrl URL-encodes the cdkey parameter", async () => {
		const api = load();
		const game = new api.Game("genshin", { data: [COOKIE] });
		const url = game.getRedemptionUrl({ region: "EU", uid: "800000001" }, "ABC&D=1");
		assert.ok(url.includes("cdkey=ABC%26D%3D1"), `cdkey encoded in URL (got: ${url.slice(url.indexOf("cdkey="))})`);
		assert.ok(!url.includes("cdkey=ABC&D=1"), "raw ampersand must not survive in cdkey");
	});

	// 20e. getWebhook must refuse non-Discord URLs — a typo in WEBHOOK_URL
	// would otherwise POST account nicknames/UIDs to an arbitrary host.
	await t("getWebhook rejects non-Discord webhook URLs", async () => {
		const api = load();
		properties["WEBHOOK_URL"] = "https://example.com/hook/123/abc";
		assert.strictEqual(api.getWebhook(), null, "non-Discord URL refused");
		properties["WEBHOOK_URL"] = "https://discord.com/api/webhooks/1234567890/abcdef";
		assert.strictEqual(api.getWebhook(), "https://discord.com/api/webhooks/1234567890/abcdef", "valid Discord webhook accepted");
		properties["WEBHOOK_URL"] = "https://canary.discord.com/api/webhooks/1/xyz";
		assert.strictEqual(api.getWebhook(), "https://canary.discord.com/api/webhooks/1/xyz", "canary subdomain accepted");
		// Thread webhooks carry ?thread_id=… — must not be rejected by validation.
		properties["WEBHOOK_URL"] = "https://discord.com/api/webhooks/1234567890/abcdef?thread_id=123456";
		assert.strictEqual(api.getWebhook(), "https://discord.com/api/webhooks/1234567890/abcdef?thread_id=123456", "thread webhook with query accepted");
		// …but a query string can't smuggle a different host in front of the path.
		properties["WEBHOOK_URL"] = "https://discord.com/api/webhooks/1234567890/abcdef?x=1&redirect=https://evil.example";
		assert.strictEqual(api.getWebhook(), "https://discord.com/api/webhooks/1234567890/abcdef?x=1&redirect=https://evil.example", "query params keep the validated host");
		delete properties["WEBHOOK_URL"];
		// No stored property -> falls back to the inline DISCORD_WEBHOOK constant
		// (the harness replaces it with a valid URL), so getWebhook must return
		// that valid value — not null and not a rejected URL.
		assert.strictEqual(api.getWebhook(), "https://discord.com/api/webhooks/1234567890/testhook", "falls back to valid inline webhook");
	});

	// 20f. device-id must be cached per run — browserHeaders is called on every
	// HTTP request, and each PropertiesService read is a slow round-trip.
	await t("device id read from Properties only once per run (cached)", () => {
		const api = load();
		api.browserHeaders(COOKIE);
		api.browserHeaders(COOKIE);
		api.browserHeaders(COOKIE);
		api.browserHeaders(COOKIE);
		api.browserHeaders(COOKIE);
		const reads = propertyReads["DEVICE_ID_12345678"] || 0;
		assert.strictEqual(reads, 1, `DEVICE_ID_<ltuid> fetched once (got ${reads})`);
	});

	// 20g. browserHeaders must not send empty custom headers — Honkai returns
	// "" from getSignGameHeader(), and an empty x-rpc-signgame header is junk
	// that some HoYoLAB endpoints reject.
	await t("browserHeaders drops empty custom headers (honkai signgame)", () => {
		const api = load();
		const headers = api.browserHeaders(COOKIE, { "x-rpc-signgame": "" }, { withReferer: true });
		assert.ok(!("x-rpc-signgame" in headers), "empty x-rpc-signgame not sent");
		assert.ok("x-rpc-device_id" in headers, "other headers unaffected");
		const headers2 = api.browserHeaders(COOKIE, { "x-rpc-signgame": "hk4e_global" }, { withReferer: true });
		assert.strictEqual(headers2["x-rpc-signgame"], "hk4e_global", "non-empty value still sent");
	});

	// 20h. Cookie with ltuid but NO ltoken fails later with a confusing retcode
	// — warn early, like the existing "missing ltuid" check.
	await t("cookie without ltoken is flagged early, run completes", async () => {
		const api = load();
		api.config.genshin.data = ["ltuid_v2=12345678; cookie_token=abc"];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("ltoken"), `explicit ltoken warning in report (got: ${msg.slice(0, 200)})`);
		assert.ok(!msg.includes("Unexpected error"), "no generic catch-all error");
	});

	// 21. retcode -1048 (busy) -> treated as cooldown, not persisted, no ❌
	await t("retcode -1048 busy: treated as retry-later, not error", async () => {
		const api = load({ "webExchangeCdkey": { retcode: -1048, message: "API busy" } });
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.deepStrictEqual(stored, [], "busy codes must NOT be persisted");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("in cooldown — retried next run"), "busy folded into cooldown line");
		assert.ok(!msg.includes("❌"), "no error lines for busy retcodes");
	});

	// 22. is_risk as boolean true (HoYoLAB returns true/false, not 1) -> risk path
	await t("is_risk boolean true triggers risk/captcha block (sign + redeem)", async () => {
		const api = load({
			"/sign": { retcode: 0, message: "OK", data: { gt_result: { is_risk: true } } },
			"webExchangeCdkey": { retcode: 0, message: "OK", data: { gt_result: { is_risk: true } } }
		});
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false); // exercises redeemCode is_risk path
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("CAPTCHA") || msg.includes("risk"), "captcha/risk message reported");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.deepStrictEqual(stored, [], "nothing persisted when risk-blocked");
	});

	// 22b. sign() must send act_id in the POST body (regression for "Parameter
	// error" -1005 / -400005 when the payload was dropped in the header refactor).
	await t("sign sends act_id in POST body", async () => {
		const api = load({ "/sign": { retcode: 0, message: "OK" } });
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		assert.ok(signBodies.length > 0, "sign POST body captured");
		const parsed = JSON.parse(signBodies[0] || "{}");
		assert.strictEqual(parsed.act_id, "e202102251931481", "act_id present in sign POST body");
	});

	// 23. HTTP 500/429 before JSON.parse -> transient warn, not "Cannot parse JSON"
	await t("HTTP 500 on sign/redeem: warns server-unavailable, no JSON parse error", async () => {
		// stub UrlFetchApp to return a non-JSON body with 500 for /sign
		const api = load({
			"event/sol/sign": (url, opts) => {
				return { getResponseCode: () => 500, getContentText: () => "<html>error page</html>" };
			}
		});
		// override the generic "/sign" matcher too — the loader matches first entry
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("server unavailable"), "sign 500 reported as server-unavailable");
		assert.ok(!msg.includes("Cannot parse JSON"), "no JSON parse error");
	});

	// 24. HTTP 429 on redeem -> early stop with warn, nothing persisted
	await t("HTTP 429 on redeem: stops, warns, persists nothing", async () => {
		const api = load({
			"webExchangeCdkey": (url, opts) => {
				return { getResponseCode: () => 429, getContentText: () => "rate limited" };
			}
		});
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("server unavailable") && msg.includes("skipping remaining codes"), "429 early-stop message");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.deepStrictEqual(stored, [], "nothing persisted on 429");
	});

	// 25. permanent classification: region/platform-locked messages
	await t("redeemCode classifies region-locked message as permanent", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: 1, message: "Your current region is not eligible for the use of this redemption code." }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.permanent, true, "permanent flag set for region reject");
	});
	await t("redeemCode leaves unrelated errors non-permanent", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: 1, message: "Something unexpected happened" }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.permanent, undefined, "no permanent flag for generic error");
	});

	// 25b. tight permanent classification (regression for over-broad regex)
	await t("redeemCode blocks 'not available in your region' as permanent", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: 1, message: "This code is not available in your region" }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.permanent, true, "region+not available (word order 2) is permanent");
	});
	await t("redeemCode blocks platform-locked message as permanent", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: 1, message: "This code cannot be redeemed on this platform" }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.permanent, true, "platform reject is permanent");
	});
	await t("redeemCode does NOT block transient 'not available yet' wording", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: 1, message: "The code is not available yet, please try again later" }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.permanent, undefined, "'not yet'/'try again' must not block");
	});
	await t("redeemCode does NOT block transient 'temporarily unavailable' wording", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: 1, message: "Service temporarily unavailable, try again later" }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.permanent, undefined, "'temporar'/'try again' must not block");
	});

	// 26. blocklist persistence helpers
	await t("getBlockedCodes/saveBlockedCodes persist per-uid blocklist", async () => {
		const api = load();
		const game = new api.Game("zenless", { data: [COOKIE] });
		// NOTE: getBlockedCodes returns arrays from the VM sandbox realm; compare
		// via JSON.stringify instead of deepStrictEqual (prototype mismatch).
		assert.strictEqual(JSON.stringify(game.getBlockedCodes("800000003")), "[]", "empty blocklist initially");
		game.saveBlockedCodes(["CBW0884678"], "800000003");
		game.saveBlockedCodes(["CBW0884678", "ZZZ4PC"], "800000003");
		assert.strictEqual(JSON.stringify(game.getBlockedCodes("800000003")), '["CBW0884678","ZZZ4PC"]', "saved without dup");
		assert.ok(!("zenless_blocked_codes_999" in properties), "no cross-account leak");
	});

	// 27. blocklist respected in daily redeem run
	await t("blocked code skipped without API call; permanent reject saved + reported once", async () => {
		const api = load({
			"api.ennead.cc": { active: [
				{ code: "BLOCKED1", rewards: ["x"] },
				{ code: "NEWBAD1", rewards: ["y"] }
			] },
			"raw.githubusercontent.com": "",
			"webExchangeCdkey": { retcode: 1, message: "Your current region is not eligible for the use of this redemption code." }
		});
		properties["genshin_blocked_codes_800000001"] = JSON.stringify(["BLOCKED1"]);
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const cdkeyHits = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		assert.strictEqual(cdkeyHits, 1, "only the new code hits the API — blocked one is skipped");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("not eligible for this account"), "new permanent reject reported once");
		assert.ok(msg.includes("NEWBAD1"), "rejected code named");
		assert.ok(!msg.includes("❌"), "no ❌ line for region-locked code");
		const blocked = JSON.parse(properties["genshin_blocked_codes_800000001"] || "[]");
		assert.strictEqual(JSON.stringify(blocked), '["BLOCKED1","NEWBAD1"]', "new reject persisted to blocklist");
	});

	// 28. force run respects blocklist; reset/view include blocked keys
	await t("forceRedeemCodes skips blocked codes; reset clears them; view lists them", async () => {
		const api = load({
			"api.ennead.cc": { active: [{ code: "BLOCKED1", rewards: ["x"] }, { code: "OKCODE1", rewards: ["y"] }] },
			"raw.githubusercontent.com": ""
		});
		properties["genshin_blocked_codes_800000001"] = JSON.stringify(["BLOCKED1"]);
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", true); // force run
		const cdkeyHits = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		assert.strictEqual(cdkeyHits, 1, "force run skips blocked code too");
		// view shows blocked keys
		let viewed = api.viewAllRedeemedCodes();
		assert.ok(JSON.stringify(viewed).includes("blocked_codes"), "viewAllRedeemedCodes lists blocked keys");
		// reset clears both redeemed and blocked
		api.resetAllRedeemedCodes();
		assert.ok(!("genshin_blocked_codes_800000001" in properties), "reset removes blocked key");
		assert.ok(!("genshin_redeemed_codes_800000001" in properties), "reset removes redeemed key");
	});

	// 29. LockService: concurrent run must be skipped, no duplicate report
	await t("checkInAllGames skipped when another instance holds the script lock", async () => {
		lockAvailable = false;
		try {
			const api = load();
			api.config.genshin.data = [COOKIE];
			api.config.starrail.data = [COOKIE];
			await api.checkInAllGames();
			assert.strictEqual(postedToDiscord.length, 0, "no Discord report from the skipped run");
			assert.strictEqual(fetchLog.length, 0, "no API calls from the skipped run");
		}
		finally {
			lockAvailable = true;
		}
	});

	// 30. LockService: manual redeem also skips
	await t("manuallyRedeemCodes skipped when another instance holds the script lock", async () => {
		lockAvailable = false;
		try {
			const api = load();
			api.config.genshin.data = [COOKIE];
			await api.manuallyRedeemCodes("genshin", false);
			assert.strictEqual(postedToDiscord.length, 0, "no Discord report from the skipped run");
			assert.strictEqual(fetchLog.length, 0, "no API calls from the skipped run");
		}
		finally {
			lockAvailable = true;
		}
	});

	// 31. expired cookie during sign -> actionable message, not generic failure
	await t("sign retcode -100 reports 'Cookie expired' instead of generic failure", async () => {
		const api = load({ "/sign": { retcode: -100, message: "Login status is invalid" } });
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Cookie expired"), "explicit cookie-expired message in report");
		assert.ok(!msg.includes("Sign-in API call failed"), "no generic failure line");
	});

	// 32. expired cookie during getSignInfo -> actionable message
	await t("getSignInfo retcode -100 reports 'Cookie expired' instead of generic failure", async () => {
		const api = load({ "/info?act_id": { retcode: -100, message: "Login status is invalid" } });
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Cookie expired"), "explicit cookie-expired message in report");
		assert.ok(!msg.includes("Failed to get sign info"), "no generic failure line");
	});

	// 33. GAS 6-minute limit guard: redemption loop stops early with a warning
	await t("redeemCodes stops early when maxExecutionTimeMs is exceeded", async () => {
		const api = load();
		api.config.maxExecutionTimeMs = 61500; // inside the 60s reserve -> stop before any redeem
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const cdkeyHits = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		assert.strictEqual(cdkeyHits, 0, "no redemption attempted after budget exhausted");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Stopping early"), "warning about early stop in report");
	});

	// 33a. The same 6-minute guard must also apply to the account loop in
	// checkAndExecute — many accounts × slow sign-in can blow the budget
	// BEFORE the redemption loop ever starts.
	await t("checkAndExecute stops account loop when maxExecutionTimeMs is exceeded", async () => {
		const api = load();
		api.config.maxExecutionTimeMs = 61500; // inside the 60s reserve
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const signHits = fetchLog.filter(u => u.includes("/sign") || u.includes("/info?")).length;
		assert.strictEqual(signHits, 0, "no sign-in request after budget exhausted");
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("Stopping early"), "warning about early stop in report");
	});

	// 33b. createDailyTrigger deletes stale checkInAllGames triggers and
	// installs one daily trigger at the requested hour.
	await t("createDailyTrigger replaces old triggers with a daily 8am trigger", () => {
		const api = load();
		// Simulate a pre-existing stale trigger (e.g. from an earlier manual
		// setup): the helper must remove it, not stack a duplicate.
		triggerLog.push({ action: "create", handler: "checkInAllGames", hour: 9, everyDays: 1 });
		api.createDailyTrigger(8);
		const creates = triggerLog.filter(t => t.action === "create");
		const deletes = triggerLog.filter(t => t.action === "delete");
		const daily = creates.filter(t => t.handler === "checkInAllGames");
		assert.strictEqual(daily.length, 1, "exactly one checkInAllGames trigger created");
		assert.strictEqual(daily[0].hour, 8, "trigger created at requested hour");
		assert.strictEqual(daily[0].everyDays, 1, "trigger repeats every day");
		assert.ok(deletes.length >= 1, "stale triggers removed");
	});

	// 33c. createDailyTrigger must fail fast on an invalid hour — a bad value
	// would otherwise blow up inside ScriptApp.atHour() with an opaque error
	// and leave the caller without a working trigger.
	await t("createDailyTrigger rejects hour outside 0-23", () => {
		const api = load();
		assert.throws(() => api.createDailyTrigger(25), /must be an integer 0-23/, "hour 25 rejected");
		assert.throws(() => api.createDailyTrigger(-1), /must be an integer 0-23/, "hour -1 rejected");
		assert.throws(() => api.createDailyTrigger("8"), /must be an integer 0-23/, "non-integer rejected");
		assert.doesNotThrow(() => api.createDailyTrigger(0), "hour 0 accepted");
		assert.doesNotThrow(() => api.createDailyTrigger(23), "hour 23 accepted");
	});

	// 34. 403 Cloudflare/WAF on redemption -> blocked flag, no JSON.parse crash
	await t("redeemCode 403 returns blocked, does not crash on HTML body", async () => {
		const api = load({
			"webExchangeCdkey": { getResponseCode: () => 403, getContentText: () => "<html><body>Access denied</body></html>" }
		});
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.success, false, "failure result");
		assert.strictEqual(res.blocked, true, "blocked flag set");
		assert.ok(!String(res.message).includes("Unexpected token"), "no JSON.parse garbage in message");
	});

	// 35. 403 on sign endpoint -> readable WAF message in the report
	await t("checkInAllGames 403 on sign reports WAF block, no HTML garbage", async () => {
		const api = load({
			"/sign": { getResponseCode: () => 403, getContentText: () => "<html><body>Access denied</body></html>" }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("WAF"), "WAF/Cloudflare message in report");
		assert.ok(!msg.includes("Unexpected token"), "no HTML parse garbage in report");
	});

	// 36. event-end: total == awards.length must show the LAST reward, not day 1
	await t("award at event end uses last reward, not day-1 fallback", async () => {
		const awards28 = { retcode: 0, data: { awards: Array.from({ length: 28 }, (_, i) => ({ name: `Reward${i}`, cnt: 20, icon: "" })) } };
		const info28 = { retcode: 0, data: { total_sign_day: 28, today: "2026-07-30", is_sign: false } };
		const api = load({ "/home?act_id": awards28, "/info?act_id": info28 });
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Reward27 x20"), "last reward shown");
		assert.ok(!msg.includes("Reward0 x20"), "day-1 reward NOT shown");
	});

	// 37. fixRegion falls back to the original API region instead of "Unknown"
	await t("fixRegion returns original region for unknown servers", async () => {
		const api = load();
		const game = new api.Game("genshin", { data: [COOKIE] });
		assert.strictEqual(game.fixRegion("os_future_region"), "os_future_region", "original region preserved");
		assert.strictEqual(game.fixRegion("os_asia"), "SEA", "known region still mapped");
	});

	// 38. early-return paths release the lock (no leak blocking the next run)
	await t("invalid game name releases the script lock", async () => {
		const api = load();
		await assert.rejects(api.manuallyRedeemCodes("badgame", false));
		// lock must be free again: a real game run proceeds normally
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		assert.ok(postedToDiscord.length >= 1, "subsequent run not blocked by leaked lock");
	});

	// 39. splitMessage: smart split — prefer newline, then space, before hard cut
	await t("splitMessage cuts on last space when no newline near the limit", () => {
		const api = load();
		// Words of varying lengths; limit 30 lands mid-word on a hard cut
		// ("elderberry") but a space exists at 24 — the smart split must prefer it.
		const long = "apple banana cherry date elderberry fig grape honeydew kiwi lemon mango";
		const chunks = api.splitMessage(long, 30);
		assert.ok(chunks.length >= 2, "message split");
		assert.strictEqual(long[chunks[0].length], " ", `first chunk ends on a space boundary, not mid-word (got: ${JSON.stringify(chunks[0])})`);
		assert.ok(chunks.every(c => c.length <= 31), "no chunk exceeds the limit by more than a trailing space");
	});
	await t("splitMessage hard-cuts only when no space exists before the limit", () => {
		const api = load();
		const noSpace = "A".repeat(100);
		const chunks = api.splitMessage(noSpace, 30);
		assert.ok(chunks[0].length <= 30, "hard cut allowed when there is no space");
	});

	// 40. fetchCodes: entries without a code field must be skipped, no undefined key
	await t("fetchCodes skips entries missing the code field", async () => {
		const api = load({
			"api.ennead.cc": { active: [{ rewards: ["Primogem ×60"] }, { code: "GOODCODE", rewards: ["x"] }] },
			"raw.githubusercontent.com": "GOODCODE\n"
		});
		const res = await api.fetchCodes("genshin");
		assert.ok(res.codes.length === 1 && res.codes[0].code === "GOODCODE", "only code-bearing entries kept");
		assert.ok(!res.codes.some(c => c.code === undefined), "no undefined-code entries");
	});

	// 41. humBao parser: lowercase codes accepted
	await t("humBao parses lowercase codes", async () => {
		const api = load({
			"api.ennead.cc": { active: [] },
			"raw.githubusercontent.com": "lowercode1\nuppercase1\n\n"
		});
		const res = await api.fetchCodes("genshin");
		const codes = res.codes.map(c => c.code);
		assert.ok(codes.includes("lowercode1"), "lowercase code kept");
		assert.ok(codes.includes("uppercase1"), "uppercase code kept");
	});

	// 42. getWebhook trims whitespace around the stored URL
	await t("getWebhook trims trailing/leading whitespace", () => {
		const api = load();
		properties["WEBHOOK_URL"] = "  https://discord.com/api/webhooks/1234567890/trimmed  ";
		assert.strictEqual(api.getWebhook(), "https://discord.com/api/webhooks/1234567890/trimmed", "whitespace removed");
	});

	// 43. extractLtuid tolerates spaces around '='
	await t("extractLtuid tolerates spaces around the equals sign", () => {
		const api = load();
		assert.strictEqual(api.extractLtuid("ltuid_v2 = 12345678; x=1"), "12345678", "spaced ltuid_v2");
		assert.strictEqual(api.extractLtuid("ltuid=999 ; x=1"), "999", "trailing space after value");
	});

	// 44. redeemSleepMs clamped to a safe minimum
	await t("redeemSleepMs is clamped to at least 2000ms", async () => {
		const api = load();
		api.config.redeemSleepMs = 100;
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		assert.ok(sleepCalls.length > 0, "redeem loop slept");
		assert.ok(sleepCalls.every(ms => ms >= 2000), `all sleeps >= 2000 (got ${sleepCalls.join(",")})`);
	});

	// 45. Discord 429 -> parse retry_after, sleep, retry once
	await t("Discord 429: sleeps retry_after and retries once", async () => {
		let attempts = 0;
		const api = load(); // load() resets discordResponder — set it AFTER
		discordResponder = () => {
			attempts++;
			if (attempts === 1) return { getResponseCode: () => 429, getContentText: () => JSON.stringify({ retry_after: 0.25 }) };
			return { getResponseCode: () => 204, getContentText: () => "" };
		};
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		assert.strictEqual(attempts, 2, "exactly one retry after the 429");
		assert.ok(sleepCalls.includes(250), "slept retry_after*1000 (250ms)");
		assert.ok(postedToDiscord.length >= 1, "report eventually delivered");
	});

	// 46. x-rpc-device_id: stable per ltuid, persisted in Properties, sent on requests
	await t("browserHeaders sends stable x-rpc-device_id per account", () => {
		const api = load();
		const h1 = api.browserHeaders(COOKIE, {}, { withReferer: true });
		const h2 = api.browserHeaders(COOKIE, {}, { withReferer: true });
		assert.ok(h1["x-rpc-device_id"], "device_id header present");
		assert.strictEqual(h1["x-rpc-device_id"], h2["x-rpc-device_id"], "same device_id for the same cookie");
		assert.ok(properties["DEVICE_ID_12345678"], "device_id persisted in Properties");
	});
	await t("checkInAllGames sends same device_id across requests for one account", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.starrail.data = [COOKIE];
		await api.checkInAllGames();
		const ids = headerLog.filter(h => h["x-rpc-device_id"]).map(h => h["x-rpc-device_id"]);
		assert.ok(ids.length > 0, "requests carried device_id");
		assert.strictEqual(new Set(ids).size, 1, "all requests used the same device_id");
	});

	// 41. Execution logs must never carry the session cookie (issue #2, High):
	// Apps Script persists console output to the Execution log / Cloud Logging,
	// so a cookie in a logged object is a credential leak. Redemption still
	// needs the cookie, so the flow must keep working after redaction.
	await t("check-in logs carry no session cookie while redemption still gets it", async () => {
		const LEAK_COOKIE = "ltuid_v2=12345678; ltoken_v2=LEAKCANARY42; cookie_token_v2=LEAKCANARY42";
		const api = load();
		api.config.genshin.data = [LEAK_COOKIE];
		await api.checkInAllGames();
		const logs = consoleLog.join("\n");
		assert.ok(!logs.includes("LEAKCANARY42"), "cookie token never reaches console.*");
		assert.ok(!/ltoken|ltuid/.test(logs), "no token/uid cookie params in logs");
		assert.ok(logs.includes("Successful check-ins for genshin"), "check-in summary still logged");
		assert.ok(logs.includes("800000001"), "account metadata (uid) still logged");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("TESTCODE1"), "redemption still received the cookie and claimed codes");
	});

	// 42. 403 on the record-card endpoint: guardResponse flags it, but
	// getAccountDetails used to fall through to JSON.parse on an HTML body.
	await t("record-card 403 reports WAF block, no JSON.parse garbage", async () => {
		const api = load({
			"getGameRecordCard": { getResponseCode: () => 403, getContentText: () => "<html><body>Access denied</body></html>" }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("WAF"), "WAF/Cloudflare message in report");
		assert.ok(!msg.includes("Unexpected token"), "no HTML parse garbage in report");
	});

	// 43. 403 on the awards endpoint (same class of bug as the record card).
	await t("awards 403 reports WAF block, no JSON.parse garbage", async () => {
		const api = load({
			"/home?act_id": { getResponseCode: () => 403, getContentText: () => "<html><body>Access denied</body></html>" }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("WAF"), "WAF/Cloudflare message in report");
		assert.ok(!msg.includes("Unexpected token"), "no HTML parse garbage in report");
	});

	// 44. 403 on sign-info: getSignInfo already returned blocked, but the caller
	// ignored it and printed the generic "Failed to get sign info".
	await t("sign-info 403 reports WAF block, not a generic failure", async () => {
		const api = load({
			"/info?act_id": { getResponseCode: () => 403, getContentText: () => "<html><body>Access denied</body></html>" }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("WAF"), "WAF/Cloudflare message in report");
		assert.ok(!msg.includes("Failed to get sign info"), "no opaque generic message");
	});

	// 45. Lock leak detection: the stub is stateful now, so an early return
	// that forgets releaseLock() leaves lockHeld=true and the next run bails.
	await t("lock is released on the early-return and the normal paths", async () => {
		const api = load();
		await assert.rejects(api.manuallyRedeemCodes("badgame", false));
		assert.strictEqual(lockHeld, false, "invalid-game early return released the lock");
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		assert.strictEqual(lockHeld, false, "finally path released the lock");
		await api.checkInAllGames();
		assert.strictEqual(lockHeld, false, "checkInAllGames released the lock");
	});

	// 46. And the stateful stub really blocks: while one run holds the lock a
	// second run must skip instead of double-redeeming.
	await t("a held lock makes the next run skip", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		lockHeld = true; // simulate a run still in flight
		await api.checkInAllGames();
		assert.strictEqual(postedToDiscord.length, 0, "second run skipped, no duplicate report");
		lockHeld = false;
	});

	// 47. -2006 = the code hit its global max-usage limit. Final state, not a
	// retryable failure (upstream 88e731e): retrying it every run spams ❌.
	await t("redeemCode treats -2006 (usage limit) as final exhausted, not a failure", async () => {
		const api = load({ "webExchangeCdkey": { retcode: -2006, message: "Redemption code usage limit reached" } });
		const game = new api.Game("genshin", { data: [COOKIE] });
		const res = await game.redeemCode({ uid: "800000001", region: "EU", cookie: COOKIE }, "TESTCODE1");
		assert.strictEqual(res.success, false, "not a success");
		assert.strictEqual(res.exhausted, true, "classified as exhausted");
		assert.ok(!res.cookieExpired, "usage limit is not an auth problem");
	});

	// 48. ... and it is remembered: reported once, never retried on later runs.
	await t("exhausted code is persisted and not retried next run", async () => {
		const api = load({ "webExchangeCdkey": { retcode: -2006, message: "Redemption code usage limit reached" } });
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(/limit/i.test(msg), "report mentions the usage limit");
		assert.ok(!msg.includes("failed —"), "not reported as a plain failure");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("TESTCODE1"), "exhausted code persisted");
		const before = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		await api.checkInAllGames();
		const after = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		assert.strictEqual(after, before, "no second attempt for the exhausted code");
	});

	// 49. Public entry points must not hand back credentials: an Apps Script
	// API executable returns a function's value in ExecutionResponse.result,
	// and a user logging the result would print the cookie again.
	await t("public entry points return no cookie while redemption still works", async () => {
		const RET_COOKIE = "ltuid_v2=12345678; ltoken_v2=RETLEAK99; cookie_token_v2=RETLEAK99";
		const api = load();
		api.config.genshin.data = [RET_COOKIE];
		const out = JSON.stringify(await api.checkInAllGames());
		assert.ok(!out.includes("RETLEAK99"), "checkInAllGames return carries no token");
		assert.ok(!/"(cookie|ltoken)/.test(out), "no cookie fields in checkInAllGames return");
		assert.ok(out.includes("800000001"), "account metadata still returned");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.ok(stored.includes("TESTCODE1"), "redemption still used the internal cookie");
		const manual = JSON.stringify(await api.manuallyRedeemCodes("genshin", false));
		assert.ok(!manual.includes("RETLEAK99"), "manuallyRedeemCodes return carries no token");
		assert.ok(!/"(cookie|ltoken)/.test(manual), "no cookie fields in manual return");
	});

	// 50. A code-source outage must not be reported as "no active codes".
	await t("all code sources failing is reported as unreachable", async () => {
		const api = load({
			"api.ennead.cc": () => { throw new Error("ennead down"); },
			"raw.githubusercontent.com": () => { throw new Error("hum-bao down"); },
			"hoyo-codes.seria.moe": () => { throw new Error("seriaati down"); }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(/unreachable/i.test(msg), "report says sources are unreachable");
		assert.ok(!/no active promo codes/i.test(msg), "does not claim there are no codes");
	});

	// 51. One source down, the other empty -> the list may be incomplete.
	await t("partial source failure marks an empty code list as incomplete", async () => {
		const api = load({
			"api.ennead.cc": () => { throw new Error("ennead down"); },
			"raw.githubusercontent.com": ""
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(/incomplete/i.test(msg), "incomplete warning present");
		assert.ok(!/unreachable/i.test(msg), "not the all-failed message");
	});

	// 52. One source down, the other returns codes -> still redeem, still warn.
	await t("partial source failure redeems surviving codes and flags the gap", async () => {
		const api = load({
			"api.ennead.cc": () => { throw new Error("ennead down"); }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("TESTCODE2"), "code from the surviving source redeemed");
		assert.ok(/incomplete/i.test(msg), "incomplete warning present");
	});

	// 53. Third source: seriaati/hoyo-codes (Asia-validated JSON API).
	// It must contribute codes the other sources do not have, and its
	// non-OK entries must never be attempted.
	await t("seriaati source contributes new codes and skips non-OK entries", async () => {
		const api = load({
			"api.ennead.cc": { active: [] },
			"raw.githubusercontent.com": "",
			"hoyo-codes.seria.moe": {
				codes: [
					{ code: "SERIAONLY1", status: "OK" },
					{ code: "SERIADEAD1", status: "EXPIRED" }
				]
			}
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("SERIAONLY1"), "new code from the third source redeemed");
		assert.ok(!msg.includes("SERIADEAD1"), "EXPIRED entry never attempted or reported");
		const stored = JSON.parse(properties["genshin_redeemed_codes_800000001"] || "[]");
		assert.deepStrictEqual(stored.sort(), ["SERIAONLY1"], "only the OK code persisted");
	});

	// 54. The third source must not break the happy path when all three agree.
	await t("all three sources together stay deduplicated", async () => {
		const api = load({
			"hoyo-codes.seria.moe": { codes: [{ code: "TESTCODE1", status: "OK" }, { code: "DUPEONLY", status: "OK" }] }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const msg = postedToDiscord[0] || "";
		assert.ok(msg.includes("+3 new"), `three unique codes claimed (got: ${msg.split("\n")[0]})`);
		assert.strictEqual((msg.match(/TESTCODE1/g) || []).length, 1, "TESTCODE1 appears once, not per source");
	});

	// 55. Defaults are part of the contract: redemption and signed-in
	// redemption are ON unless the user turns them off.
	await t("config defaults: both redemption flags default to true", () => {
		const api = load();
		assert.strictEqual(api.config.enableCodeRedemption, true, "enableCodeRedemption defaults to true");
		assert.strictEqual(api.config.redeemCodesEvenIfSignedIn, true, "redeemCodesEvenIfSignedIn defaults to true");
	});

	// 56. Mention safety: webhook payloads parse user mentions by default, and
	// report text carries nicknames/codes from third-party sources. Everything
	// must be suppressed unless it is the configured Discord user on an error.
	await t("webhook payload suppresses mentions coming from report data", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: -1, message: "<@999999999999999999> injected" }
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const payload = postedPayloads[0];
		assert.ok(payload, "webhook payload captured");
		assert.ok(payload.content.includes("<@999999999999999999>"), "text itself is preserved");
		assert.deepStrictEqual(payload.allowed_mentions.parse, [], "no mention parsing enabled");
		assert.ok(!payload.allowed_mentions.users || payload.allowed_mentions.users.length === 0, "no user allowed");
	});

	// 57. The configured id still pings on error chunks, and only there.
	await t("webhook allows only the configured id on error reports", async () => {
		const api = load({
			"webExchangeCdkey": { retcode: -1, message: "boom" }
		});
		properties.DISCORD_ID = "123456789012345678";
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const payload = postedPayloads[0];
		assert.ok(payload.content.startsWith("<@123456789012345678>"), "configured id mentioned on the error chunk");
		assert.deepStrictEqual(payload.allowed_mentions.users, ["123456789012345678"], "only that id is allowed");
		assert.deepStrictEqual(payload.allowed_mentions.parse, [], "nothing else is parsed");
	});

	// 56. A non-JSON body can arrive with ANY status: Cloudflare serves its
	// challenge page with 200/401/404 too, and JSON.parse on it used to kill
	// the run with "Unexpected token '<'" instead of a readable outage line.
	await t("non-JSON 200 body is reported as an outage, not a crash", async () => {
		const api = load({
			"getGameRecordCard": () => ({
				getResponseCode: () => 200,
				getContentText: () => "<!DOCTYPE html><title>Just a moment...</title>"
			})
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const text = postedToDiscord.join("\n");
		assert.ok(/non-JSON|unavailable/i.test(text), `report explains the outage: ${text}`);
		assert.ok(!/Unexpected token/.test(text), "raw JSON.parse error never reaches the report");
	});

	// 57. The award list only supplies today's reward name. Losing it must not
	// skip the sign-in itself - that is the one irreversible action of the day.
	await t("awards failure does not cancel the daily sign-in", async () => {
		const api = load({
			"/home?act_id": () => ({ getResponseCode: () => 200, getContentText: () => "<html>nope</html>" })
		});
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		assert.ok(fetchLog.some(u => u.includes("/sign")), "sign-in was still requested");
		const text = postedToDiscord.join("\n");
		assert.ok(/Got Unknown reward/.test(text), `sign-in succeeds with a placeholder reward: ${text}`);
		assert.ok(/awards\) — signing anyway/.test(text), "the outage is still mentioned");
	});

	// 58. A thrown fetch (DNS, socket, timeout) is a transport failure: mark it
	// transient so the loop stops instead of hammering a dead host per code.
	await t("a thrown redeem request stops the remaining codes", async () => {
		const api = load({
			"webExchangeCdkey": () => { throw new Error("DNS error: https://example.invalid/x"); }
		});
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin");
		const hits = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		assert.strictEqual(hits, 1, "only one code attempted after the transport error");
		assert.ok(/unavailable/i.test(postedToDiscord.join("\n")), "report says the server is unavailable");
	});

	// 59. Apps Script caps one property value at 9KB. Five or more full session
	// cookies exceed it, so the write must be chunked, not silently fatal.
	await t("large cookie sets are chunked under the 9KB property limit", async () => {
		const api = load();
		const big = Array.from({ length: 8 }, (_, i) =>
			`ltuid_v2=${1000 + i}; cookie_token_v2=${"a".repeat(1500)}; ltoken_v2=${"b".repeat(600)}`);
		api.config.genshin.data = big;
		api.storeSecretsFromConfig();
		const sizes = Object.values(properties).map(v => String(v).length);
		assert.ok(sizes.every(n => n <= 9000), `every property under 9KB, got ${Math.max(...sizes)}`);
		assert.deepStrictEqual(api.getCookies("genshin"), big, "cookies round-trip intact");
	});

	// 60. UrlFetchApp embeds the requested URL in DNS/address errors, so the
	// webhook token would land in the execution log unless it is stripped.
	await t("webhook token is redacted from logged fetch errors", async () => {
		const api = load();
		const raw = "DNS error: https://discord.com/api/webhooks/1234567890/testhook";
		assert.strictEqual(api.redactWebhook(raw), "DNS error: <webhook>");
		assert.ok(!api.redactWebhook(raw).includes("testhook"));
	});

	// 61. A JSON body with retcode 0 is not a successful redemption when the
	// HTTP status is not 200 - the code must not be persisted as redeemed.
	await t("a non-200 redemption response is never persisted as redeemed", async () => {
		const api = load({
			"webExchangeCdkey": () => ({
				getResponseCode: () => 404,
				getContentText: () => JSON.stringify({ retcode: 0, message: "ok" })
			})
		});
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin");
		const stored = Object.keys(properties)
			.filter(k => k.includes("redeemed_codes"))
			.map(k => properties[k]).join("");
		// Assert on the fixture's real codes, not a substring that never appears
		// in this data set: TESTCODE1/2 are what a wrong success path would store.
		assert.ok(!stored.includes("TESTCODE1") && !stored.includes("TESTCODE2"),
			`neither fixture code is persisted, stored=${stored}`);
		assert.ok(!/🎁/.test(postedToDiscord.join("\n")), "no claim reported");
	});

	// 62. getWebhook() accepts canary./ptb. hosts, so redaction must cover them
	// too - otherwise the token leaks exactly for the URLs it validated.
	await t("webhook redaction covers every accepted host variant", async () => {
		const api = load();
		for (const host of ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]) {
			const text = `DNS error: https://${host}/api/webhooks/1234567890/tok`;
			assert.strictEqual(api.redactWebhook(text), "DNS error: <webhook>", host);
		}
	});

	// 63. Shrinking a large cookie set must not leave orphan chunks behind:
	// they are unreadable but still hold old session credentials.
	await t("replacing a large cookie set removes every stale chunk", async () => {
		const api = load();
		api.config.genshin.data = ["a".repeat(110000)];
		api.storeSecretsFromConfig();
		const before = Object.keys(properties).filter(k => /^COOKIE_genshin_\d+$/.test(k));
		assert.ok(before.length >= 12, `large set produced ${before.length} chunks`);
		api.config.genshin.data = ["ltuid_v2=1; cookie_token_v2=2"];
		api.storeSecretsFromConfig();
		const after = Object.keys(properties).filter(k => /^COOKIE_genshin_\d+$/.test(k)).sort();
		assert.deepStrictEqual(after, ["COOKIE_genshin_1"], "only the current chunk remains");
		assert.deepStrictEqual(api.getCookies("genshin"), ["ltuid_v2=1; cookie_token_v2=2"]);
	});

	// 64. UrlFetchApp waits 360s per request by default, which can swallow the
	// whole execution budget before the Discord report is sent.
	await t("every outbound request carries a bounded timeout", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		await api.checkInAllGames();
		const unbounded = fetchOptsLog.filter(o => typeof o.timeoutSeconds !== "number" || o.timeoutSeconds <= 0 || o.timeoutSeconds > 120);
		assert.deepStrictEqual(unbounded.map(o => o.url), [], "all fetches are bounded");
	});

	// 65. Manual redemption starts every account at once on one Game instance;
	// caching only the finished result let each account re-fetch all sources.
	await t("manual multi-account redemption fetches each source once", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE, "ltuid_v2=87654321; ltoken_v2=abc; other=1"];
		await api.manuallyRedeemCodes("genshin");
		const hits = fetchLog.filter(u => u.includes("api.ennead.cc")).length;
		assert.strictEqual(hits, 1, `ennead fetched ${hits} time(s)`);
	});

	// 66. A run with only warnings is not a calm, fully-successful day.
	await t("warning-only report does not use the quiet mood", async () => {
		const api = load();
		const warned = api.juFufuContextualLines(["⏭️ [Genshin Impact] A: Already signed in today", "⚠️ [Genshin Impact] A: 2 in cooldown — retried next run"]);
		assert.notStrictEqual(warned.mood, "quiet", "warnings are not quiet");
		const skipped = api.juFufuContextualLines(["⏭️ [Genshin Impact] A: Already signed in today"]);
		assert.strictEqual(skipped.mood, "quiet", "pure skips stay quiet");
	});

	// 67. atHour() runs in the project timezone; the helper must be able to set one.
	await t("createDailyTrigger can pin a timezone", async () => {
		const api = load();
		api.createDailyTrigger(6, "Asia/Almaty");
		const created = triggerLog.filter(t => t.action === "create").pop();
		assert.strictEqual(created.hour, 6);
		assert.strictEqual(created.timezone, "Asia/Almaty");
	});

	// 68. The per-request timeout must shrink with the remaining budget instead
	// of staying at 30s when only seconds are left.
	await t("request timeout follows the remaining budget", async () => {
		const api = load();
		assert.strictEqual(api.requestTimeoutSeconds(60000), 30, "plenty of time -> cap");
		assert.strictEqual(api.requestTimeoutSeconds(20000), 17, "20s left -> 17s request");
		assert.strictEqual(api.requestTimeoutSeconds(5000), 2, "5s left -> 2s request");
		assert.strictEqual(api.requestTimeoutSeconds(1000), 1, "never below 1s");
	});

	// 69. With the budget nearly gone the run must stop before fetching sources
	// and still have room to post the report.
	await t("a nearly exhausted budget still leaves room to flush", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 4000));
		await api.manuallyRedeemCodes("genshin");
		assert.ok(postedToDiscord.length >= 1, "report still flushed");
		assert.ok(!fetchLog.some(u => u.includes("ennead")), "no code source fetched");
		const slow = fetchOptsLog.filter(o => o.timeoutSeconds > 3);
		assert.deepStrictEqual(slow.map(o => o.url), [], "post timeout follows the budget");
	});

	// 70. Creating the trigger before deleting the old one means a bad timezone
	// cannot leave the project without any schedule.
	await t("an invalid trigger timezone leaves the old schedule intact", async () => {
		const api = load();
		api.createDailyTrigger(8);
		assert.strictEqual(triggerLog.filter(t => t.action === "create" && t.handler === "checkInAllGames").length, 1);
		assert.throws(() => api.createDailyTrigger(9, "Invalid/Zone"), /existing triggers were left untouched/);
		const remaining = triggerLog.filter(t => t.action === "create" && t.handler === "checkInAllGames");
		assert.strictEqual(remaining.length, 1, "the original trigger survived");
		assert.strictEqual(remaining[0].hour, 8, "and still points at the original hour");
	});

	// 71. The reserve is not spendable by work: with 61s on the hard clock only
	// 1s of work is allowed, so a slow record-card call must stop the account
	// before sign-info/sign start - and the report still goes out.
	await t("work requests cannot consume the flush reserve", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 61000));
		api.__slow("getGameRecordCard");
		await api.checkInAllGames();
		assert.ok(postedToDiscord.length >= 1, "report still flushed");
		assert.strictEqual(fetchLog.filter(u => u.includes("/info?")).length, 0, "sign-info never started inside the reserve");
		assert.strictEqual(fetchLog.filter(u => u.includes("/sign")).length, 0, "sign never started inside the reserve");
	});

	// 72. A source skipped for budget is not an outage: the report must say it
	// was not checked, never "sources unreachable".
	await t("sources skipped for the budget are not reported as unreachable", async () => {
		const api = load({ "api.ennead.cc": { active: [] } });
		api.config.genshin.data = [COOKIE];
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 62000));
		api.__slow("api.ennead.cc");
		await api.manuallyRedeemCodes("genshin");
		const text = postedToDiscord.join("\n");
		assert.ok(!/unreachable/i.test(text), `no fake outage: ${text}`);
		assert.ok(/not checked|time budget/i.test(text), `budget skip is named: ${text}`);
		assert.strictEqual(fetchLog.filter(u => u.includes("raw.githubusercontent.com")).length, 0, "second source never requested");
	});

	// 73. A 429 retry must size its own timeout from the time left: the first
	// POST may already have burned most of the window it was granted.
	await t("a 429 retry recomputes its timeout from the remaining window", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 20000)); // 20s hard left
		api.__sleepAdvancesClock(true);
		api.__slow("discord.com");
		let calls = 0;
		discordResponder = () => (++calls === 1
			? { getResponseCode: () => 429, getContentText: () => JSON.stringify({ retry_after: 1 }) }
			: { getResponseCode: () => 204, getContentText: () => "" });
		await api.checkInAllGames();
		const posts = fetchOptsLog.filter(o => o.url.includes("discord.com"));
		assert.strictEqual(posts.length, 2, "one POST plus one retry");
		assert.ok(posts[1].timeoutSeconds < posts[0].timeoutSeconds,
			`retry timeout shrinks with the window: ${posts.map(p => p.timeoutSeconds).join(" -> ")}`);
		assert.ok(posts[1].timeoutSeconds * 1000 <= 14000, "retry fits inside what is actually left");
	});

	// 74. A long rate-limit pause must not eat the report reserve: the loop
	// stops with the result of the code it already processed.
	await t("redemption pacing does not sleep into the report reserve", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.maxExecutionTimeMs = 300000;
		api.config.redeemSleepMs = 90000;
		api.__setScriptStart(Date.now() - (300000 - 68000)); // 68s hard -> 8s work
		await api.manuallyRedeemCodes("genshin");
		assert.strictEqual(fetchLog.filter(u => u.includes("webExchangeCdkey")).length, 1, "second code never attempted");
		assert.deepStrictEqual(sleepCalls.filter(ms => ms > 60000), [], "no pacing sleep inside the reserve");
		assert.ok(postedToDiscord.join("\n").includes("Rate-limit pause skipped"), "the stop is reported");
	});

	// 75. When the chunk list cannot fit the flush window, the remainder is
	// condensed into one truncated message instead of 1s POSTs past the limit.
	await t("a report that cannot fit is condensed, not overrun", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		for (let i = 0; i < 60; i++) api.NOTIFICATIONS.push(`line ${i} ${"x".repeat(120)}`);
		api.__setScriptStart(Date.now() - (300000 - 6000)); // 6s window, ~5 chunks needed
		api.flushDiscordNotifications();
		assert.strictEqual(postedToDiscord.length, 1, "exactly one condensed message");
		assert.ok(postedToDiscord[0].includes("report truncated"), "truncation is stated in the message");
	});

	// 76. Discord must never be retried before the interval it asked for: if
	// retry_after does not fit the window, the chunk is dropped.
	await t("a 429 retry waits the full retry_after or is dropped", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 10000)); // 10s hard left
		api.__slow("discord.com");                          // first POST burns 5s
		discordResponder = () => ({ getResponseCode: () => 429, getContentText: () => JSON.stringify({ retry_after: 20 }) });
		await api.checkInAllGames();
		assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 1, "no early retry");
		assert.deepStrictEqual(sleepCalls.filter(ms => ms >= 20000), [], "never sleeps a capped interval and retries early");
	});

	// 77. When the requested interval does fit, the full wait is honoured.
	await t("a 429 retry that fits waits the whole interval, uncapped", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 40000)); // 40s hard left
		api.__slow("discord.com");
		let calls = 0;
		discordResponder = () => (++calls === 1
			? { getResponseCode: () => 429, getContentText: () => JSON.stringify({ retry_after: 20 }) }
			: { getResponseCode: () => 204, getContentText: () => "" });
		await api.checkInAllGames();
		assert.ok(sleepCalls.includes(20000), `full 20s wait, not a 15s cap: ${sleepCalls}`);
		assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 2, "one retry after the wait");
	});

	// 78. A dead webhook (404) must stop the report after one request instead
	// of repeating the same invalid call for every chunk.
	await t("a permanent webhook error stops the remaining chunks", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		for (let i = 0; i < 60; i++) api.NOTIFICATIONS.push(`line ${i} ${"x".repeat(120)}`);
		discordResponder = () => ({ getResponseCode: () => 404, getContentText: () => "Unknown Webhook" });
		api.flushDiscordNotifications();
		assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 1, "exactly one request");
		assert.ok(consoleLog.join("\n").includes("chunk(s) not sent"), "the stop is logged");
	});

	// 79. Below one viable request window nothing is attempted - neither work
	// nor a flush POST.
	await t("a sub-second window starts no request at all", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 1200)); // 1.2s hard left
		await api.checkInAllGames();
		assert.strictEqual(fetchLog.filter(u => u.includes("hoyolab")).length, 0, "no work request");
		assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 0, "no flush POST into a dead window");
	});

	// 80. Work stops a minimum request window before the reserve: with 0.9s of
	// work budget left no HoYoLAB request is started at all.
	await t("work stops before a sub-second request window", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.maxExecutionTimeMs = 300000;
		api.__setScriptStart(Date.now() - (300000 - 60900)); // 900ms of work left
		await api.checkInAllGames();
		assert.strictEqual(fetchLog.filter(u => u.includes("hoyolab")).length, 0, "no work request below the minimum window");
		assert.ok(postedToDiscord.length >= 1, "report still flushed inside the reserve");
	});

	// 81. A 429 with an unparseable body gives no interval to wait for: retrying
	// blind would just earn another 429, so nothing more is sent.
	await t("a 429 without a usable retry_after is not retried blind", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		discordResponder = () => ({ getResponseCode: () => 429, getContentText: () => "<html>rate limited</html>" });
		await api.checkInAllGames();
		assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 1, "no immediate second POST");
		assert.ok(consoleLog.join("\n").includes("without a usable retry_after"), "reason is logged");
	});

	// 82. A second 429 means the bucket is still empty: stop instead of posting
	// the next chunk a second later.
	await t("a second 429 stops the remaining chunks", async () => {
		const api = load();
		properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
		api.config.maxExecutionTimeMs = 300000;
		for (let i = 0; i < 60; i++) api.NOTIFICATIONS.push(`line ${i} ${"x".repeat(120)}`);
		discordResponder = () => ({ getResponseCode: () => 429, getContentText: () => JSON.stringify({ retry_after: 1 }) });
		api.flushDiscordNotifications();
		assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 2, "first POST plus one retry, then stop");
		assert.ok(consoleLog.join("\n").includes("429 again after waiting"), "second 429 is reported");
	});

	// 83. `null`, `false` and `""` are not intervals: Number() would turn them
	// into 0 and retry immediately, so the type is checked instead.
	await t("non-numeric retry_after values are not treated as zero", async () => {
		for (const bad of [null, false, "", "3", {}]) {
			const api = load();
			properties.WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";
			api.config.maxExecutionTimeMs = 300000;
			discordResponder = () => ({ getResponseCode: () => 429, getContentText: () => JSON.stringify({ retry_after: bad }) });
			await api.checkInAllGames();
			assert.strictEqual(fetchOptsLog.filter(o => o.url.includes("discord.com")).length, 1,
				`retry_after ${JSON.stringify(bad)} must not be retried`);
		}
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
