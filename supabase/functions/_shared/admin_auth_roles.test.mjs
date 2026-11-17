import assert from "node:assert/strict";
import test from "node:test";
import { hasAdminRoleAccess } from "./admin_auth_roles.ts";

test("owner and admin pass both access levels", () => {
  for (const role of ["owner", "admin"]) {
    assert.equal(hasAdminRoleAccess(role, "admin"), true);
    assert.equal(hasAdminRoleAccess(role, "staff"), true);
  }
});

test("operator passes staff access but not admin access", () => {
  assert.equal(hasAdminRoleAccess("operator", "staff"), true);
  assert.equal(hasAdminRoleAccess("operator", "admin"), false);
});

test("unknown, malformed and non-member roles fail closed", () => {
  for (const role of ["customer", "", "Admin", null, undefined, 1]) {
    assert.equal(hasAdminRoleAccess(role, "admin"), false);
    assert.equal(hasAdminRoleAccess(role, "staff"), false);
  }
});
