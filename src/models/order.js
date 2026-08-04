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
      'store_accepted',
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
  cardDeducted: { type: Boolean, default: false },
  confirmedAt: { type: Date },
  completedAt: { type: Date },
  deleteAfter: { type: Date },
  statusTimeline: [statusTimelineSchema],
}, { timestamps: true });

orderSchema.index({ store: 1, status: 1, createdAt: -1 });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ customer: 1, store: 1, status: 1, createdAt: -1 });
orderSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { deleteAfter: { $type: 'date' } } });

module.exports = mongoose.model('Order', orderSchema);
