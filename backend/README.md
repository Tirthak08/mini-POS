# Mini-POS API (backend)

Secure REST middleman between the Expo app and MongoDB Atlas.
The mobile app never holds the connection string — PRD section 7, edge case 1.

Node 22 · Express 5 · Mongoose 9 · JWT · bcrypt

## Setup

```bash
npm install
cp .env.example .env     # then fill in MONGODB_URI, JWT_SECRET, ADMIN_PASSWORD
npm run db:check         # proves Atlas is reachable before touching the server
npm run db:reset         # drops the collections and builds the current indexes
npm run dev
```

`db:reset` asks for confirmation, refuses to run with `NODE_ENV=production`, and
takes `-- --yes` to skip the prompt. **Run it once** after upgrading to the
opaque `businessId` scheme below — the index definitions changed.

`db:check` isolates database problems from server problems, reporting
IP-allow-list and auth failures with a hint for each.

## Tests

```bash
npm test                  # 266 assertions against a real MongoDB replica set
npm run test:expenses     #  49 — expenses, tenant isolation, and profit arithmetic
npm run test:pricing      #  41 — duplicate names, and pricing a sale off-list
npm run test:stock        #  68 — the stock ledger, the physical count, and the backfill
npm run test:backup       #  62 — export, restore, and the ways a backup can lie
npm run test:units        #  51 — fractional quantities, units, and payment methods
npm run test:idem         #  32 — the same sale sent twice is recorded once
npm run test:udhaar       #  67 — credit, repayments, and a balance that cannot drift
npm run test:images       #  22 — an image is really removed when it stops being used
npm run test:clamp        #  11 — discounts can never make a line negative
npm run test:standalone   #   6 — proves the no-transaction fallback path
npm run test:ratelimit    #   6 — proves per-account brute-force protection
```

Each boots a throwaway MongoDB, spawn the real server and drive it over HTTP —
no mocks. The first run downloads a ~220MB mongod binary.

## Identity and tenant isolation

Every row carries the tenant it belongs to, and every tenant route reads that key
**from the signed JWT** — never from the request body or a query param. A client
cannot reach another shop's data by changing a payload field, because no code
path trusts one.

### `businessId` is opaque

```
biz_9f2c1a7b4e08d3516ca9b207
```

Not derived from the shop name, and `immutable` for the life of the business.
That buys three things:

- **the name can be corrected** without re-keying every category, product and order;
- **it cannot be guessed** from a shop's public name;
- **a reused name inherits nothing.** Names are only reserved among *live* shops,
  so a deleted shop's name becomes available again. If the key were the name, the
  next owner of "Sharma Kirana" would silently adopt the previous owner's
  soft-deleted records. With an opaque key they get a fresh one, and the old rows
  stay invisible to them forever.

Name uniqueness lives on a separate `slug` field, enforced by a **partial**
unique index (`partialFilterExpression: { deletedAt: null }`). A plain compound
`{slug, deletedAt}` index was tried first and rejected against a real MongoDB:
two rows deleted in the same millisecond collide under it.

### Everything else is keyed by its `_id`

Categories, products and orders use MongoDB's own `ObjectId` — already unique,
already the link target. Two guards make cross-tenant references impossible
rather than merely unlikely:

- `businessId` is `immutable` on every tenant model, so a row can never be moved
  between shops;
- a `categoryId` supplied when creating a product is verified to belong to the
  caller's own business before it is stored.

Orders additionally carry a per-business sequential **`orderNumber`** (exposed as
`receiptNo`, e.g. `INV-000042`), assigned from an atomic counter inside the
checkout transaction. Two phones checking out at once cannot receive the same
number, and a voided receipt's number is never reissued.

## Soft delete

Nothing is removed by an ordinary delete. Rows get a `deletedAt` timestamp and a
`deletedBy` marker, and disappear from every query.

The guarantee is structural: exclusion is applied by Mongoose **middleware**, not
by remembering a filter at each call site. A controller that forgets cannot leak
deleted rows, because seeing them requires asking explicitly.

```js
Product.find({ businessId })                  // active only
Product.find({ businessId }).withDeleted()    // include deleted
Product.find({ businessId }).onlyDeleted()    // deleted only
Product.aggregate(pipeline)                   // active only
Order.softDeleteOne({ _id, businessId })
Order.restoreMany({ businessId })
```

| Action | Effect |
|---|---|
| Delete a category | Flagged. Refuses while it holds live products; `?force=true` flags those too |
| Delete a product | Flagged. Past order lines keep their snapshot and still resolve |
| Void an order | Flagged, stock returned, receipt retained for audit, number never reused |
| Admin archives a business | Cascading flag across business, categories, products, orders |
| Admin restores a business | Reverses only what the admin cascade flagged — the owner's own earlier deletions stay deleted |
| Admin purges a business | Permanent. Requires the business to be archived first |

Reports, low-stock, category counts and the admin dashboard all exclude flagged
rows automatically. Historical `$lookup`s from order lines are deliberately left
unfiltered, so a sale made before a product was deleted still groups correctly.

## Auth model

```
Authorization: Bearer <token>
```

Two token roles, deliberately non-interchangeable:

| Role | Obtained from | Reaches |
|---|---|---|
| `business` | `/auth/register`, `/auth/login` | POS, inventory, reports |
| `admin` | `/auth/admin/login` | `/admin/*` only |

A business token on an admin route returns 403, and vice versa.

## Endpoints

### Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/signin` | `{identifier, secret}` | **The one the app uses.** Resolves to a business or super-admin session; the response carries `role` |
| POST | `/api/auth/register` | `{businessName, pin}` | 409 if a LIVE shop has that name, or if the name is the admin username |
| POST | `/api/auth/login` | `{businessName, pin}` | Business only. Kept for scripting |
| GET | `/api/auth/me` | — | Token check + category/product/order counts |
| PATCH | `/api/auth/pin` | `{currentPin, newPin}` | |
| PATCH | `/api/auth/business` | `{name}` | Rename — safe now that the key is opaque |
| POST | `/api/auth/admin/login` | `{username, password}` | From `.env`, compared in constant time |

PIN must be 4–6 digits.

`PATCH /api/auth/pin` answers **400** — not 401 — when `currentPin` is wrong.
401 belongs to the auth middleware, and a client that reads it as "your session
is over" is right to discard the token; when this endpoint used 401, one
mistyped digit signed the shopkeeper out and told them their session had
expired. The token they sent was fine. It was the field that was wrong.

### One form, two account types

`/auth/signin` takes an `identifier` and a `secret` and works out the rest, so the
app needs a single login form instead of making the user classify themselves
before typing. The admin username is checked first and is **reserved at
registration**, so a shop can never shadow it. Every failure returns a
byte-identical 401, so the endpoint cannot be used to discover which shops exist.

### Rate limiting is per account, not just per IP

A 4-digit PIN is 10,000 combinations, so the limit that matters is tied to the
account being attacked: **10 attempts per 10 minutes per identifier**. A looser
**60 per 15 minutes per IP** stops one host sweeping many accounts.

Keying the strict limit on the account rather than the address matters in a real
shop: several staff phones share one Wi-Fi address, and locking the whole shop out
because a different account was attacked from the same router would be worse than
the attack. Verified by `npm run test:ratelimit` — hammering one account locks
only that account, while another shop on the same IP signs in unaffected.

### Categories
| Method | Path | Notes |
|---|---|---|
| GET | `/api/categories` | Includes `productCount` per category |
| POST | `/api/categories` | `{name, color?}` — hex colour, 409 on duplicate live name |
| PATCH | `/api/categories/:id` | |
| DELETE | `/api/categories/:id` | Soft delete. 409 if live products reference it; `?force=true` flags them too |

### Products
| Method | Path | Notes |
|---|---|---|
| GET | `/api/products` | `?categoryId=`, `?search=`, `?lowStock=5` |
| POST | `/api/products` | `{name, categoryId, price, cost?, stock?}` — a categoryId from another tenant is rejected |
| PATCH | `/api/products/:id` | |
| PATCH | `/api/products/:id/stock` | `{delta}` (atomic `$inc`) or `{set}`, plus optional `{reason, note}` |
| DELETE | `/api/products/:id` | Soft delete |
| POST | `/api/products/stocktake` | `{counts: [{productId, counted}], note?}` — a physical count |
| GET | `/api/products/:id/movements` | `?limit=50` — stock history and reconciliation |

Numeric strings from React Native `TextInput` are coerced. Negative prices and
fractional stock are 400s.

**Names are unique within a category.** One shop may not stock two products called
"Rice 5kg" under Grain; the same name under a different category is fine, and so is the
same name at a different shop. Matching is case-insensitive and collapses runs of
whitespace, because "rice 5kg" and "Rice&nbsp;&nbsp;5kg" are how duplicates actually get
in. Deleting a product frees its name. A clash returns **409** naming the product, from a
partial unique index — the check *is* the insert, so two phones adding the same product at
the same moment cannot both win.

An existing database may already hold duplicates, and a unique index cannot be built over
data that violates it — the build fails, the error goes to the connection handler, and the
app carries on accepting duplicates with nothing to show for it. Run `npm run db:dupes` to
list them, or `npm run db:dupes -- --fix` to rename the extras, then restart the API.

### Udhaar (credit)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/customers` | `?search=`, `?owing=1`. Every row carries its balance |
| POST | `/api/customers` | `{name, phone?, note?}` — names unique per shop |
| GET | `/api/customers/:id` | The ledger: sales and repayments merged, newest first |
| PATCH | `/api/customers/:id` | |
| DELETE | `/api/customers/:id` | 409 while they owe; `?force=true` writes the debt off |
| POST | `/api/customers/:id/payments` | `{amount, method?, note?}` |
| DELETE | `/api/payments/:id` | Undo a repayment entered by mistake |

An order gains `customerId` and `amountPaid`. `amountPaid` absent means the bill was paid in
full, which is what every sale written before this existed means too.

**There is no stored balance anywhere.** It is derived on every read:

```
balance = SUM(order.grandTotal - order.amountPaid) - SUM(payments)
```

The obvious alternative — a running total adjusted on each sale and repayment — is the one
that eventually shows a figure nobody can explain: a half-applied write, a voided sale that
was not accounted for, an edit that touched the order but not the customer. Once a stored
balance and the receipts behind it disagree, the shopkeeper cannot tell which is lying, and
the feature stops being trusted. Derived, there is nothing to drift from; at one shop's
scale the aggregate is cheaper than the bugs the alternative buys.

Two rules fall out of it. **Credit requires a named customer** — a walk-in who underpays is
not a debt, there is nobody to collect from, so it is refused at checkout and in the model.
And **overpayment is allowed**: settling a ₹940 debt with a ₹1000 note leaves ₹60 on
account, showing as a negative balance (money the shop owes). Refusing that would send the
shopkeeper back to a paper book for the one case the app most needs to handle.

Repayments are recorded against the CUSTOMER, not a particular receipt. That is how udhaar
works in a shop: somebody hands over ₹500 toward a running total, not toward invoice 42.

Receivables appear on `/api/reports/summary` and are deliberately **not** scoped to the
reporting period — a debt is outstanding until it is paid, and a figure that shrank every
time the date filter narrowed would mean something nobody asked for.

### Sending the same sale twice

`POST /api/orders` accepts an optional `clientRef` (8-64 chars of `A-Z a-z 0-9 . _ : -`),
unique per shop. A second arrival with a ref that already exists returns **200** with
`duplicate: true` and the ORIGINAL receipt — it does not price the cart, move stock, or
issue a receipt number.

This is what makes the app's offline queue safe. A checkout that timed out may well have
been applied and had its *reply* lost, and the phone cannot tell that from a request that
never arrived. Without a ref the only safe policy is never to retry, which is why a sale
with no signal simply failed.

Two details do the real work. The ref is checked **before** the cart is priced, so
replaying a sale after its stock has since sold out still returns the receipt instead of a
409 — otherwise a queue draining late would report a recorded sale as failed and offer to
discard a receipt the shop has already issued. And an `E11000` on the way in is caught and
answered with the winner's receipt, so two replays racing each other both succeed.

The index is partial on *existence* (so ref-less sales do not all collide on null) but not
on `deletedAt`: a voided sale's ref stays taken, or replaying its queue entry would
resurrect it.

### Units and fractional quantities

A product has a `unit` (`pcs` `pkt` `box` `dozen` `kg` `g` `l` `ml` `m`), defaulting to
`pcs`. The split that matters is countable vs measured: **a fraction is accepted for kg, g,
l, ml and m, and refused for the rest.** "2.5 pcs of soap" is a typo for 25; "2.5 kg of
rice" is Tuesday. Without the distinction the app either cannot serve a kirana or turns a
mis-tap into a wrong bill and wrong stock.

Every product that already existed defaults to `pcs`, so nothing behaves differently until
a unit is deliberately set. Quantities round to 3 decimals — 5 grams is the finest split
worth keeping — and are re-rounded whenever they are summed, because `0.1 + 0.2` is
`0.30000000000000004` and a quantity that cannot be printed is one nobody trusts.

Order lines snapshot the unit alongside the name and price: a receipt reading "1.5" after
the product moved from kg to pcs would be unreadable. Moving a product to a countable unit
while it holds a fraction is refused, naming the fix (set a whole-number stock in the same
save) rather than leaving it in a state every later operation rejects.

### Payment methods

An order carries `paymentMethod` — `cash` (default) `upi` `card` `other` — and
`/api/reports/summary` returns a `payments` breakdown. It answers the one question revenue
cannot: how much cash should be in the drawer tonight. Receipts written before the field
existed count as **cash**, which is what they were; bucketing them as "unknown" would put a
shop's whole history into a bucket that means nothing. The method is correctable after the
fact through `PATCH /api/orders/:id`, because "it was UPI, not cash" is the most ordinary
correction there is.

### The stock ledger

Every change to a product's stock **that is not a sale** writes a row to
`stockmovements`: the opening balance when a product is created, restocks, corrections,
damage, loss, returns, and the corrections a physical count applies. Each row records the
signed delta, the stock before and after, a reason from a closed set, an optional note, and
a snapshot of the product name — snapshotted for the same reason order lines are, so a
rename or a delete cannot quietly rewrite the history that explains a past discrepancy.

**Sales are deliberately not written here.** The orders collection already records, line by
line, exactly what left the shelf; a second row per line would duplicate the busiest thing
the app does — roughly 240 rows a day at 80 sales — to say something already written down.
`GET /api/products/:id/movements` merges the two at read time, deriving the sale entries
from the orders themselves. A voided order therefore disappears from the history exactly as
it returns the stock, with no compensating row.

The invariant the feature rests on:

```
current stock  ==  (sum of every ledger delta)  -  (units sold on live orders)
```

Anything left over is reported as `unexplained`, which is the number worth looking at: it
means stock moved without going through the app. To keep that honest, the ledger write is
compensated — if the movement row cannot be written, the stock change is rolled back with a
`$inc` rather than kept. A log with silent holes is worse than no log, because it is still
believed. Reasons are validated *before* anything is written, for the same reason.

Products that predate the ledger have no opening row, so their reconciliation starts out
looking wrong. `npm run db:backfill` reports what it would write and
`npm run db:backfill -- --fix` writes it, working the opening balance backwards from
`stock on hand + everything ever sold`. It skips any product that already has a ledger, so
it is safe to re-run.

### Stocktake

`POST /api/products/stocktake` applies a physical count. The counted figure always wins —
no stock guard, no merge with what the screen believed. That is the difference between a
count and an adjustment: the shelf is the authority. Products whose count matches are
skipped rather than written, so the ledger holds discrepancies rather than a row per
product per count.

Validation is all-or-nothing — an empty list, a repeated product, a fractional or negative
count, or an id that does not belong to this shop rejects the whole request before anything
is applied. Application is then per-product and reported per-product: a count of 200 items
that failed atomically on the 199th would throw away an hour of walking the shelves.

Variance is valued at **cost**, not selling price. A shelf that is three short has lost what
it cost to put them there; margin that was never earned was never money.

### Orders
| Method | Path | Notes |
|---|---|---|
| POST | `/api/orders` | `{customerName?, extraCharges?, items:[{productId, qty, discount?}]}` |
| GET | `/api/orders` | `?from=&to=&page=&limit=` |
| GET | `/api/orders/:id` | Receipt reprint |
| PATCH | `/api/orders/:id` | Correct a past sale — see below |
| DELETE | `/api/orders/:id` | Void: soft delete, stock returned, receipt kept for audit |

### Correcting a past sale

`PATCH /api/orders/:id` takes `{customerName?, extraCharges?, items?}`, where
`items` is the **complete desired set**, not a diff. The server works out what
changed, so one code path covers changing a quantity, removing a line and adding
a forgotten item.

- **Only the delta moves stock.** Editing 3 → 4 takes one more unit rather than
  returning three and taking four, so a concurrent sale cannot slip into the gap.
- **Existing lines keep their original price.** A correction must not silently
  reprice a past sale because the product costs more today. Newly added lines are
  priced from the product.
- **A failed edit changes nothing** — if the extra units are not in stock it
  returns 409 naming the shortfall, and any stock already moved is rolled back.
- The receipt number never changes, and the sale is stamped with `editedAt` and
  `editCount` so a corrected receipt is distinguishable from an original.
- Emptying an order is refused: void it instead.

Checkout guarantees:

- **Names and costs come from the database.** A body claiming `name: "Hacked"` or `cost: 0`
  changes nothing. Cost in particular decides reported profit, so a client that could set it
  could report any margin it liked.
- **Price MAY be set per line**, and deliberately so — a shop sells above or below the shelf
  price constantly (a haggled rate, a damaged tin, an over-collection). Send `price` on a line
  and that is what is charged; omit it and the catalogue price applies. This grants no new
  capability: the token already authenticates the owner, who can `PATCH /api/products` to any
  price. Every line records `listPrice` — what the catalogue said at that moment — so a sale
  off-list stays distinguishable from one made before a repricing.
- **Discounts are clamped** to each line's own value, so no line — and no order — can go negative.
- **Stock decrements are atomic** (`{stock: {$gte: qty}}` in the update filter). Five phones checking out the last unit produce exactly one sale and four 409s; stock lands on 0, never −4.
- **Receipt numbers are gapless and unique per shop**, reserved inside the transaction so a rolled-back sale does not burn one.
- Transactional on Atlas; on a standalone `mongod` it falls back to compensating writes that roll back partial decrements.
- The same product added twice merges into one line, so the stock maths stays right.

**Image bytes are reclaimed, not soft-deleted.** Everything else the shop can
remove is flagged and kept so it can come back; a photo is the exception,
because the bytes *are* the row and nothing in the app restores a single
picture. So replacing a photo, clearing it, deleting the product, and
`DELETE /api/images/:id` all remove it outright. Abandoned uploads — a "New
product" form opened, photographed and then cancelled — are swept on the next
upload once they are a day old.

Archiving a whole business is the one path that still soft-deletes images,
because archive is built to be undone; `restore` brings the photos back and
`purge` reclaims them. `npm run db:images` reports what an older build left
behind, and `-- --fix` reclaims it.

### Expenses
| Method | Path | Notes |
|---|---|---|
| GET | `/api/expenses` | `?from=&to=&limit=` — rows plus a `total` aggregated over the **whole** range, and `truncated` when the page does not hold it all |
| POST | `/api/expenses` | `{amount, note, spentAt?}` |
| PATCH | `/api/expenses/:id` | Any of the three fields |
| DELETE | `/api/expenses/:id` | Soft, like everything a shop can remove |

Money out that is **not** the cost of goods sold — rent, wages, electricity, a
repair. It exists because profit was a half-truth without it: revenue minus COGS
is what a shopkeeper reads as "what I made" while their rent is missing from it.

- **Deliberately uncategorised.** Amount, note, date. Presets would give a
  tidier report but are one more decision at the moment of entry, and a
  free-text note carries the same information for a shop this size. Notes can be
  grouped later without a migration; a category list, once shipped, cannot be
  withdrawn.
- **`spentAt` is the day the money left**, not the day it was typed. A `YYYY-MM-DD`
  body is pinned to midday so a date entered in IST cannot drift a day backwards
  when read as UTC midnight.
- **No zero and no future.** A zero-rupee expense is a mis-tap; a future one
  would move money into a period whose report has already been read.
- Amounts round to 2dp on validate, so paise cannot accumulate a drift.

### Reports
| Path | Feeds |
|---|---|
| `/api/reports/summary` | KPI row: revenue, COGS, `grossProfit`, `expenses`, `netProfit`, margin %, net margin %, AOV — plus a live inventory block: `investment` (capital tied up at cost), `retailValue`, `potentialProfit`, `stockUnits`, `lowStock`, `outOfStock` |
| `/api/reports/sales-trend` | Line chart. `?groupBy=day\|month`, gap-filled so no x-axis holes |
| `/api/reports/by-category` | Category comparison, with each category's colour and share % |
| `/api/reports/top-products` | Ranked list |
| `/api/reports/low-stock` | `?threshold=5` |
| `/api/reports/export` | Flat `orders[]` + `items[]` (with `receiptNo`) + `expenses[]` for CSV / XLSX / PDF on-device |

All accept `?from=&to=` (default: last 30 days). Day buckets use
`REPORT_TIMEZONE` (default `Asia/Kolkata`) so a 10pm sale counts as that day.

Profit is computed from the **cost snapshot frozen into each order line**, so
repricing a product never rewrites past profit. Voided orders are excluded.

`profit` still means **gross** — revenue minus COGS — and deliberately kept that
meaning when expenses arrived, so nothing already reading it changed under it.
The honest bottom line is `netProfit` (`grossProfit - expenses`) beside it, and
it is **not floored at zero**: a month where the rent outran the margin reports
a loss, because that is the one number worth acting on.

### Backup
| Method | Path | Notes |
|---|---|---|
| GET | `/api/backup/status` | What a backup would hold, without building one |
| GET | `/api/backup/export` | `?images=1` to include photos |
| POST | `/api/backup/restore` | `{backup, mode}` — mode `empty` (default) or `replace` |

Atlas's free tier takes no automated backups, so without this the shop's entire history has
exactly one copy. The report export is not a substitute: it is a flattened summary for
reading and nothing can be rebuilt from it.

**The file is MongoDB Extended JSON, not plain JSON, and that is load-bearing.** Plain
`JSON.stringify` turns an ObjectId into a 24-character string and a Date into an ISO
string. Restore that and every order line points at nothing, and every date-range report
silently matches zero rows — a restore that looks completely successful and has lost the
shop. Extended JSON is still ordinary JSON (it survives a file, a chat app, a text editor)
but tags those values so they come back as what they were.

Ids are **regenerated** on restore and every reference re-pointed: product → category,
product ↔ image, order line → product, movement → product. Keeping the originals was the
obvious first instinct and is wrong — `_id` is unique per collection, not per shop, so a
backup could then only be restored into a database that did not already contain it. That
rules out restoring a copy alongside the original to check it, and fails with a
duplicate-key error rather than anything a shopkeeper could act on.

`businessId` is rewritten to whichever shop is restoring, which is what lets a backup come
back into a fresh account after the old one is lost — and means a backup can never smuggle
rows into a tenant that did not ask for them. The order counter travels too; without it the
first sale after a restore is handed receipt number 1 again and collides with the unique
index on `(businessId, orderNumber)`. Deleted rows travel with their flags, so a restore
cannot turn a reversible deletion into a permanent one.

**The PIN hash is never in the file.** A backup is the least protected copy of a shop that
exists, and a bcrypt hash sitting in one is an offline cracking target for no benefit.

The `counts` block is a checksum and is verified, not displayed: a JSON file truncated by a
failed download still parses, it just has fewer rows, and restoring it would look like a
success while losing the tail of the history. Photos are opt-in — ~60KB each, so they turn
a 400KB backup into a 30MB one. `/api/backup/restore` gets its own 25mb body parser;
everything else on the API stays at 1mb.

There is no merge mode. Merging two versions of one shop means deciding per row which of
two edits wins, which no script can do on a shopkeeper's behalf, and the failure mode is a
catalogue full of near-duplicates that is worse than either input.

### Admin
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/stats` | Platform totals, including archived business count |
| GET | `/api/admin/businesses` | Live tenants with counts and revenue. `?includeDeleted=true` also returns archived ones with their archived counts |
| GET | `/api/admin/businesses/:businessId` | Drill-down before archiving |
| DELETE | `/api/admin/businesses/:businessId` | Cascading **archive**. Reversible |
| POST | `/api/admin/businesses/:businessId/restore` | Reverses the cascade. Optional `{name}`; auto-renames if the old name was taken meanwhile |
| DELETE | `/api/admin/businesses/:businessId/purge` | Permanent. 409 unless already archived |

MongoDB has no foreign keys, so the cascade is explicit and transactional.
Verified in the test suite by reading `deletedAt` on every row directly in the
database, not by trusting the API response.

## Response shape

Success: `{ok: true, ...}` · Error: `{ok: false, error: "...", details?: {...}}`

| Status | Meaning |
|---|---|
| 400 | Validation — `details` maps field → problem |
| 401 | Missing/expired token, wrong PIN |
| 403 | Right token, wrong role |
| 404 | Not found, **or owned by another tenant**, **or soft-deleted** (deliberately indistinguishable) |
| 409 | Duplicate name, insufficient stock (`details.outOfStock`), or an invalid lifecycle step |
| 503 | Database unreachable |

## Connecting the Expo app

The app derives the API URL from the LAN IP Expo is already serving from, so
there is normally nothing to configure. To point it at a deployed backend, set
`EXPO_PUBLIC_API_URL` in `mobile/.env`.

## Diagnostics

| Command | Answers |
|---|---|
| `npm run dns:check` | Can I look up the cluster? |
| `npm run net:check` | Can I reach it on 27017? |
| `npm run db:check` | Do my credentials work? |
| `npm run db:reset` | Start clean with current indexes |
| `npm test` | Does the whole API behave? |

## Before going live

- Replace the Atlas `0.0.0.0/0` allow-list entry with your host's IP.
- Set `NODE_ENV=production` (drops stack traces from 500 responses, blocks `db:reset`).
- Narrow `cors({origin: '*'})` once the app ships.
- Consider a retention job that purges rows soft-deleted more than N months ago.
