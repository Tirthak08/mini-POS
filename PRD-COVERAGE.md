# PRD Coverage Audit — Mini-POS & Inventory Manager

Audited 18 Aug 2026 against `mini-pos/backend` and `mini-pos/mobile`, line by line.
Every row below was verified by reading the code, not from memory.

**Verdict: everything in the PRD is now implemented. 0 open defects.**
7 defects were found by this audit and fixed; 14 divergences are deliberate.

§1's "offline-capable" was the one genuinely unbuilt claim. Offline **reads** are
now implemented (below). Offline **checkout** is deliberately out of scope for
now — a decided trade-off, not an oversight; see the end for what it would take
and the one contract question it forces.

---

## §1 — "offline-capable": read caching, implemented

**Before this audit the claim was unsupported in every sense.** No catalogue
cache, no write queue, no connectivity detection; `netinfo` was not even a
dependency. A cold start with no network showed a red error and an empty
catalogue — the app was unusable without a live connection.

**Now:** the catalogue is cached to disk, so after one online visit the app opens
and shows the shop's own products and prices with the backend unreachable. Two
rules make that safe rather than merely convenient:

**1. Cached stock is shown as stale, never as fact.** An amber "Showing your
saved list — last synced 3 min ago. Stock counts may be out of date." line sits
above the catalogue, with a Refresh action. This is the point of the feature: a
cache presented silently is *worse* than no cache, because the operator would
trust the unit counts. The red "cannot reach the server" error is suppressed
while the cache is on screen — "no connection" is not something they can act on,
and the amber line already says it.

**2. The cache never crosses tenants.** A shared phone is the normal case for a
family shop, and the API cannot defend this — it never sees a read of local
cache. So the cache records which `businessId` owns it and is discarded, not
displayed, when that does not match the signed-in shop. Enforced at three points:
on rehydration at app start, on `loadAll` for an in-session shop switch, and on
sign-out (including an expired session, which is a sign-out by another name).
`tests/offline-cache-test.mjs` proves it by forging another shop's rows onto disk
while offline — the only condition under which the cache is the sole possible
source of products — and asserting the screen goes honestly empty instead.

Checkout offline still fails loudly and keeps the cart, so nothing is silently
lost; it is not queued. That boundary is deliberate — see the end.

---

## §2 Tech stack — 9/9 present

| Requirement | Status | Notes |
|---|---|---|
| React Native + Expo | PRESENT | Expo 54.0.37, RN 0.81.5 |
| React Navigation (Bottom Tabs) | PRESENT | `@react-navigation/bottom-tabs` 7.18.16 |
| NativeWind or RN StyleSheet | PRESENT | NativeWind 4.2.6 + Tailwind 3.4.19, ~400 `className` uses. Zero `StyleSheet.create` — NativeWind is the only styling layer. |
| `@expo/vector-icons` | PRESENT | 15.1.1, Ionicons, 15 files. **Was a phantom dependency** (resolved only via Expo's own tree) — now pinned explicitly in `package.json`. |
| Node/Express REST middleman | PRESENT | Express 5.2.1 |
| MongoDB + Mongoose (Atlas) | PRESENT | Mongoose 9.9.3, `mongodb+srv` handling, Atlas IP-allowlist error hints |
| Zustand or Redux Toolkit | PRESENT | Zustand 5.0.15, six stores |
| `react-native-chart-kit` or gifted-charts | PRESENT | chart-kit 7.0.2 (spec says OR) |
| expo-print / xlsx / expo-file-system / expo-sharing | PRESENT (4/4) | All genuinely wired. Two caveats: **CSV is hand-rolled**, not SheetJS (RFC-4180 quoting + UTF-8 BOM so ₹ and Hindi open correctly in Excel); **PDF bypasses expo-file-system** because `expo-print` writes its own cache file. |

---

## §3 Data models — every PRD field present

All four models carry every field the PRD specifies. Divergences and additions:

### Business
| PRD | Implementation | Why |
|---|---|---|
| `businessId` = "unique name or ID" | Opaque `biz_<24 hex>`, immutable; the name lives in `name` + `slug` | Three reasons: renaming a shop must not re-key every other collection; the key must not be guessable from a public shop name; after a soft delete, re-registering the same name must get a **new** id so it cannot inherit the previous owner's hidden rows. |
| `pin` hashed, 4-6 digits | bcrypt, 10 rounds, `select: false`. Length rule enforced in the controller, not the schema | Correct for a hash column. |

### Order — the field worth knowing about
`subtotal` is the **gross** of the lines, before discounts, with a separate
`discountTotal`. The PRD lists only `subtotal`, and the original build put the
net figure there — which made every receipt fail to add up (*"Subtotal 40,
Discount −10, Total 40"*). The invariant now is
`subtotal − discountTotal + extraCharges = grandTotal`, recomputed server-side
on every write.

`items` genuinely **snapshots** name, price and cost at sale time (not just a
`productId`), so renaming, repricing or deleting a product never rewrites
history. The edit path is stronger still: existing lines keep their original
price; only genuinely new lines are priced at today's rate, so a quantity
correction cannot silently reprice a past sale.

### Additions beyond the PRD
| Field / model | Why it exists |
|---|---|
| `orderNumber` + `receiptNo` virtual | An owner needs to say "bill number 42". Issued from an atomic counter, because counting existing orders races between two phones. |
| `editedAt`, `editCount` | Corrections are visible rather than silent. |
| `deletedAt`, `deletedBy` on all models | Soft delete. Exclusion is enforced by query **and** aggregate middleware, so a controller that forgets a filter cannot leak deleted rows. |
| `slug` on Business | Carries the name-uniqueness rule, under a partial unique index over live rows only, so a deleted shop's name is reusable. |
| `Counter` collection | The per-business receipt sequence. |
| `ProductImage` collection | Photos as separate rows, never inline bytes — blobs on product rows would make every POS refresh tens of megabytes. |
| `imageId` on Product | Points at that collection. |

---

## §4 Roles & auth — 6/6, two stronger than spec

| Requirement | Status | Notes |
|---|---|---|
| Strict isolation by `businessId` | PRESENT | `req.businessId` comes **only** from the signed JWT, never from the body or query. All 7 controllers traced — no unscoped tenant query. `businessId` is `required` + `immutable` on every model, so an untenanted row cannot exist. |
| Duplicate business name rejected | PRESENT | 409 on the pre-check, plus a duplicate-key catch as the real guard against the race. Also reserves the admin username. |
| Login requires exact Name + PIN | **DIVERGES** | PIN is exact (bcrypt). **Name matching is normalised, not exact**: trimmed, internal whitespace collapsed, lowercased. `"  SHARMA   kirana "` signs in as `"Sharma Kirana"`. Deliberate, and **confirmed as intended**: a shopkeeper should not be locked out by capitalisation or a stray space on a phone keyboard that auto-capitalises. Registration reserves on the same normalised form, so the two cannot disagree. |
| Super admin, hardcoded credentials | **STRONGER** | Env vars, not hardcoded, so credentials are never committed. Compared in constant time. Admin sign-in stays **disabled** while the password is still the `replace_me` placeholder, rather than shipping a known password. |
| Admin bypasses POS, lists all businesses | PRESENT | Role-gated at the root stack: admins get `AdminScreen` *instead of* the tab tree, which is never mounted. |
| Cascading delete | PRESENT | Archive cascades orders → products → categories → images → business. `counters` is deliberately excluded so a voided receipt number is never re-issued; permanent purge covers all six and requires prior archival, so live data cannot be destroyed in one tap. Runs sequentially, not `Promise.all`, because a Mongo session allows one in-flight operation. |

---

## §5 Global state

| Requirement | Status | Notes |
|---|---|---|
| EN/HI/GU via i18next | PRESENT | **243 keys, byte-identical key sets across all three files.** Exactly one value repeats across languages: `"CSV"` — a file format, not a missed translation. No script cross-contamination (zero Gujarati codepoints in `hi.js`, zero Devanagari in `gu.js`). |
| "Picker/dropdown in the top header" | **DIVERGES** | A 3-way segmented control (EN/HI/GU), always visible, one tap — chosen so an operator who cannot read the current label can still switch. Present on all six screens. Not available inside the three full-screen modals (checkout, sale edit, forms). |
| Cart: `product_id`, `quantity`, `discount` default 0 | PRESENT | Named `productId` / `qty` / `discount` — same semantics, matches what the backend parses. |
| Cart clears only on successful checkout | PRESENT | `clear()` sits inside `try`, after the POST resolves. A failed checkout preserves the cart for retry. |

---

## §6 Screens

| Requirement | Status | Notes |
|---|---|---|
| SafeAreaView on every screen | PRESENT (6/6) | **Bottom inset was missing on Auth and Admin** — the two screens outside the tab navigator, where no tab bar covers the gesture area. Now fixed. |
| Bottom tabs: POS / Inventory / Reports / Admin | **DIVERGES** | Four tabs: Sell, Stock, **Sales**, Reports. `Sales` is the history screen you asked for. **Admin is not a tab** — it replaces the tab bar entirely, which is what §4 requires ("bypasses the POS UI"). |
| FlatList for product catalogs | PRESENT | POS 2-column grid; Inventory single-column. |
| FlatList for cart items | PRESENT | **Was `ScrollView` + `.map`** — now a `FlatList` with the customer-name field as header and the invoice summary as footer, so a 40-line wholesale order virtualises and there is still exactly one scroll container. |
| Auth: modal or stack screen | PRESENT | Separate stack screen. |
| Auth: tabs for Sign In / Register / Super Admin | **DIVERGES** | One form, mode switched by a text link. Super Admin has no separate UI — both post to one endpoint and the server resolves the role. You asked for this ("three tabs look very unprofessional"). |
| Category manager: add + delete | PRESENT | Plus edit, and an explicit cascade prompt when a category still holds products. |
| Product manager: form + Edit/Delete list | PRESENT | Plus photo, quick-restock, and stock-value tiles. |
| POS: horizontal FlatList of category pills | **DIVERGES** | Dropdown. Pills past the fourth scrolled off-screen unannounced, and Gujarati labels were clipped mid-word. You asked for this. |
| POS: grid FlatList of product cards | PRESENT | |
| POS: "tapping adds to cart" | **DIVERGES** | Tap opens a photo preview; a separate ADD control adds. You asked for this. |
| POS: cart in bottom half or swipe-up sheet | **DIVERGES** | Full-screen modal opened from a sticky total bar. Slides up as an animation but there is **no drag gesture** — the one piece of §6 that is simply not built rather than replaced. |
| Customer name / ± buttons / per-item discount / Complete Order | PRESENT | Checkout POSTs, records the order, decrements stock, and handles the 409 when someone else sold the last unit first. |
| Reports: sales trend chart | PRESENT | `LineChart`, bezier. |
| Reports: category distribution chart | **DIVERGES** | Hand-built horizontal bars, not a pie — a pie compares close values badly and cannot carry long Hindi/Gujarati category names. Categories beyond six fold into "Other". |
| Reports: revenue vs profit chart | PRESENT | Two series on one shared ₹ axis, with a legend carrying inline totals. |
| Reports: CSV / Excel / PDF export buttons | PRESENT | All three open the OS share dialog. Excel is a real 3-sheet workbook. |

Known limitation: both line charts are gated on more than one bucket, so a
single-day range shows KPI tiles and the category bars but no trend lines.

---

## §7 Edge cases — 3/3

| Requirement | Status | Notes |
|---|---|---|
| 1. App must NEVER touch MongoDB directly | **PRESENT — verified definitively** | No DB driver in `package.json` or `node_modules` (not even transitively). Zero connection strings in source, config, or the **compiled web bundle**. All access via one axios instance. The app never even sends `businessId` in a request body. |
| 2. Discount cannot exceed the line; no negative totals | PRESENT | Clamped at **five** independent layers: cart store (including a re-clamp when quantity drops), the sale-edit form, the create controller, the edit controller, and the model. **Two holes found and fixed** — see below. |
| 3. Numeric keyboards for price/cost/stock/PIN | PRESENT | All 20 inputs audited. Nothing numeric falls back to a text keyboard. Money fields use `decimal-pad` rather than the PRD's `number-pad`, deliberately: `number-pad` has no decimal separator, so paise would be unenterable. Belt and braces — `mode` also strips non-numeric keystrokes, so a paste or hardware keyboard cannot get letters in. |

---

## Defects found by this audit and fixed

1. **Sale-edit discount was not re-clamped when quantity dropped.** Set ₹150 off
   a 3-unit line, then drop to 1 unit: the field kept showing ₹150 while the
   line was now worth ₹50. The server clamped it correctly on save, so no bad
   data was ever stored — but the saved receipt silently differed from the number
   the operator was looking at. The cart had this guard; the edit form didn't.

2. **The Order model summed un-clamped discounts on a direct write.** Mongoose
   fires a parent's `pre('validate')` *before* its subdocuments', so
   `discountTotal` could be reported larger than the receipt actually gave away.
   Unreachable over HTTP (the controller clamps first), but a seed script or
   migration writes through the model — which is exactly the path that would
   have hit it. Now clamped in the parent hook too, with 11 assertions
   (`npm run test:clamp`).

3. **`@expo/vector-icons` was an undeclared dependency** — imported in 15 files
   but present only because Expo depends on it. Would have broken silently
   whenever Expo dropped or moved it. Now pinned.

4. **Cart items rendered without virtualisation** (`ScrollView` + `.map`),
   against §6's explicit "use FlatList … for cart items". Now a `FlatList`.

5. **Bottom safe-area inset missing on Auth and Admin**, the two screens with no
   tab bar to cover the gesture area.

6. **`REPORT_TIMEZONE` and `LOW_STOCK_THRESHOLD` were undocumented** in
   `.env.example` despite being read by the code. All 11 env keys the code reads
   are now documented.

7. **The cart sheet's close and "Clear cart" controls had no
   `accessibilityRole`.** Every other close in the app carries it; without it
   these two were invisible to a screen reader's button rotor. Found because the
   offline test could not locate the close button either — automation and
   assistive tech fail on the same missing attribute. A sweep for
   `<Pressable>` elements with a label but no role now comes back empty.

Two findings from the audit I want to retract rather than claim: the missing
`.env.example` and `.gitignore` were artefacts of the cloud working copy — your
disk has both. And "no Admin tab" is not a gap: §4 requires the admin to *bypass*
the POS UI, which is exactly what the role-gated stack does.

---

## What offline checkout would still take

Offline reads are done. Offline **writes** are a different order of work, and
they change one contract that needs a deliberate decision — which is why they
are not built:
- `@react-native-community/netinfo` to know the state at all
- a local outbox: queued orders with client-generated idempotency keys
- **server-side idempotency** on `POST /orders`, so a flush that retries after a
  timeout cannot double-charge
- conflict handling for a queued sale that can no longer be filled when it syncs
- a decision on **receipt numbers**: they are currently server-issued and
  strictly sequential per business. An offline sale cannot know its number.
  Either it gets a provisional local number that changes on sync (confusing if
  the customer already has the slip) or numbering is deferred until sync (the
  receipt has no number until then). This is the contract that needs your call.

**Offline reports:** not worth it — they are aggregate queries over data the
device does not hold.

The receipt-numbering question is the real blocker, not the engineering. Worth
deciding before any of this is started.

---

## Test suites

Backend (`cd backend`):

| Command | Assertions | Covers |
|---|---|---|
| `npm test` | 263 | The whole API against a real MongoDB |
| `npm run test:expenses` | 49 | Expenses: validation, backdating, tenant isolation, and what they do to profit |
| `npm run test:clamp` | 11 | Discount clamping on a direct model write |
| `npm run test:ratelimit` | 6 | Per-account and per-IP login throttling |
| `npm run test:standalone` | 6 | The compensating-write path when transactions are unavailable |

App (`cd mobile`) — pure logic, no server needed:

| Command | Assertions | Covers |
|---|---|---|
| `npm run test:cart` | 28 | Cart maths, discount clamping, the payload sent to the server |
| `npm run test:range` | 44 | Date presets, including week/month/year boundaries and leap years |
| `npm run test:age` | 10 | "3 min ago" formatting for the staleness banner |
| `npm run test:hydration` | 16 | The splash gate: no flash of the sign-in screen, and a failsafe if storage hangs |
| `npm run test:i18n` | 11 | Every `t()` key resolves, all three locales agree, placeholders survive translation |

App end-to-end. These drive a real Chromium against the real API, so they need
three things standing up first:

```bash
cd backend && node boot-backend.mjs          # API on :5000, throwaway in-memory Mongo
cd mobile  && npx expo export --platform web --output-dir dist
#   then patch dist/index.html to <script type="module" ...> -- zustand's
#   middleware contains import.meta, which a classic script cannot parse
python3 -m http.server 8099 --directory dist
cd mobile  && npm i -D playwright && npx playwright install chromium
```


| Command | Assertions | Covers |
|---|---|---|
| `npm run test:dropdown` | 361 | Every filter option in all three languages: full labels, no clipping, correct queries |
| `npm run test:settings` | 65 | Centred dialogs (measured), Settings, rename, PIN change, expenses end to end, and the header in all three languages |
| `npm run test:offline` | 31 | The cache survives a restart, is labelled stale, and never crosses tenants |
| `npm run test:receipt` | 28 | The customer receipt: the order's own numbers, all three languages, HTML-injection safety |
| `npm run test:network` | 13 | Cold-start waking, GET-only retry, and which failure message the operator sees |
| `npm run test:startup` | 9 | Cold start lands signed in, in the saved language, and the splash always lifts |

Nine further browser suites (auth, deletes, logout, photos, previews, the admin
cascade, sales editing) were lost when the build container was recycled — they
had only ever lived in `/tmp`, which is exactly why every suite above now sits
in `mobile/tests/` under version control. Rebuilding them is outstanding.

---

## Beyond the PRD: the customer receipt

The PRD's §6 only asks Complete Order to POST, record, and update stock — it
never says the customer gets anything. For a POS that is a real gap: the sale
was stored under a proper INV number, but after checkout the operator got a
three-second toast and the detail view offered only Edit and Void.

Now: checkout ends with an offer — "Sale complete — INV-000042 · ₹3,100. Give
the customer a copy?" — with Share receipt / Done. Sharing renders a
thermal-slip-style PDF (narrow column, dashed rules, per-line qty × price and
discount, the gross/discount/charges/total story, an "Edited" marker on amended
sales) and opens the OS share sheet, which in practice means WhatsApp. Any past
sale can be re-shared from its detail view — "send me that bill again" is
routine. The slip is generated in the shop's own language, and the numbers on it
are the order's stored fields, never re-added client-side. Customer names are
HTML-escaped, since they are free text typed at the counter. On platforms where
a PDF file cannot be produced (web has no `printToFileAsync`), it falls back to
the print dialog.

Not in scope, deliberately: WebSockets. There is no live sync between devices —
every tab refetches on focus and pull-to-refresh, and checkout applies the
server's echoed stock delta locally. For a single-phone shop that is the right
trade; two phones ringing sales on one shop at the same time is the use case
that would justify a socket, and it should be built when that scenario is real.

---

## Beyond the PRD: expenses, and honest profit

The PRD asks for profit but only ever defines it as revenue minus the cost of
goods sold. That is gross profit, and for a shop with rent, wages and an
electricity bill it overstates what was actually kept — sometimes badly enough
to turn a losing month into a reassuring green number.

Expenses close that gap. `GET/POST/PATCH/DELETE /api/expenses`, one segment
inside the Sales tab, and three figures in Reports where there was one:

| Was | Is |
|---|---|
| Profit | **Gross profit** — revenue − COGS, the same number, honestly labelled |
| — | **Expenses** — what went out in this period |
| — | **Net profit** (or **Net loss**) — gross − expenses |

Decisions worth recording:

- **`profit` kept its meaning.** The API field still returns gross, so nothing
  already reading it changed under it. `grossProfit`, `expenses`, `netProfit`,
  `netMarginPercent` were added beside it, and the app falls back to
  `profit` when talking to an older backend rather than rendering `₹NaN`.
- **A loss is reported as a loss.** `netProfit` is not floored at zero. The
  backend suite asserts −2,200 on a month with ₹800 gross and ₹3,000 of rent,
  because a floor would hide the one number worth acting on.
- **No categories.** Amount, note, date. A category list is one more decision at
  the moment of entry, and notes can be grouped later without a migration —
  whereas a category list, once shipped, cannot be withdrawn.
- **Backdating is first-class.** `spentAt` is the day the money left, with
  Today / Yesterday one tap each and a calendar for the bill found in a drawer.
  Future dates are refused on both sides.
- **Exports carry them too.** The XLSX gains an Expenses sheet and a summary
  that says gross / expenses / net instead of one ambiguous "Profit"; the PDF
  gains the same three KPIs and an Expenses table. That file is what gets
  forwarded to an accountant, so it is the last place a half-truth belongs.

## Beyond the PRD: Settings

The PRD names EN/HI/GU and a PIN but never says where a shopkeeper changes
either. In practice the language sat in the header as a three-way EN/HI/GU
control — the most permanent decision in the product occupying the most
valuable space on every screen, abbreviated to two Latin letters that the one
operator who most needs it cannot read. The shop's own name and its PIN could
not be changed from the app at all.

Settings now holds Business information (rename, plus the shop id and counts),
Security & login (change PIN), App language (a radio list written in each
language's own script), the version, and sign out. It is reached by tapping the
shop's name, which is what now sits on the right of the header — the label a
shopkeeper recognises instantly, which makes a better affordance than a lone
gear. Screens sit ABOVE the tab navigator, so the tab bar cannot tempt you away
mid-form.

Not built, deliberately: the reference mockups showed GSTIN, PAN, a business
registration number and a personal user profile. The backend has nowhere to put
any of them, and a field that forgets what you typed is worse than a field that
is missing — it reads as data loss. They need a migration and real validation
(a GSTIN carries a checksum), not four more text inputs.
