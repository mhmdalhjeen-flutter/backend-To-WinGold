const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyPaymentAccount = require("../models/deliveryCompanyPaymentAccount");
const { toCustomerCompany } = require("../services/deliveryCompany.service");

exports.listActive = async (_req, res) => {
  try {
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

    const payload = companies.map((company) =>
      toCustomerCompany(company, byCompany[String(company._id)] || []));

    res.json(payload);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
