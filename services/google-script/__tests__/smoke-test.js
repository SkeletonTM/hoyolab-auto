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
let responseMap = {};
let properties = {};
let postedToDiscord = [];

function makeSandbox () {
	return {
		console,
		JSON, Math, Date, Array, Object, String, Number, Map, Promise, Error, RegExp,
		Utilities: { sleep: () => {} },
		PropertiesService: {
			getScriptProperties: () => ({
				getProperty: k => (k in properties ? properties[k] : null),
				setProperty: (k, v) => { properties[k] = v; },
				deleteProperty: k => { delete properties[k]; }
			})
		},
		UrlFetchApp: {
			fetch: (url, opts = {}) => {
				fetchLog.push(url);
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
				if (url.includes("discord.com")) { postedToDiscord.push(JSON.parse(opts.payload || "{}").content); return { getResponseCode: () => 204, getContentText: () => "" }; }
				throw new Error("UNSTUBBED URL: " + url);
			}
		}
	};
}

function load (overrides = {}) {
	fetchLog = []; postedToDiscord = [];
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
	vm.runInContext(src + "\n;this.__api = { checkInAllGames, checkInGame, manuallyRedeemCodes, config, NOTIFICATIONS, extractLtuid, viewAllRedeemedCodes, resetAllRedeemedCodes, juFufuContextualLines, formatCodeReport, Game };", sandbox);
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

	// 3. record-card cache: 4 games, 1 account each -> 4 record-card calls, not 4+
	await t("getGameRecordCard fetched once per account (cache works)", async () => {
		const api = load();
		api.config.genshin.data = [COOKIE];
		api.config.starrail.data = [COOKIE];
		api.config.zenless.data = [COOKIE];
		await api.checkInAllGames();
		const rcCalls = fetchLog.filter(u => u.includes("getGameRecordCard")).length;
		// each Game instance has its own cache (per-game object), so 3 games = 3 calls max;
		// the point is: no repeat calls *within* one game's multi-account loop.
		assert.ok(rcCalls <= 3, `record-card calls ${rcCalls} <= 3`);
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

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
