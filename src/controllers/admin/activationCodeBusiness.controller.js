const ActivationCode = require("../../models/ActivationCode");
const Store = require("../../models/store");
const { assertNoMongoOperators, cleanString, requireObjectId } = require("../../utils/inputSecurity.util");

const PREFIX_CHARS = "abcdefghijklmnopqrstuvwxyz";
const SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomPart(chars, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function assignUniquePrefix() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const prefix = randomPart(PREFIX_CHARS, 3);
    const [inActivation, inStore] = await Promise.all([
      ActivationCode.exists({ prefix }),
      Store.exists({ codePrefix: prefix.toUpperCase() }),
    ]);
    if (!inActivation && !inStore) return prefix;
  }
  return `${randomPart(PREFIX_CHARS, 2)}${Date.now().toString(36).slice(-1)}`.slice(0, 3);
}

function buildActivationKey(prefix) {
  return `${prefix}-${randomPart(SUFFIX_CHARS, 6)}`;
}

/** POST /admin/create-code-business — إنشاء مفتاح تفعيل واحد (صاحب محل / تاجر) */
const createCodeBusiness = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "activationCode");
    const role = cleanString(req.body.role, { field: "role", max: 20, required: true });

    if (!["store", "supplier"].includes(role)) {
      return res.status(400).json({ message: "اختر نوع المفتاح: store (صاحب محل) أو supplier (تاجر)" });
    }

    const prefix = await assignUniquePrefix();
    let code = buildActivationKey(prefix);
    let tries = 0;
    while (tries < 10 && (await ActivationCode.exists({ code }))) {
      code = buildActivationKey(prefix);
      tries += 1;
    }

    const newCode = await ActivationCode.create({
      code,
      prefix,
      role,
      isUsed: false,
    });

    return res.status(201).json({
      message: "تم إنشاء مفتاح التفعيل",
      key: newCode,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

/** GET /admin/activation-keys */
const listActivationKeys = async (req, res) => {
  try {
    const keys = await ActivationCode.find()
      .sort({ createdAt: -1 })
      .populate("usedBy", "name phone email")
      .lean();
    res.json(keys);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** DELETE /admin/activation-keys/:id — حذف مفتاح غير مستخدم فقط */
const deleteActivationKey = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const key = await ActivationCode.findById(id);
    if (!key) return res.status(404).json({ message: "المفتاح غير موجود" });
    if (key.isUsed) {
      return res.status(400).json({ message: "لا يمكن حذف مفتاح مستخدم" });
    }
    await key.deleteOne();
    res.json({ message: "تم حذف المفتاح" });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

module.exports = {
  createCodeBusiness,
  listActivationKeys,
  deleteActivationKey,
};
