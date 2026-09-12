import { create } from 'zustand';
import { round2 } from '../utils/money';

/**
 * The live cart (PRD 5B). Deliberately NOT persisted: a half-finished sale
 * surviving an app restart would be worse than losing it, because the operator
 * would not know which items had already been rung up.
 *
 * Every total here is a client-side preview. The backend recomputes all of it
 * from database prices at checkout, so tampering with this state changes
 * nothing about what is actually charged.
 */

/**
 * What this line actually charges.
 *
 * `price` is the catalogue price, frozen when the item entered the cart.
 * `priceOverride` is what the operator typed instead -- null when they have
 * not. They are kept apart rather than one field being mutated so the row can
 * still show what the shelf says, and so clearing the override restores it
 * without another lookup.
 *
 * `?? ` and not `||`: a giveaway at zero is a real thing a shop does, and `||`
 * would silently fall back to the catalogue price for exactly that case.
 */
export const unitPrice = (item) => (item.priceOverride ?? item.price ?? 0);

/** True when the operator has priced this line by hand. */
export const isRepriced = (item) =>
  item.priceOverride != null && round2(item.priceOverride) !== round2(item.price);

const clampDiscount = (item) => Math.min(item.discount ?? 0, round2(item.qty * unitPrice(item)));

export const lineGross = (item) => round2(item.qty * unitPrice(item));
export const lineTotal = (item) => round2(Math.max(0, lineGross(item) - clampDiscount(item)));

export const useCartStore = create((set, get) => ({
  // [{ productId, name, price, priceOverride, cost, stock, qty, discount }]
  items: [],
  customerName: '',
  extraCharges: 0,

  /** Tapping a product card. Adding an existing one bumps its quantity. */
  addItem: (product) => {
    const items = get().items;
    const existing = items.find((i) => i.productId === product._id);

    if (existing) {
      if (existing.qty >= existing.stock) return { ok: false, reason: 'stock' };
      return set({
        items: items.map((i) =>
          i.productId === product._id ? { ...i, qty: i.qty + 1 } : i
        ),
      }) ?? { ok: true };
    }

    if ((product.stock ?? 0) < 1) return { ok: false, reason: 'stock' };

    set({
      items: [
        ...items,
        {
          productId: product._id,
          name: product.name,
          price: Number(product.price) || 0,
          cost: Number(product.cost) || 0,
          stock: Number(product.stock) || 0,
          imageUrl: product.imageUrl ?? null,
          qty: 1,
          discount: 0,
          priceOverride: null,
        },
      ],
    });
    return { ok: true };
  },

  increment: (productId) => {
    const item = get().items.find((i) => i.productId === productId);
    if (!item) return { ok: false };
    if (item.qty >= item.stock) return { ok: false, reason: 'stock' };
    set({
      items: get().items.map((i) => (i.productId === productId ? { ...i, qty: i.qty + 1 } : i)),
    });
    return { ok: true };
  },

  /** Decrementing to zero removes the line, so no empty rows linger. */
  decrement: (productId) =>
    set({
      items: get()
        .items.map((i) => (i.productId === productId ? { ...i, qty: i.qty - 1 } : i))
        .filter((i) => i.qty > 0)
        // A smaller quantity can make a previously valid discount too large.
        .map((i) => ({ ...i, discount: clampDiscount(i) })),
    }),

  removeItem: (productId) =>
    set({ items: get().items.filter((i) => i.productId !== productId) }),

  /** PRD 7 edge case 2, mirrored client-side so the UI never shows a negative. */
  setDiscount: (productId, value) =>
    set({
      items: get().items.map((i) => {
        if (i.productId !== productId) return i;
        const requested = Math.max(0, Number(value) || 0);
        return { ...i, discount: Math.min(requested, lineGross(i)) };
      }),
    }),

  /**
   * Price this line by hand for this sale only.
   *
   * Passing '' or null clears the override and the catalogue price comes back.
   * Changing the price can leave a previously valid discount larger than the
   * line is now worth, so it re-clamps -- the same trap that let the operator
   * see a discount the server would silently reduce on save.
   */
  setPriceOverride: (productId, value) =>
    set({
      items: get().items.map((i) => {
        if (i.productId !== productId) return i;
        const cleared = value === '' || value === null || value === undefined;
        const parsed = Number(value);
        const next = {
          ...i,
          priceOverride: cleared || !Number.isFinite(parsed) ? null : Math.max(0, round2(parsed)),
        };
        return { ...next, discount: clampDiscount(next) };
      }),
    }),

  setCustomerName: (customerName) => set({ customerName }),
  setExtraCharges: (value) => set({ extraCharges: Math.max(0, Number(value) || 0) }),

  clear: () => set({ items: [], customerName: '', extraCharges: 0 }),

  /** Exactly the shape POST /api/orders expects. */
  toOrderPayload: () => {
    const { items, customerName, extraCharges } = get();
    return {
      customerName: customerName.trim() || undefined,
      extraCharges: extraCharges || 0,
      items: items.map((i) => ({
        productId: i.productId,
        qty: i.qty,
        discount: i.discount || 0,
        // Omitted entirely when untouched, so the server prices from the
        // catalogue and the receipt records no override.
        ...(i.priceOverride != null && { price: i.priceOverride }),
      })),
    };
  },
}));

/* ---- derived values (kept outside the store so they never go stale) ---- */

export const selectItemCount = (s) => s.items.reduce((n, i) => n + i.qty, 0);

/**
 * GROSS of the lines, before discounts -- this is what a receipt calls the
 * subtotal. Showing the net figure here and then listing the discount as a
 * deduction underneath double-counted it: "Subtotal 40, Discount -10, Total 40".
 */
export const selectGross = (s) => round2(s.items.reduce((sum, i) => sum + lineGross(i), 0));

export const selectTotalDiscount = (s) =>
  round2(s.items.reduce((sum, i) => sum + Math.min(i.discount ?? 0, lineGross(i)), 0));

/** Net of the lines. Used for profit maths, never shown as "Subtotal". */
export const selectNet = (s) => round2(s.items.reduce((sum, i) => sum + lineTotal(i), 0));

export const selectGrandTotal = (s) =>
  round2(Math.max(0, selectGross(s) - selectTotalDiscount(s) + (s.extraCharges || 0)));
