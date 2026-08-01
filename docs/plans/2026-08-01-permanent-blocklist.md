# Permanent Blocklist for Region/Platform-Locked Codes

**Goal:** Stop re-trying promo codes that HoYoLAB permanently rejects for an account (region-locked, platform-locked) — remember them per account, skip them silently, and report them once with a reason instead of ❌ every run.
**Architecture:** Extend the existing per-account Script Properties pattern (`<game>_redeemed_codes_<uid>`) with a parallel blocklist (`<game>_blocked_codes_<uid>`). Classify redemption failures by the API's message text (regex on `region|platform|eligible|not available|not applicable`), persist them, and filter them out of every future run. `forceRedeemCodes` also respects the blocklist.
**Tech Stack:** Google Apps Script (ES2018+), existing smoke-test harness (`services/google-script/__tests__/smoke-test.js`).

## Global Constraints

- Worktree paths relative to repo root; file: `services/google-script/index.js`.
- Keep the existing per-account key style: `${this.name}_blocked_codes_${uid}`.
- Message-text classification only — do NOT invent retcode numbers (none are documented for region/platform rejects).
- Report shape must stay Discord-safe: one grouped line per account, no per-code flood.
- TDD: failing test → minimal implementation → green → commit per task.
- All commits authored as SkeletonTM, pushed to `main` after tests pass.

---

### Task 1: Classify permanent rejections in `redeemCode()`

**Files:**
- Modify: `services/google-script/index.js` (Game.prototype.redeemCode)
- Test: `services/google-script/__tests__/smoke-test.js`

**Interfaces:**
- Consumes: existing `redeemCode(account, code)` result object.
- Produces: `{ success: false, permanent: true, message }` for region/platform rejects.

- [ ] **Step 1: Write the failing test**
  In smoke-test.js, add a test that stubs the redeem endpoint to return
  `{"retcode": 1, "message": "Your current region is not eligible for the use of this redemption code."}`
  and asserts `result.permanent === true`. Also assert an unrelated message
  (`"Some other error"`) yields `permanent` falsy.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node services/google-script/__tests__/smoke-test.js`
  Expected: FAIL (no `permanent` field yet).

- [ ] **Step 3: Add classification in `redeemCode()`**
  Before the generic `console.error` fallback (after the `REDEEM_RETCODE_BUSY` check), add:
  ```js
  // Permanent rejects: region-locked or platform-locked codes. HoYoLAB
  // returns these for codes that will NEVER redeem on this account (e.g.
  // "Your current region is not eligible...", "This code cannot be
  // redeemed on this platform"). Classified by message text — there are no
  // documented retcodes for these. Persisted per account and skipped in
  // later runs, so they don't spam the report as ❌ every day.
  if (/region|platform|eligible|not available|not applicable/i.test(data.message || "")) {
    console.log(`Code ${code} permanently not eligible for ${this.fullName}: ${data.message}`);
    return { success: false, permanent: true, message: data.message || "Code not eligible for this account" };
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add services/google-script/index.js services/google-script/__tests__/smoke-test.js
  git commit -m "feat: classify region/platform-locked codes as permanent rejects"
  ```

---

### Task 2: Persistence helpers for the blocklist

**Files:**
- Modify: `services/google-script/index.js` (Game class, next to `getRedeemedCodes`/`saveRedeemedCodes`)
- Test: `services/google-script/__tests__/smoke-test.js`

**Interfaces:**
- Consumes: `this.name`, `uid`.
- Produces: `getBlockedCodes(uid) → string[]`, `saveBlockedCodes(codes, uid)`.

- [ ] **Step 1: Write the failing test**
  Test that `getBlockedCodes` reads `zenless_blocked_codes_<uid>` and returns
  a parsed array; `saveBlockedCodes` appends without duplicating.

- [ ] **Step 2: Run test to verify it fails**
  Expected: FAIL (`getBlockedCodes is not a function`).

- [ ] **Step 3: Implement helpers (mirror redeemed-codes helpers)**
  ```js
  getBlockedCodes (uid) {
    const props = PropertiesService.getScriptProperties();
    const uidKey = `${this.name}_blocked_codes_${uid}`;
    const stored = props.getProperty(uidKey);
    if (stored) {
      try { return JSON.parse(stored); }
      catch (e) { /* malformed — fall through */ }
    }
    return [];
  }

  saveBlockedCodes (codes, uid) {
    const props = PropertiesService.getScriptProperties();
    const uidKey = `${this.name}_blocked_codes_${uid}`;
    let blockedCodes = [];
    const existing = props.getProperty(uidKey);
    if (existing) {
      try { blockedCodes = JSON.parse(existing); } catch (e) { blockedCodes = []; }
    }
    for (const code of codes) {
      if (!blockedCodes.includes(code)) blockedCodes.push(code);
    }
    props.setProperty(uidKey, JSON.stringify(blockedCodes));
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add services/google-script/index.js services/google-script/__tests__/smoke-test.js
  git commit -m "feat: add per-account blocked-codes persistence helpers"
  ```

---

### Task 3: Respect the blocklist in `redeemCodes()` (the daily caller)

**Files:**
- Modify: `services/google-script/index.js` (Game.prototype.redeemCodes)
- Test: `services/google-script/__tests__/smoke-test.js`

**Interfaces:**
- Consumes: `getBlockedCodes(uid)`, `saveBlockedCodes(codes, uid)`, `redeemCode` permanent flag.
- Produces: `blocked` (already-blocked codes, silent) and `newBlocked` (just-blocked, reported once) arrays into `formatCodeReport`.

- [ ] **Step 1: Write the failing test**
  Test that a code in `zenless_blocked_codes_<uid>` is NOT attempted (the redeem
  endpoint stub is never hit) and is reported under "not eligible". Also test
  that a newly permanent-rejected code is saved to the blocklist and reported.

- [ ] **Step 2: Run test to verify it fails**
  Expected: FAIL (blocklist not read yet).

- [ ] **Step 3: Implement in `redeemCodes()`**
  - After `const redeemedCodes = this.getRedeemedCodes(account.uid);` add
    `const blockedCodes = this.getBlockedCodes(account.uid);`
  - Add `const blocked = []; const newBlocked = [];` to the outcomes.
  - In the loop, after the `redeemedCodes.includes` check, add:
    ```js
    if (blockedCodes.includes(code.code)) {
      console.log(`Code ${code.code} blocked for ${this.fullName} (permanent reject)`);
      blocked.push(code.code);
      continue;
    }
    ```
  - In the result handling, before the generic `else`, add:
    ```js
    else if (result && result.permanent) {
      newBlocked.push(code.code);
    }
    ```
  - After the loop, next to the `saveRedeemedCodes` call:
    ```js
    if (newBlocked.length > 0) {
      this.saveBlockedCodes(newBlocked, account.uid);
    }
    ```
  - Pass the arrays through:
    `(buffer || NOTIFICATIONS).push(...formatCodeReport(this.fullName, account, codes.length, claimed, skipped, expired, failed, cooldown, blocked, newBlocked));`

- [ ] **Step 4: Update `formatCodeReport` signature and rendering**
  Change signature to
  `function formatCodeReport (gameName, account, total, claimed, skipped, expired, failed, cooldown = [], blocked = [], newBlocked = [], isForce = false)`
  - Render new-blocked once:
    ```js
    if (newBlocked.length > 0) {
      lines.push(`🚫 [${gameName}] ${label}: not eligible for this account — ${newBlocked.join(", ")}`);
    }
    ```
  - Include blocked in the quiet accounting: `const quietCount = skipped.length + expired.length + blocked.length;`
  - Add to the quiet line parts:
    ```js
    if (blocked.length > 0) parts.push(`${blocked.length} not eligible`);
    ```

- [ ] **Step 5: Run full suite**
  Expected: all tests pass.

- [ ] **Step 6: Commit**
  ```bash
  git add services/google-script/index.js services/google-script/__tests__/smoke-test.js
  git commit -m "feat: skip permanently blocked codes in daily redemption, report once"
  ```

---

### Task 4: Respect the blocklist in `forceRedeemCodes()` + reset support

**Files:**
- Modify: `services/google-script/index.js` (`forceRedeemCodes`, `resetAllRedeemedCodes`, `viewAllRedeemedCodes`)
- Test: `services/google-script/__tests__/smoke-test.js`

**Interfaces:**
- Consumes: `getBlockedCodes`, blocklist keys.
- Produces: force run skips blocked codes; `resetAllRedeemedCodes` clears blocked keys; `viewAllRedeemedCodes` shows them.

- [ ] **Step 1: Write the failing test**
  Test that `forceRedeemCodes` skips a blocked code without calling the API;
  that `resetAllRedeemedCodes` deletes `zenless_blocked_codes_<uid>`;
  that `viewAllRedeemedCodes` includes blocked keys.

- [ ] **Step 2: Run test to verify it fails**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - In `forceRedeemCodes` loop, before attempting, add the same
    `if (blockedCodes.includes(code.code)) { blocked.push(code.code); continue; }`
    (declare `blockedCodes = this.getBlockedCodes(account.uid);` at the top).
  - Extend `resetAllRedeemedCodes` key filter from
    `key.includes("redeemed_codes")` to
    `key.includes("redeemed_codes") || key.includes("blocked_codes")`.
  - Extend `viewAllRedeemedCodes` filter the same way (and its log label stays fine).

- [ ] **Step 4: Run full suite**
  Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git add services/google-script/index.js services/google-script/__tests__/smoke-test.js
  git commit -m "feat: respect blocklist in force runs; reset/view include blocked codes"
  ```

---

### Task 5: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the blocklist**
  In the code-redemption section, add a note: codes that the API rejects as
  region-locked or platform-locked ("Your current region is not eligible…",
  "This code cannot be redeemed on this platform") are remembered per account
  in Script Properties (`<game>_blocked_codes_<uid>`) and skipped on later
  runs — they no longer show up as ❌ every day. `resetAllRedeemedCodes()`
  also clears the blocklist.

- [ ] **Step 2: Verify no broken links (regex pass) + commit**
  ```bash
  git add README.md
  git commit -m "docs: document permanent code blocklist"
  ```

---

### Task 6: Final verification & push

- [ ] **Step 1: Full suite**
  Run: `npm test` → Expected: all pass (26+ tests).
- [ ] **Step 2: `git status` clean; push `main`; confirm remote HEAD via GitHub API.**
