// models/cart.js — store-based shopping containers
const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    itemType: {
      type: String,
      enum: ['Product', 'Offer'],
      required: true,
    },
    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    /** quantity | price — how the customer ordered this line */
    purchaseMethod: {
      type: String,
      enum: ['quantity', 'price'],
      default: 'quantity',
    },
    /** Money amount when purchaseMethod is price (e.g. 7 ₪ of seeds) */
    requestedAmount: {
      type: Number,
      min: 0,
    },
  },
  { _id: false }
);

const cartContainerSchema = new mongoose.Schema(
  {
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
    },
    storeName: { type: String, default: '' },
    locked: { type: Boolean, default: false },
    lockedAt: { type: Date },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    customerNotes: { type: String, default: '', maxlength: 500 },
    items: [cartItemSchema],
  },
  { _id: true }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    /** @deprecated flat list — kept in sync for backward compatibility */
    items: [cartItemSchema],
    /** Per-store editable baskets until confirm */
    containers: [cartContainerSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cart', cartSchema);
