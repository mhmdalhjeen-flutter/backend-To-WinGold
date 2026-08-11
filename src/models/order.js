// models/order.js
const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId },
  itemType: { type: String, enum: ['Product', 'Offer'], required: true },
  quantity: { type: Number, required: true, min: 1 },
  purchaseMethod: { type: String, enum: ['quantity', 'price'], default: 'quantity' },
  requestedAmount: { type: Number, min: 0 },
  price: { type: Number, required: true },
  subtotal: { type: Number },
  name: { type: String, required: true },
  productName: { type: String, default: '' },
  image: { type: String, default: '' },
  productImage: { type: String, default: '' },
}, { _id: false });

const transferInfoSchema = new mongoose.Schema({
  senderName: { type: String, default: '' },
  contactNumber: { type: String, default: '' },
  referenceNumber: { type: String, default: '' },
  note: { type: String, default: '' },
}, { _id: false });

const statusTimelineSchema = new mongoose.Schema({
  status: { type: String, required: true },
  at: { type: Date, default: Date.now },
  note: { type: String, default: '' },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, index: true, sparse: true },
  verificationCode: { type: String, index: true, unique: true, sparse: true },
  // Client-generated id for a single checkout attempt. Lets a retried offline
  // sync replay the original order instead of creating a duplicate.
  clientOperationId: { type: String, default: undefined },
  containerId: { type: String, default: '' },
  containerName: { type: String, default: '' },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  storeName: { type: String, default: '' },
  items: [orderItemSchema],
  subtotal: { type: Number },
  total: { type: Number, required: true },
  totalAmount: { type: Number },
  currency: { type: String, default: 'ILS' },
  status: {
    type: String,
    enum: [
      'pending',
      'modification_requested',
      'store_accepted',
      'ready_for_delivery_pickup',
      'ready_for_driver_pickup',
      'delivery_handover_complete',
      'preparing',
      'delivered_to_driver',
      'delivered_to_customer',
      'confirmed',
      'rejected',
      'delivered',
      'cancelled',
      'completed_off_platform',
    ],
    default: 'pending',
  },
  customerNotes: { type: String, default: '' },
  storeNotes: { type: String, default: '' },
  deliveryMethod: { type: String, default: '' },
  deliveryAddress: { type: String, default: '' },
  deliveryNotes: { type: String, default: '' },
  paymentMethod: { type: String, default: '' },
  transferInformation: { type: transferInfoSchema, default: () => ({}) },
  transferName: { type: String, default: '' },
  transferPhone: { type: String, default: '' },
  transferNumber: { type: String, default: '' },
  paymentNotes: { type: String, default: '' },
  rejectionReason: { type: String, default: '' },
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'pending', 'paid'],
    default: 'unpaid',
  },
  paymentProof: { type: String, default: '' },
  paymentProofImage: { type: String, default: '' },
  deliveryGroup: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryGroup',
    default: null,
  },
  pointsAwarded: { type: Boolean, default: false },
  rewardPointsAwarded: { type: Number, default: 0 },
  consumedCardType: { type: mongoose.Schema.Types.ObjectId, ref: 'CardType', default: null },
  cardDeducted: { type: Boolean, default: false },
  confirmedAt: { type: Date },
  completedAt: { type: Date },
  deleteAfter: { type: Date },
  statusTimeline: [statusTimelineSchema],

  /** Set when the store confirms handover to the delivery company (accounting event) */
  deliveryCompanyHandoverAt: { type: Date, default: null },
  deliveryCompanyHandoverCompany: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryCompany',
    default: null,
    index: true,
  },

  /** Store requested customer to modify the order */
  modificationRequest: {
    reason: {
      type: String,
      enum: [
        'area_too_far',
        'items_unavailable',
        'payment_method_change_suggested',
        'payment_data_review',
        '',
      ],
      default: '',
    },
    message: { type: String, default: '' },
    storeNote: { type: String, default: '' },
    currentPaymentMethod: { type: String, default: '' },
    suggestedPaymentMethod: { type: String, default: '' },
    unavailableItemIndexes: [{ type: Number }],
    unavailableItems: [{
      index: { type: Number },
      item: { type: mongoose.Schema.Types.ObjectId },
      itemType: { type: String },
      name: { type: String },
      quantity: { type: Number },
      price: { type: Number },
      subtotal: { type: Number },
      image: { type: String, default: '' },
    }],
    requestedAt: { type: Date },
    resolvedAt: { type: Date },
    /** Sum of unavailable item subtotals (items_unavailable only) */
    availableReplacementAmount: { type: Number },
  },

  /** Full change log for invoice / tracking */
  orderChangeHistory: [{
    at: { type: Date, default: Date.now },
    type: { type: String, required: true },
    note: { type: String, default: '' },
    actor: { type: String, enum: ['store', 'customer', 'system'], default: 'system' },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  }],

  originalTotal: { type: Number },
  additionalPaymentAmount: { type: Number, default: 0 },
  additionalPayment: {
    method: { type: String, default: '' },
    proof: { type: String, default: '' },
    transferInformation: { type: transferInfoSchema, default: () => ({}) },
    paidAt: { type: Date },
  },
  paymentTransactions: [{
    type: { type: String, enum: ['original', 'difference', 'correction'], default: 'difference' },
    amount: Number,
    method: String,
    proof: String,
    transferInformation: transferInfoSchema,
    paidAt: Date,
    note: String,
  }],

  /**
   * Client operation ids of modifications already applied to this order.
   * A modification confirmed offline may be uploaded more than once; replaying
   * a known id returns the current order instead of applying it twice.
   */
  appliedModificationOps: [{ type: String }],
}, { timestamps: true });

orderSchema.index({ store: 1, status: 1, createdAt: -1 });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ customer: 1, store: 1, status: 1, createdAt: -1 });
orderSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { deleteAfter: { $type: 'date' } } });
// Bulk checkout creates one order per store under a single operation id,
// so uniqueness is per store — a replayed sync can never insert twice.
orderSchema.index(
  { customer: 1, clientOperationId: 1, store: 1 },
  { unique: true, partialFilterExpression: { clientOperationId: { $type: 'string' } } }
);

module.exports = mongoose.model('Order', orderSchema);
