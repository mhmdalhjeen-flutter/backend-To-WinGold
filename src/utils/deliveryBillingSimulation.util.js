function isBillingSimulationAllowed() {
  return process.env.ALLOW_DELIVERY_BILLING_SIMULATION === "true";
}

module.exports = {
  isBillingSimulationAllowed,
};
