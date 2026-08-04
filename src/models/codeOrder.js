// models/codeOrder.js
const mongoose = require("mongoose");

const codeOrderSchema = new mongoose.Schema({
    store:        { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
    cardType:     { type: mongoose.Schema.Types.ObjectId, ref: "CardType", required: true },
    quantity:     { type: Number, required: true },
    
    // ✅ نوع التسليم
    deliveryType: {
        type:    String,
        enum:    ["physical", "digital"],  // ورقي / رقمي
        default: "physical",
    },

    status: {
        type:    String,
        enum:    ["pending", "configured", "received", "rejected"],
        default: "pending",
    },

    codes:        [{ type: mongoose.Schema.Types.ObjectId, ref: "PromoCode" }],
    configuredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    configuredAt: { type: Date },
    receivedAt:   { type: Date },

}, { timestamps: true });

module.exports = mongoose.model("CodeOrder", codeOrderSchema);