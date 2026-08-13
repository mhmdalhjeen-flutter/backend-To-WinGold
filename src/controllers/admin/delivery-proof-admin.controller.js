const deliveryProofService = require("../../services/deliveryProof.service");

exports.listOrders = async (req, res) => {
  try {
    const orders = await deliveryProofService.listProofOrders(
      {
        companyId: req.query.companyId,
        driverId: req.query.driverId,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
        verificationCode: req.query.verificationCode,
        customer: req.query.customer,
      },
      {
        includeCompany: true,
        limit: req.query.limit,
      },
    );
    res.json({ orders });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getOrderDetail = async (req, res) => {
  try {
    const detail = await deliveryProofService.getProofOrderDetail(
      req.params.sessionId,
      req.params.orderId,
      { includeCompany: true },
    );
    res.json({ order: detail });
  } catch (err) {
    res.status(err.status || 404).json({ message: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    const proofs = await deliveryProofService.listProofs(
      {
        companyId: req.query.companyId,
        driverId: req.query.driverId,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
        verificationCode: req.query.verificationCode,
        customer: req.query.customer,
      },
      {
        includeCompany: true,
        limit: req.query.limit,
      },
    );
    res.json({ proofs });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const proof = await deliveryProofService.getProofById(req.params.id, {
      includeCompany: true,
    });
    res.json({ proof });
  } catch (err) {
    res.status(err.status || 404).json({ message: err.message });
  }
};

exports.filterOptions = async (req, res) => {
  try {
    const options = await deliveryProofService.listProofFilterOptions();
    res.json(options);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
