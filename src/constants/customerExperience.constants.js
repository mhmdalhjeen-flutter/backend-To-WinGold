/** Roles allowed to use the customer PWA / customer-facing APIs. */
const CUSTOMER_EXPERIENCE_ROLES = Object.freeze([
  "customer",
  "store",
  "supplier",
  "delivery_company",
  "delivery_driver",
]);

function isCustomerExperienceRole(role) {
  return CUSTOMER_EXPERIENCE_ROLES.includes(role);
}

module.exports = {
  CUSTOMER_EXPERIENCE_ROLES,
  isCustomerExperienceRole,
};
