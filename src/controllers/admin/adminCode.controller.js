const AdminCode = require("../../models/AdminCode");
const { assertNoMongoOperators, intInRange, requireObjectId } = require("../../utils/inputSecurity.util");

const SUFFIX_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomPart(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)];
  }
  return out;
}

function buildAdminCode() {
  return `ADM-${randomPart(8)}`;
}

/** POST /admin/admin-codes/generate */
exports.generateAdminCodes = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "adminCode");
    const count = intInRange(req.body.count ?? 1, { field: "count", min: 1, max: 500 });
    const rewardPoints = intInRange(req.body.rewardPoints, { field: "rewardPoints", min: 1, max: 1_000_000, required: true });

    if (!Number.isFinite(rewardPoints) || rewardPoints < 1) {
      return res.status(400).json({ message: "عدد النقاط مطلوب (1 على الأقل)" });
    }

    const docs = [];
    const seen = new Set();

    while (docs.length < count) {
      let code = buildAdminCode();
      let tries = 0;
      while ((seen.has(code) || (await AdminCode.exists({ code }))) && tries < 12) {
        code = buildAdminCode();
        tries += 1;
      }
      if (seen.has(code)) continue;
      seen.add(code);
      docs.push({
        code,
        rewardPoints,
        isActive: true,
        maxUses: 1,
        currentUses: 0,
      });
    }

    const created = await AdminCode.insertMany(docs);

    return res.status(201).json({
      message: `تم إنشاء ${created.length} كود أدمن`,
      count: created.length,
      rewardPoints,
      codes: created,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

/** GET /admin/admin-codes */
exports.listAdminCodes = async (req, res) => {
  try {
    const codes = await AdminCode.find()
      .sort({ createdAt: -1 })
      .populate("usedBy.user", "name phone email")
      .lean();
    res.json(codes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** DELETE /admin/admin-codes/:id */
exports.deleteAdminCode = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const code = await AdminCode.findById(id);
    if (!code) return res.status(404).json({ message: "الكود غير موجود" });
    if (code.currentUses > 0) {
      return res.status(400).json({ message: "لا يمكن حذف كود مستخدم" });
    }
    await code.deleteOne();
    res.json({ message: "تم حذف الكود" });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};
