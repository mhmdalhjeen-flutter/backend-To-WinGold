const mongoose = require("mongoose");

const userSuggestionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: ["new", "read", "archived"], default: "new", index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserSuggestion", userSuggestionSchema);
