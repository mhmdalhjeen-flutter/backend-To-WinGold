// models/conversation.js
const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema({
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    lastMessage:  { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
    // آخر عنصر للتوافق مع الواجهات القديمة
    context: {
        itemId:    { type: mongoose.Schema.Types.ObjectId },
        itemType:  { type: String, enum: ["Product", "Offer", "BazaarListing", "Support"] },
        itemName:  { type: String },
        itemImage: { type: String },
        itemUrl:   { type: String },
    },
    // كل المنتجات/العروض التي نُوقشت في المحادثة
    referencedItems: [{
        itemId:    { type: mongoose.Schema.Types.ObjectId, required: true },
        itemType:  { type: String, enum: ["Product", "Offer", "BazaarListing", "Support"], required: true },
        itemName:  { type: String, default: "" },
        itemImage: { type: String, default: "" },
        addedAt:   { type: Date, default: Date.now },
    }],
    unreadCount: {
        type: Map,
        of: Number,
        default: {},
    },
}, { timestamps: true });

conversationSchema.index({ participants: 1, updatedAt: -1 });

module.exports = mongoose.model("Conversation", conversationSchema);