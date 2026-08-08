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
let signBodies = []; // POST bodies captured from /sign requests (regression: act_id payload)
let responseMap = {};
let properties = {};
let postedToDiscord = [];
let lockAvailable = true; // LockService stub: false simulates another instance running
let sleepCalls = []; // Utilities.sleep(ms) invocations (429 retry, redeem pacing)
let headerLog = []; // opts.headers from every UrlFetchApp call (device_id assertions)
let uuidCounter = 0;
let discordResponder = null; // optional per-test Discord responder; null = default 204

function makeSandbox () {
	return {
		console,
		JSON, Math, Date, Array, Object, String, Number, Map, Promise, Error, RegExp,
		Utilities: {
			sleep: ms => { sleepCalls.push(ms); },
			getUuid: () => `uuid-${++uuidCounter}`
		},
		LockService: {
			getScriptLock: () => ({
				tryLock: () => lockAvailable,
				releaseLock: () => {}
			})
		},
		PropertiesService: {
			getScriptProperties: () => ({
				getProperty: k => (k in properties ? properties[k] : null),
				getProperties: () => Object.assign({}, properties),
				setProperty: (k, v) => { properties[k] = v; },
				deleteProperty: k => { delete properties[k]; }
			})
		},
		UrlFetchApp: {
			fetch: (url, opts = {}) => {
				fetchLog.push(url);
				if (opts && opts.headers) headerLog.push(opts.headers);
				if (url.includes("/sign") && opts && opts.method === "POST") signBodies.push(opts.payload || "");
				for (const [pattern, responder] of Object.entries(responseMap)) {
					if (url.includes(pattern)) {
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
					postedToDiscord.push(JSON.parse(opts.payload || "{}").content);
					if (typeof discordResponder === "function") return discordResponder(url, opts);
					return { getResponseCode: () => 204, getContentText: () => "" };
				}
				throw new Error("UNSTUBBED URL: " + url);
			}
		}
	};
}

function load (overrides = {}) {
	fetchLog = []; signBodies = []; postedToDiscord = []; sleepCalls = []; headerLog = [];
	uuidCounter = 0; discordResponder = null;
	properties = {}; // fresh script-properties per scenario — tests must not leak state
	// Object-spread would let defaults overwrite same-key overrides; instead
	// build an ordered entries array where overrides always match first.
	const defaults = {
		"getGameRecordCard": RECORD_CARD,
		"/info?act_id": SIGN_INFO_FRESH,
		"/home?act_id": AWARDS,
		"/sign": SIGN_OK,
		"api.ennead.cc": ENNEAD,
		"raw.githubusercontent.com": HUMBAO,
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
	vm.createContext(sandbox);
	const src = fs.readFileSync(__dirname + "/../index.js", "utf8")
		// activate the config for tests
		.replace("enableCodeRedemption: false", "enableCodeRedemption: true")
		.replace(/DISCORD_WEBHOOK = null/, 'DISCORD_WEBHOOK = "https://discord.com/api/webhooks/test"');
	vm.runInContext(src + "\n;this.__api = { checkInAllGames, checkInGame, manuallyRedeemCodes, config, NOTIFICATIONS, extractLtuid, getWebhook, splitMessage, fetchCodes, viewAllRedeemedCodes, resetAllRedeemedCodes, juFufuContextualLines, formatCodeReport, Game, browserHeaders };", sandbox);
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

	// 5. already signed -> skip line; codes NOT auto-redeemed (default)
	await t("already-signed account skips check-in and skips codes by default", async () => {
		const api = load({ "/info?act_id": SIGN_INFO_SIGNED });
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
			config.genshin.data = ["ltuid_v2=1; x=1"];
			Game.prototype.redeemCodes = async function () { throw new Error("redeem boom"); };
			checkInAllGames();
		`;
		const vm2 = require("vm");
		const fs2 = require("fs");
		const sandbox = makeSandbox();
		vm2.createContext(sandbox);
		let code = fs2.readFileSync(__dirname + "/../index.js", "utf8")
			.replace("enableCodeRedemption: false", "enableCodeRedemption: true")
			.replace(/DISCORD_WEBHOOK = null/, 'DISCORD_WEBHOOK = "https://discord.com/api/webhooks/test"');
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

	// 16b. Discord blockquote layout: every report line gets a ">>> " prefix,
	// but the outro (Ju Fufu's sign-off) must sit OUTSIDE the quote block —
	// Discord renders ">>>" until the next blank line, so the sign-off needs a
	// blank line before it or it gets swallowed into the quote.
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
		const reportLines = lines.filter(l => l.startsWith(">>> "));
		assert.ok(reportLines.length > 0, "report lines are quoted");
		// outro is the last non-empty line and is NOT prefixed with ">>> "
		const lastNonEmpty = [...lines].reverse().find(l => l.trim() !== "");
		const outroIdx = lines.lastIndexOf(lastNonEmpty);
		assert.ok(outroIdx > -1, "outro present");
		const lastQuoteIdx = lines.map((l, i) => l.startsWith(">>> ") ? i : -1).filter(i => i > -1).pop();
		assert.strictEqual(outroIdx, lastQuoteIdx + 2, "blank line between last quoted line and outro");
		assert.ok(!lines[outroIdx].startsWith(">>>"), "outro itself is not quoted");
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
		api.config.genshin.data = ["ltuid_v2=111; x=1", "ltuid_v2=222; y=2"];
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
		api.config.maxExecutionTimeMs = 0; // already over budget -> stop before any redeem
		api.config.genshin.data = [COOKIE];
		await api.manuallyRedeemCodes("genshin", false);
		const cdkeyHits = fetchLog.filter(u => u.includes("webExchangeCdkey")).length;
		assert.strictEqual(cdkeyHits, 0, "no redemption attempted after budget exhausted");
		const msg = postedToDiscord[0];
		assert.ok(msg.includes("Stopping early"), "warning about early stop in report");
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
		properties["WEBHOOK_URL"] = "  https://discord.com/api/webhooks/trimmed  ";
		assert.strictEqual(api.getWebhook(), "https://discord.com/api/webhooks/trimmed", "whitespace removed");
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

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
