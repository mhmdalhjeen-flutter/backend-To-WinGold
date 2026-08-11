// controllers/codeOrder.controller.js
const CodeOrder = require("../models/codeOrder");
const CardType  = require("../models/cardType");
const Store     = require("../models/store");
const PromoCode = require("../models/promoCode");
const storeCardInventoryService = require("../services/storeCardInventory.service");
const crypto    = require("crypto");
const { generatePromoCodeString } = require("../utils/promoCode.util");
const { buildGiftCodesExcelBuffer, buildGiftCodesExportFilename } = require("../utils/giftCodeExcelExport.util");
const { CARD_SOURCES } = require("../constants/storeSubscription.constants");
const { assertNoMongoOperators, cleanString, intInRange, requireObjectId } = require("../utils/inputSecurity.util");
const { safeLog } = require("../utils/logSanitize.util");

const DEFAULT_ORDER_LIST_LIMIT = 200;
const MAX_ORDER_LIST_LIMIT = 500;

function buildOrderListQuery(baseFilter, req) {
  const filter = { ...baseFilter };
  const limit = Math.min(
    intInRange(req.query.limit, { field: "limit", min: 1, max: MAX_ORDER_LIST_LIMIT }) || DEFAULT_ORDER_LIST_LIMIT,
    MAX_ORDER_LIST_LIMIT
  );
  return { filter, limit };
}

async function buildOrderListQueryAsync(baseFilter, req) {
  const { filter, limit } = buildOrderListQuery(baseFilter, req);

  if (req.query.cursor) {
    const cursorDoc = await CodeOrder.findById(requireObjectId(req.query.cursor, "cursor"))
      .select("createdAt")
      .lean();
    if (cursorDoc?.createdAt) {
      filter.createdAt = { $lt: cursorDoc.createdAt };
    }
  }

  return { filter, limit };
}

// ─────────────────────────────────────────────────────────────────────────────
// صاحب المتجر: طلب شراء أكواد (مع اختيار ورقي أو رقمي)
// ─────────────────────────────────────────────────────────────────────────────
exports.createCodeOrder = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "codeOrder");
        const { cardTypeId, quantity, deliveryType } = req.body;

        if (!cardTypeId || !quantity || quantity <= 0)
            return res.status(400).json({ message: "نوع الكرت والكمية مطلوبان" });

        if (!["physical", "digital"].includes(deliveryType))
            return res.status(400).json({ message: "نوع التسليم غير صحيح" });

        const store = await Store.findOne({ owner: req.user.id, isActive: true });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });

        const safeCardTypeId = requireObjectId(cardTypeId, "cardTypeId");
        const safeQuantity = intInRange(quantity, { field: "quantity", min: 1, max: 10000, required: true });
        const safeDeliveryType = cleanString(deliveryType, { field: "deliveryType", max: 20, required: true });
        if (!["physical", "digital"].includes(safeDeliveryType))
            return res.status(400).json({ message: "نوع التسليم غير صحيح" });

        const cardType = await CardType.findById(safeCardTypeId);
        if (!cardType) return res.status(404).json({ message: "نوع الكرت غير موجود" });

        const order = await CodeOrder.create({
            store:        store._id,
            cardType:     safeCardTypeId,
            quantity:     safeQuantity,
            deliveryType: safeDeliveryType,
        });

        res.status(201).json({ message: "تم إرسال الطلب للأدمن بنجاح", order });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// صاحب المتجر: جلب طلباته
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyOrders = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id, isActive: true });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر" });

        const { filter, limit } = await buildOrderListQueryAsync({ store: store._id }, req);

        const orders = await CodeOrder.find(filter)
            .populate("cardType", "name price points color")
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json({ orders });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// صاحب المتجر: حذف طلب pending فقط
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteMyOrder = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id, isActive: true });
        const id = requireObjectId(req.params.id, "id");
        const order = await CodeOrder.findById(id);
        if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
        if (order.store.toString() !== store._id.toString())
            return res.status(403).json({ message: "غير مسموح" });
        if (order.status !== "pending")
            return res.status(400).json({ message: "لا يمكن حذف طلب تم تكوينه" });

        await order.deleteOne();
        res.json({ message: "تم حذف الطلب" });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// أدمن: جلب كل الطلبات
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllOrders = async (req, res) => {
    try {
        const { filter, limit } = await buildOrderListQueryAsync({}, req);

        const orders = await CodeOrder.find(filter)
            .populate("store", "name phone whatsapp address")
            .populate("cardType", "name price points color")
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        res.json({ orders });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// أدمن: تكوين الأكواد
// ✅ رقمي  → يولد أكواد ويضيفها مباشرة لرصيد المتجر (store.cards)
// ✅ ورقي  → يولد أكواد فقط للتصدير ولا يلمس رصيد المتجر
// ─────────────────────────────────────────────────────────────────────────────
exports.configureOrder = async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const order = await CodeOrder.findById(id).populate("cardType");
        if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
        if (order.status === "configured")
            return res.status(400).json({ message: "تم تكوين هذا الطلب مسبقاً" });

        const storeDoc = await Store.findById(order.store);
        if (!storeDoc?.codePrefix) {
            return res.status(400).json({ message: "المتجر لا يملك بصمة أكواد" });
        }

        // توليد الأكواد
        const newCodes = [];
        for (let i = 0; i < order.quantity; i++) {
            newCodes.push({
                code:          generatePromoCodeString(storeDoc.codePrefix),
                rewardPoints:  order.cardType.points,
                rewardEntries: 1,
                store:         order.store,
                createdBy:     req.user.id,
                cardSource:    CARD_SOURCES.INDEPENDENT,
            });
        }
        const created = await PromoCode.insertMany(newCodes);

        order.status       = "configured";
        order.codes        = created.map(c => c._id);
        order.configuredBy = req.user.id;
        order.configuredAt = new Date();
        await order.save();

        // ✅ رقمي: أضف الكروت مباشرة لرصيد المتجر وغيّر الحالة لـ received تلقائياً
        if (order.deliveryType === "digital") {
            await storeCardInventoryService.addCardsToStore(order.store, {
                cardType: order.cardType._id,
                pointsValue: order.cardType.pointsValue ?? order.cardType.points ?? 1,
                quantity: order.quantity,
                source: CARD_SOURCES.INDEPENDENT,
            });
            order.status     = "received";
            order.receivedAt = new Date();
            await order.save();

            return res.json({
                message: `✅ رقمي: تم تكوين ${order.quantity} كرت وإضافتها مباشرة لرصيد المتجر`,
                codes:   created,
                digital: true,
            });
        }

        // ورقي: فقط أكواد جاهزة للتصدير
        res.json({
            message: `تم تكوين ${order.quantity} كود بنجاح — جاهز للتصدير والطباعة`,
            codes:   created,
            digital: false,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// أدمن: تأكيد استلام الكروت الورقية من المتجر
// ✅ عند الاستلام الورقي: أضف الكروت لرصيد المتجر
// ─────────────────────────────────────────────────────────────────────────────
exports.markAsReceived = async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const order = await CodeOrder.findById(id);
        if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
        if (order.status !== "configured")
            return res.status(400).json({ message: "الطلب لم يتم تكوينه بعد" });
        if (order.deliveryType === "digital")
            return res.status(400).json({ message: "الطلب الرقمي يُضاف تلقائياً" });

        // ✅ أضف الكروت لرصيد المتجر عند تأكيد استلام الورقي
        const populated = await CodeOrder.findById(id).populate("cardType");
        await storeCardInventoryService.addCardsToStore(order.store, {
            cardType: populated.cardType._id,
            pointsValue: populated.cardType.pointsValue ?? populated.cardType.points ?? 1,
            quantity: order.quantity,
            source: CARD_SOURCES.INDEPENDENT,
        });

        order.status     = "received";
        order.receivedAt = new Date();
        await order.save();

        res.json({ message: "تم تأكيد الاستلام وإضافة الكروت لرصيد المتجر" });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// أدمن: تصدير Excel (Store Name | Gift Code | QR Value)
// ─────────────────────────────────────────────────────────────────────────────
exports.exportOrderCodes = async (req, res) => {
    try {
        const id = requireObjectId(req.params.id, "id");
        const order = await CodeOrder.findById(id)
            .populate({ path: "codes", model: "PromoCode" })
            .populate("cardType", "name points")
            .populate("store", "name");

        if (!order) return res.status(404).json({ message: "الطلب غير موجود" });
        if (order.deliveryType === "digital")
            return res.status(400).json({ message: "الطلبات الرقمية لا تتطلب تصدير Excel" });
        if (!order.codes || order.codes.length === 0)
            return res.status(400).json({ message: "لا توجد أكواد لهذا الطلب" });

        const storeName = order.store?.name || "";
        const codes = order.codes.map((promoCode) => ({
            code: promoCode.code,
            source: promoCode.cardSource || CARD_SOURCES.INDEPENDENT,
        }));
        const xlsxBuffer = await buildGiftCodesExcelBuffer({ codes, storeName });

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${buildGiftCodesExportFilename(storeName)}"`);
        res.send(xlsxBuffer);

    } catch (err) {
        safeLog("error", "code_order_export_failed", {
            message: err.message,
            stack: err.stack,
            userId: req.user?.id,
        });
        res.status(500).json({ message: "تعذّر تصدير الأكواد" });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// أدمن: توليد أكواد مباشرة لمتجر (رقمي + ورقي)
// ─────────────────────────────────────────────────────────────────────────────
exports.generateDirectStoreCodes = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "directCodeGen");
        const { storeId, digitalQuantity, physicalQuantity, pointsPerCard } = req.body;

        const safeStoreId = requireObjectId(storeId, "storeId");
        const digitalQty = intInRange(digitalQuantity ?? 0, { field: "digitalQuantity", min: 0, max: 10000 });
        const physicalQty = intInRange(physicalQuantity ?? 0, { field: "physicalQuantity", min: 0, max: 10000 });
        const points = intInRange(pointsPerCard, { field: "pointsPerCard", min: 1, max: 1_000_000, required: true });

        if (digitalQty === 0 && physicalQty === 0)
            return res.status(400).json({ message: "أدخل كمية رقمية أو ورقية أكبر من صفر" });

        const storeDoc = await Store.findById(safeStoreId);
        if (!storeDoc) return res.status(404).json({ message: "المتجر غير موجود" });
        if (!storeDoc.codePrefix)
            return res.status(400).json({ message: "المتجر لا يملك بصمة أكواد" });

        const buildCode = () => ({
            code:          generatePromoCodeString(storeDoc.codePrefix),
            rewardPoints:  points,
            rewardEntries: 1,
            store:         safeStoreId,
            createdBy:     req.user.id,
            cardSource:    CARD_SOURCES.INDEPENDENT,
        });

        const digitalPayload = Array.from({ length: digitalQty }, buildCode);
        const physicalPayload = Array.from({ length: physicalQty }, buildCode);
        const allPayload = [...digitalPayload, ...physicalPayload];
        const created = await PromoCode.insertMany(allPayload);

        const digitalCodes = created.slice(0, digitalQty);
        const physicalCodes = created.slice(digitalQty);

        if (digitalQty > 0) {
            await storeCardInventoryService.addCardsToStore(safeStoreId, {
                cardType: null,
                pointsValue: points,
                quantity: digitalQty,
                source: CARD_SOURCES.INDEPENDENT,
            });
        }

        res.status(201).json({
            message: `تم توليد ${digitalQty} رقمي + ${physicalQty} ورقي`,
            storeId: safeStoreId,
            storeName: storeDoc.name,
            digitalCodes,
            physicalCodes,
            pointsPerCard: points,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// أدمن: تصدير Excel لأكواد ورقية (توليد مباشر)
// ─────────────────────────────────────────────────────────────────────────────
exports.exportDirectPhysicalCodes = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "physicalExport");
        const { storeId, codes } = req.body;

        const safeStoreId = requireObjectId(storeId, "storeId");
        if (!Array.isArray(codes) || codes.length === 0)
            return res.status(400).json({ message: "لا توجد أكواد للتصدير" });

        const storeDoc = await Store.findById(safeStoreId).select("name");
        if (!storeDoc) return res.status(404).json({ message: "المتجر غير موجود" });

        const codeStrings = codes.slice(0, 500).map((c) => {
            if (typeof c === "string") return { code: c, source: CARD_SOURCES.INDEPENDENT };
            return { code: c?.code, source: c?.cardSource || CARD_SOURCES.INDEPENDENT };
        }).filter((row) => row.code);

        if (!codeStrings.length)
            return res.status(400).json({ message: "لا توجد أكواد صالحة للتصدير" });

        const xlsxBuffer = await buildGiftCodesExcelBuffer({
            codes: codeStrings,
            storeName: storeDoc.name,
        });

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${buildGiftCodesExportFilename(storeDoc.name)}"`);
        res.send(xlsxBuffer);
    } catch (err) {
        safeLog("error", "direct_physical_export_failed", { message: err.message, userId: req.user?.id });
        res.status(500).json({ message: "تعذّر تصدير Excel" });
    }
};