const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text:         { type: String, default: "" },
    image:        { type: String, default: null },
    replyTo: {
        messageId:  { type: mongoose.Schema.Types.ObjectId, default: null },
        text:       { type: String, default: null },
        senderName: { type: String, default: null },
    },
    read:      { type: Boolean, default: false },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 4 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ conversation: 1, read: 1, sender: 1 });

module.exports = mongoose.model("Message", messageSchema);