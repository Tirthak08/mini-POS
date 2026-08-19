import { api } from './client';

/** Mirrors backend/README.md one-for-one. Response interceptor already unwraps .data. */

export const authApi = {
  /** Unified: resolves to a business or admin session server-side. */
  signIn: (identifier, secret) => api.post('/auth/signin', { identifier, secret }),
  register: (businessName, pin) => api.post('/auth/register', { businessName, pin }),
  login: (businessName, pin) => api.post('/auth/login', { businessName, pin }),
  me: () => api.get('/auth/me'),
  changePin: (currentPin, newPin) => api.patch('/auth/pin', { currentPin, newPin }),
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
  adjustStock: (id, body) => api.patch(`/products/${id}/stock`, body),
  remove: (id) => api.delete(`/products/${id}`),
};

export const orderApi = {
  checkout: (payload) => api.post('/orders', payload),
  list: (params = {}) => api.get('/orders', { params }),
  get: (id) => api.get(`/orders/${id}`),
  /** `items` is the COMPLETE desired set; the server computes the stock delta. */
  update: (id, patch) => api.patch(`/orders/${id}`, patch),
  void: (id) => api.delete(`/orders/${id}`),
};

export const reportApi = {
  summary: (params) => api.get('/reports/summary', { params }),
  salesTrend: (params) => api.get('/reports/sales-trend', { params }),
  byCategory: (params) => api.get('/reports/by-category', { params }),
  topProducts: (params) => api.get('/reports/top-products', { params }),
  lowStock: (params) => api.get('/reports/low-stock', { params }),
  exportData: (params) => api.get('/reports/export', { params }),
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
