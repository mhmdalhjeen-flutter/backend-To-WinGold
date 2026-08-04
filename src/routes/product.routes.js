const express = require("express");
const router  = express.Router();
const roleMiddleware = require("../middleware/role.middleware");
const authMiddleware = require("../middleware/auth.middleware");
const Product = require("../models/product");
const { requireOwnedStoreResource } = require("../middleware/ownership.middleware");
const { requireObjectId } = require("../utils/inputSecurity.util");
const { deliverStoredImage } = require("../utils/mediaDelivery.util");

const {
    createProduct,
    getStoreProducts,
    getWholesaleProducts,
    searchProducts,
    deleteProduct,
    toggleProductActive,
    updateProduct,
    getMyProducts,
} = require("../controllers/product.controller");

router.post("/", authMiddleware, roleMiddleware.businessOrAdmin, createProduct);

router.get("/my", authMiddleware, roleMiddleware.businessOrAdmin, getMyProducts);

router.get("/store/:storeId", getStoreProducts);

router.get("/wholesale", authMiddleware, roleMiddleware.businessOrAdmin, getWholesaleProducts);

router.get("/search", searchProducts);

router.get("/:id/image", async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const product = await Product.findById(id).select("image isActive").lean();
        if (!product?.isActive) {
            return res.status(404).end();
        }
        return deliverStoredImage(res, product.image);
    } catch (err) {
        if (err.name === "CastError") {
            return res.status(400).json({ message: "معرّف المنتج غير صحيح" });
        }
        return res.status(500).end();
    }
});

router.get("/:id", async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const product = await Product.findById(id)
            .populate("store", "name phone whatsapp region subRegion logo category owner");

        if (!product) {
            return res.status(404).json({ message: "العنصر غير موجود" });
        }

        if (product.isActive !== false) {
            await Product.findByIdAndUpdate(product._id, { $inc: { views: 1 } });
            product.views = (product.views || 0) + 1;
        }

        res.json({ product });
    } catch (err) {
        if (err.name === "CastError") {
            return res.status(400).json({ message: "معرّف المنتج غير صحيح" });
        }
        res.status(err.status || 500).json({ message: err.message });
    }
});

router.delete("/:id", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Product, "id", "المنتج غير موجود"), deleteProduct);

router.patch("/:id/toggle-active", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Product, "id", "المنتج غير موجود"), toggleProductActive);

router.put("/:id", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Product, "id", "المنتج غير موجود"), updateProduct);

module.exports = router;
