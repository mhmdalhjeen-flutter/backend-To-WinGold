const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");

const {
    activateStore,
    createStoreActivationCode 
} = require("../controllers/activation.controller");

// 🟢 المستخدم يفعل متجره
router.post("/activate-store", authMiddleware, activateStore);

// 🟡 الأدمن ينشئ كود
router.post(
    "/create-code",
    authMiddleware,
    roleMiddleware(["admin"]),
    createStoreActivationCode
);

module.exports = router;