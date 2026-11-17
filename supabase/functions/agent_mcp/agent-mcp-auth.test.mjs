import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUserBearer, IdentityError, resolveStaffIdentity } from "./agent-mcp-auth.ts";

const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"forged"}').toString("base64url")}.signature`;

test("extractUserBearer acepta sólo Bearer con forma compacta JWT", () => {
    assert.equal(extractUserBearer(new Request("https://example.test", { headers: { authorization: `Bearer ${jwt}` } })), jwt);
    assert.equal(extractUserBearer(new Request("https://example.test", { headers: { "x-agent-secret": "legacy-shared-secret" } })), null);
    assert.equal(extractUserBearer(new Request("https://example.test", { headers: { authorization: "Bearer shared-secret" } })), null);
    assert.equal(extractUserBearer(new Request("https://example.test", { headers: { authorization: `Bearer ${jwt} trailing` } })), null);
    assert.equal(extractUserBearer(new Request("https://example.test")), null);
});

function mockClients({ authError = null, userId = "verified-auth-subject", membership = { role: "operator" }, membershipError = null } = {}) {
    const authClient = {
        auth: {
            getUser: async (token) => {
                assert.equal(token, jwt);
                return { data: { user: authError ? null : { id: userId } }, error: authError };
            },
        },
    };
    const membershipClient = {
        from(table) {
            assert.equal(table, "admin_users");
            return {
                select(columns) {
                    assert.equal(columns, "role");
                    return {
                        eq(column, value) {
                            assert.equal(column, "user_id");
                            assert.equal(value, userId, "membership lookup derives from verified Auth subject");
                            return {
                                maybeSingle: async () => ({ data: membership, error: membershipError }),
                            };
                        },
                    };
                },
            };
        },
    };
    return { authClient, membershipClient };
}

test("resolveStaffIdentity usa sub verificado y rol actual, no role enviado por cliente", async () => {
    for (const role of ["owner", "admin", "operator"]) {
        const { authClient, membershipClient } = mockClients({ membership: { role } });
        assert.deepEqual(await resolveStaffIdentity(authClient, membershipClient, jwt), {
            userId: "verified-auth-subject",
            role,
        });
    }
});

test("resolveStaffIdentity rechaza token inválido/expirado y usuario sin membresía", async () => {
    const invalid = mockClients({ authError: new Error("expired") });
    await assert.rejects(
        () => resolveStaffIdentity(invalid.authClient, invalid.membershipClient, jwt),
        (error) => error instanceof IdentityError && error.status === 401,
    );

    const nonMember = mockClients({ membership: null });
    await assert.rejects(
        () => resolveStaffIdentity(nonMember.authClient, nonMember.membershipClient, jwt),
        (error) => error instanceof IdentityError && error.status === 403,
    );

    const invalidRole = mockClients({ membership: { role: "owner-from-client" } });
    await assert.rejects(
        () => resolveStaffIdentity(invalidRole.authClient, invalidRole.membershipClient, jwt),
        (error) => error instanceof IdentityError && error.status === 403,
    );
});

test("fallo al leer la membresía no degrada a service-role ni a rol por defecto", async () => {
    const unavailable = mockClients({ membershipError: new Error("database unavailable") });
    await assert.rejects(
        () => resolveStaffIdentity(unavailable.authClient, unavailable.membershipClient, jwt),
        (error) => error instanceof IdentityError && error.status === 503,
    );
});
