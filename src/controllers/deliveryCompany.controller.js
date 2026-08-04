const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../models/deliveryCompanyPaymentAccount");
const { toCustomerCompany, sortCompaniesByRegionRecommendation } = require("../services/deliveryCompany.service");
const { requireObjectId } = require("../utils/inputSecurity.util");

function parseOptionalRegionId(raw) {
  if (!raw) return null;
  try {
    return String(requireObjectId(raw, "regionId"));
  } catch {
    return null;
  }
}

exports.listActive = async (req, res) => {
  try {
    const regionId = parseOptionalRegionId(req.query.regionId);

    const companies = await DeliveryCompany.find({ isActive: true, deletedAt: null })
      .sort({ name: 1 })
      .lean();

    if (!companies.length) {
      return res.json([]);
    }

    const ids = companies.map((c) => c._id);
    const accounts = await DeliveryCompanyPaymentAccount.find({
      deliveryCompany: { $in: ids },
      isActive: true,
    }).lean();

    const byCompany = accounts.reduce((acc, row) => {
      const key = String(row.deliveryCompany);
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const entries = companies.map((company) => ({
      company,
      accounts: byCompany[String(company._id)] || [],
    }));

    const payload = regionId
      ? sortCompaniesByRegionRecommendation(entries, regionId)
      : entries.map(({ company, accounts }) => toCustomerCompany(company, accounts));

    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
