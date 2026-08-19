/**
 * Soft delete for every collection.
 *
 * Rows are never removed; they get a `deletedAt` timestamp and disappear from
 * ordinary queries. That makes deletion reversible, keeps order history
 * referentially intact, and leaves an audit trail.
 *
 * The safety property that matters: exclusion is applied by MIDDLEWARE, not by
 * remembering to add a filter at every call site. A controller that forgets
 * cannot leak deleted rows, because there is no code path that omits the
 * filter -- you have to ask for deleted rows explicitly.
 *
 *   Product.find({ businessId })                          // active only
 *   Product.find({ businessId }).withDeleted()            // include deleted
 *   Product.find({ businessId }).onlyDeleted()            // deleted only
 *   Product.softDelete({ _id, businessId })
 *   Product.restore({ _id, businessId })
 *   Product.aggregate(pipeline)                           // active only
 *   Product.aggregate(pipeline, { withDeleted: true })    // include deleted
 */

// Every read/count/update path Mongoose exposes as query middleware.
const QUERY_HOOKS = [
  'count', 'countDocuments', 'distinct', 'find', 'findOne',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
  'updateOne', 'updateMany', 'replaceOne',
];

export function softDeletePlugin(schema, { indexField = true } = {}) {
  schema.add({
    deletedAt: { type: Date, default: null, index: indexField },
    // Who performed it: 'owner' for the shop, 'admin' for a super-admin cascade.
    deletedBy: { type: String, default: null },
  });

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function excludeDeleted() {
      const opts = this.getOptions?.() ?? {};
      if (opts.withDeleted || opts.onlyDeleted) return;

      // Respect an explicit deletedAt condition from the caller.
      const conditions = this.getQuery?.() ?? {};
      if (Object.prototype.hasOwnProperty.call(conditions, 'deletedAt')) return;

      this.where({ deletedAt: null });
    });
  }

  schema.pre('aggregate', function excludeDeletedFromAggregate() {
    if (this.options?.withDeleted) return;
    const pipeline = this.pipeline();
    // $match must come first so the index is used and later stages never see
    // deleted rows.
    pipeline.unshift({ $match: { deletedAt: null } });
  });

  schema.query.withDeleted = function withDeleted() {
    return this.setOptions({ withDeleted: true });
  };

  schema.query.onlyDeleted = function onlyDeleted() {
    return this.setOptions({ onlyDeleted: true }).where({ deletedAt: { $ne: null } });
  };

  /** Marks one row deleted. Returns the updated document, or null if not found. */
  schema.statics.softDeleteOne = function softDeleteOne(filter, { by = 'owner' } = {}) {
    return this.findOneAndUpdate(filter, { deletedAt: new Date(), deletedBy: by }, { new: true });
  };

  /** Marks many rows deleted. Returns { matchedCount, modifiedCount }. */
  schema.statics.softDeleteMany = function softDeleteMany(filter, { by = 'owner', session } = {}) {
    return this.updateMany(
      filter,
      { deletedAt: new Date(), deletedBy: by },
      { ...(session && { session }) }
    );
  };

  /** Clears the flag. Must opt into seeing deleted rows to find them at all. */
  schema.statics.restoreMany = function restoreMany(filter, { session } = {}) {
    return this.updateMany(
      filter,
      { deletedAt: null, deletedBy: null },
      { withDeleted: true, ...(session && { session }) }
    );
  };

  /** Permanent removal. Only the super admin's purge should reach this. */
  schema.statics.hardDeleteMany = function hardDeleteMany(filter, { session } = {}) {
    return this.deleteMany(filter, { withDeleted: true, ...(session && { session }) });
  };

  schema.methods.isDeleted = function isDeleted() {
    return this.deletedAt != null;
  };
}

export default softDeletePlugin;
