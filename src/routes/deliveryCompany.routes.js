const express = require("express");
const deliveryCompanyController = require("../controllers/deliveryCompany.controller");

const router = express.Router();

/** Public catalog — active companies only; regionId is ignored for filtering (recommendation only). */
router.get("/", deliveryCompanyController.listActive);

module.exports = router;
