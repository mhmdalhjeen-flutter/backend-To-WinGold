const mongoose = require("mongoose");

const systemSettingSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        // مثل: "rank_thresholds"
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
        // مثال: { silver: 10, gold: 50, platinum: 100 }
    },
    description: {
        type: String
    }
}, { timestamps: true });

module.exports = mongoose.model("SystemSetting", systemSettingSchema);
