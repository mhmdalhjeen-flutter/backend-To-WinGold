const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../src/models/store");

test("store isOpen defaults to true (open)", () => {
  assert.equal(Store.schema.path("isOpen").instance, "Boolean");
  assert.equal(Store.schema.path("isOpen").options.default, true);
});

test("store isOpen is independent of admin isActive", () => {
  assert.equal(Store.schema.path("isActive").options.default, false);
  assert.equal(Store.schema.path("isOpen").options.default, true);
});
