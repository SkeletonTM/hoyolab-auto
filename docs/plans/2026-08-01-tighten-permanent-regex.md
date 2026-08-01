# Tighten permanent-reject classification regex

**Goal:** Replace the over-broad permanent-reject regex in `redeemCode()` (line ~1194) with the reviewed, specific version agreed with the user. Fix the false-positive risk: codes that are *temporarily* unavailable ("not available yet", "temporarily unavailable", "try again") must NOT be permanently blocked.
**Approved fix (user-provided, verified):**
```js
const msg = data.message || "";
const permanentReject = (
  /region.*(not eligible|not applicable|not available)|
   (not eligible|not applicable|not available).*region|
   cannot be redeemed on this platform/i.test(msg)
) && !/temporar|try again|please try|unavailable for now|not yet/i.test(msg);
if (permanentReject) { ... }
```
Rationale: `not available` added to the second alternative so "This code is not available in your region" matches (both word orders); standalone `platform`/`eligible`/`region` words no longer trigger; negative lookahead via explicit exclusion regex.

## Constraints
- TDD: failing tests first, then the one-line regex change.
- Keep tests that already pass (existing region/platform cases must stay green).

---

### Task 1: Failing tests for the tight cases

**Files:** `services/google-script/__tests__/smoke-test.js`

- [ ] **Step 1: Add regression tests** (after test 25 block):
  - `"This code is not available in your region"` → `permanent === true` (the missed word-order case)
  - `"This code cannot be redeemed on this platform"` → `permanent === true` (platform-locked)
  - `"The code is not available yet, please try again later"` → `permanent` undefined (negative: "not yet", "try again")
  - `"Service temporarily unavailable, try again later"` → `permanent` undefined (negative: "temporar", "try again")
  - `"Something unexpected happened"` → `permanent` undefined (already covered, keep)
- [ ] **Step 2: Run — expect FAIL** on the "not available in your region" case (current regex misses it); negatives may also FAIL (current regex catches "not available").

### Task 2: Fix the regex

**Files:** `services/google-script/index.js` (redeemCode, ~line 1194)

- [ ] **Step 1:** Replace the classification block with the approved regex (message bound to `const msg` first; console.log/message use `msg`).
- [ ] **Step 2:** Update the explanatory comment to mention the exclusion list.
- [ ] **Step 3:** `node --check` + full suite → all green (30 + new tests).

### Task 3: Commit & push

- [ ] **Step 1:** `git add index.js smoke-test.js` → commit `fix: tighten permanent-reject regex (region/platform only, exclude transient wording)`.
- [ ] **Step 2:** `npm test` exit 0, `git status` clean, `git push origin main`, confirm remote HEAD via API.
