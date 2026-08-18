const mongoose = require("mongoose");

const reservationFieldSchema = new mongoose.Schema({
  id: { type: String, required: true, trim: true, maxlength: 80 },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  type: {
    type: String,
    enum: ["text", "phone", "number", "date", "time", "textarea", "note"],
    default: "text",
  },
  required: { type: Boolean, default: false },
  content: { type: String, default: "", trim: true, maxlength: 500 },
  order: { type: Number, default: 0 },
}, { _id: false });

const reservationSettingsSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  fields: { type: [reservationFieldSchema], default: [] },
}, { _id: false });

module.exports = { reservationFieldSchema, reservationSettingsSchema };
