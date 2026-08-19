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

const clampDiscount = (item) => Math.min(item.discount ?? 0, round2(item.qty * item.price));

export const lineGross = (item) => round2(item.qty * item.price);
export const lineTotal = (item) => round2(Math.max(0, lineGross(item) - clampDiscount(item)));

export const useCartStore = create((set, get) => ({
  items: [], // [{ productId, name, price, cost, stock, qty, discount }]
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

  setCustomerName: (customerName) => set({ customerName }),
  setExtraCharges: (value) => set({ extraCharges: Math.max(0, Number(value) || 0) }),

  clear: () => set({ items: [], customerName: '', extraCharges: 0 }),

  /** Exactly the shape POST /api/orders expects. */
  toOrderPayload: () => {
    const { items, customerName, extraCharges } = get();
    return {
      customerName: customerName.trim() || undefined,
      extraCharges: extraCharges || 0,
      items: items.map((i) => ({ productId: i.productId, qty: i.qty, discount: i.discount || 0 })),
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
