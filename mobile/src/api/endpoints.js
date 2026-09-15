import { api } from './client';

/** Mirrors backend/README.md one-for-one. Response interceptor already unwraps .data. */

export const authApi = {
  /** Unified: resolves to a business or admin session server-side. */
  signIn: (identifier, secret) => api.post('/auth/signin', { identifier, secret }),
  register: (businessName, pin) => api.post('/auth/register', { businessName, pin }),
  login: (businessName, pin) => api.post('/auth/login', { businessName, pin }),
  me: () => api.get('/auth/me'),
  changePin: (currentPin, newPin) => api.patch('/auth/pin', { currentPin, newPin }),
  /** The server's field is `name`; sending `businessName` here would 400. */
  renameBusiness: (name) => api.patch('/auth/business', { name }),
  adminLogin: (username, password) => api.post('/auth/admin/login', { username, password }),
};

export const categoryApi = {
  list: () => api.get('/categories'),
  create: (name, color) => api.post('/categories', { name, color }),
  update: (id, patch) => api.patch(`/categories/${id}`, patch),
  remove: (id, { force = false } = {}) =>
    api.delete(`/categories/${id}${force ? '?force=true' : ''}`),
};

export const productApi = {
  list: (params = {}) => api.get('/products', { params }),
  create: (payload) => api.post('/products', payload),
  update: (id, patch) => api.patch(`/products/${id}`, patch),
  /** `{delta}` or `{set}`, plus an optional `{reason, note}` for the ledger. */
  adjustStock: (id, body) => api.patch(`/products/${id}/stock`, body),
  remove: (id) => api.delete(`/products/${id}`),
  /**
   * A physical count. Send ONLY the products actually counted -- an omitted
   * product is one nobody looked at, not one with zero on the shelf.
   */
  stocktake: (payload) => api.post('/products/stocktake', payload),
  /** Stock history: ledger adjustments merged with the sales, plus a reconciliation. */
  movements: (id, params = {}) => api.get(`/products/${id}/movements`, { params }),
};

export const orderApi = {
  checkout: (payload) => api.post('/orders', payload),
  list: (params = {}) => api.get('/orders', { params }),
  get: (id) => api.get(`/orders/${id}`),
  /** `items` is the COMPLETE desired set; the server computes the stock delta. */
  update: (id, patch) => api.patch(`/orders/${id}`, patch),
  void: (id) => api.delete(`/orders/${id}`),
};

/**
 * Money out that is not the cost of goods sold. Uncategorised on purpose --
 * amount, note and date are the whole record (see backend Expense model).
 */
export const expenseApi = {
  list: (params = {}) => api.get('/expenses', { params }),
  create: (payload) => api.post('/expenses', payload),
  update: (id, patch) => api.patch(`/expenses/${id}`, patch),
  remove: (id) => api.delete(`/expenses/${id}`),
};

export const reportApi = {
  summary: (params) => api.get('/reports/summary', { params }),
  salesTrend: (params) => api.get('/reports/sales-trend', { params }),
  byCategory: (params) => api.get('/reports/by-category', { params }),
  topProducts: (params) => api.get('/reports/top-products', { params }),
  lowStock: (params) => api.get('/reports/low-stock', { params }),
  exportData: (params) => api.get('/reports/export', { params }),
};

/**
 * Udhaar: who owes the shop money, and what they have paid back.
 *
 * No balance is ever sent TO the server -- it is derived from receipts and
 * repayments on every read, so there is nothing here that can disagree with
 * the sales behind it.
 */
export const customerApi = {
  list: (params = {}) => api.get('/customers', { params }),
  get: (id, params = {}) => api.get(`/customers/${id}`, { params }),
  create: (payload) => api.post('/customers', payload),
  update: (id, patch) => api.patch(`/customers/${id}`, patch),
  /** force=true writes the debt off; without it a debtor cannot be deleted. */
  remove: (id, { force = false } = {}) =>
    api.delete(`/customers/${id}${force ? '?force=true' : ''}`),
  recordPayment: (id, payload) => api.post(`/customers/${id}/payments`, payload),
  removePayment: (paymentId) => api.delete(`/payments/${paymentId}`),
};

/**
 * A full copy of the shop, and the way back from one.
 *
 * Photos are opt-in on export: they are ~60KB each and dwarf everything else.
 */
export const backupApi = {
  status: () => api.get('/backup/status'),
  export: ({ images = false } = {}) =>
    api.get(`/backup/export${images ? '?images=1' : ''}`, { timeout: 120000 }),
  /** mode: 'empty' (refuses if the shop has data) or 'replace' (wipes first). */
  restore: (backup, { mode = 'empty' } = {}) =>
    api.post('/backup/restore', { backup, mode }, { timeout: 180000 }),
};

export const adminApi = {
  stats: () => api.get('/admin/stats'),
  businesses: ({ includeDeleted = false } = {}) =>
    api.get('/admin/businesses', { params: includeDeleted ? { includeDeleted: true } : {} }),
  business: (businessId) => api.get(`/admin/businesses/${encodeURIComponent(businessId)}`),
  /** Cascading SOFT delete -- reversible via restoreBusiness. */
  deleteBusiness: (businessId) => api.delete(`/admin/businesses/${encodeURIComponent(businessId)}`),
  restoreBusiness: (businessId) => api.post(`/admin/businesses/${encodeURIComponent(businessId)}/restore`),
  /** Permanent. The business must be archived first. */
  purgeBusiness: (businessId) => api.delete(`/admin/businesses/${encodeURIComponent(businessId)}/purge`),
};

export const healthApi = {
  check: () => api.get('/health'),
};
