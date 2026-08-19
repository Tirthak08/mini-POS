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
npm test                  # 241 assertions against a real MongoDB replica set
npm run test:standalone   # proves the no-transaction fallback path
npm run test:ratelimit    # proves per-account brute-force protection
```

Both boot a throwaway MongoDB, spawn the real server and drive it over HTTP —
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
| PATCH | `/api/products/:id/stock` | `{delta}` (atomic `$inc`) or `{set}` |
| DELETE | `/api/products/:id` | Soft delete |

Numeric strings from React Native `TextInput` are coerced. Negative prices and
fractional stock are 400s.

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

- **Prices come from the database.** A body claiming `price: 1` for a ₹500 item changes nothing.
- **Discounts are clamped** to each line's own value, so no line — and no order — can go negative.
- **Stock decrements are atomic** (`{stock: {$gte: qty}}` in the update filter). Five phones checking out the last unit produce exactly one sale and four 409s; stock lands on 0, never −4.
- **Receipt numbers are gapless and unique per shop**, reserved inside the transaction so a rolled-back sale does not burn one.
- Transactional on Atlas; on a standalone `mongod` it falls back to compensating writes that roll back partial decrements.
- The same product added twice merges into one line, so the stock maths stays right.

### Reports
| Path | Feeds |
|---|---|
| `/api/reports/summary` | KPI row: revenue, COGS, profit, margin %, AOV — plus a live inventory block: `investment` (capital tied up at cost), `retailValue`, `potentialProfit`, `stockUnits`, `lowStock`, `outOfStock` |
| `/api/reports/sales-trend` | Line chart. `?groupBy=day\|month`, gap-filled so no x-axis holes |
| `/api/reports/by-category` | Category comparison, with each category's colour and share % |
| `/api/reports/top-products` | Ranked list |
| `/api/reports/low-stock` | `?threshold=5` |
| `/api/reports/export` | Flat `orders[]` + `items[]` (with `receiptNo`) for CSV / XLSX / PDF on-device |

All accept `?from=&to=` (default: last 30 days). Day buckets use
`REPORT_TIMEZONE` (default `Asia/Kolkata`) so a 10pm sale counts as that day.

Profit is computed from the **cost snapshot frozen into each order line**, so
repricing a product never rewrites past profit. Voided orders are excluded.

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
