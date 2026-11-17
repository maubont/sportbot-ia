#!/usr/bin/env node
// SB-108: pruebas rigurosas de quick_answers (respuestas rápidas con `/`).
//
// Cada escenario corre en su propia transacción (BEGIN/COMMIT) para aislar
// errores esperados. Patrón idéntico a scripts/verify-human-messaging-sql.mjs
// (PGlite + assert).
//   * is_admin() se mockea a TRUE.
//   * auth.uid() se mockea como el operador actor (constante ACTOR). Por eso
//   todas las creaciones vía RPC usan user_id=ACTOR; para probar aislamiento de
//   otro operador se inserta directamente en SQL con user_id=OTERO y se verifica
//   que no aparece al listar como ACTOR.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261103120000_quick_answers.sql"), "utf8");
const db = new PGlite();

const ACTOR = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const OWNER = "00000000-0000-4000-8000-000000000003";
const NOADMIN = "00000000-0000-4000-8000-000000000008";

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT '${ACTOR}'::uuid $$;
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
CREATE TABLE public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','operator'))
);
CREATE TABLE public.quick_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.admin_users(user_id) ON DELETE CASCADE,
    shortcut TEXT NOT NULL CHECK (length(trim(shortcut)) > 0),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    is_global BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

await db.exec(schema);
await db.exec(migration);

// Datos base (autocommit los persiste).
await db.query(`BEGIN`);
await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'actor@example.test'),($2,'other@example.test'),($3,'owner@example.test'),($4,'noadmin@example.test')`, [ACTOR, OTHER, OWNER, NOADMIN]);
await db.query(`INSERT INTO public.admin_users (user_id,email,role) VALUES ($1,'actor@example.test','operator'),($2,'other@example.test','operator'),($3,'owner@example.test','owner'),($4,'noadmin@example.test','operator')`, [ACTOR, OTHER, OWNER, NOADMIN]);
await db.query(`COMMIT`);

let checks = 0;
async function check(name, run) {
    await db.query(`BEGIN`);
    try {
        await run();
        await db.query(`COMMIT`);
        checks++;
        console.log(`✓ ${name}`);
    } catch (err) {
        await db.query(`ROLLBACK`).catch(() => undefined);
        console.error(`✖ ${name}: ${err.message}`);
        throw err;
    }
}

// Tabla existe con RLS activa y atajos únicos.
await check("tabla quick_answers con RLS y atajos únicos", async () => {
    const rel = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='quick_answers'`);
    assert.equal(rel.rows[0].relrowsecurity, true);
    const idxGlobal = await db.query(`
        SELECT indexname FROM pg_indexes WHERE tablename='quick_answers' AND indexname='idx_quick_answers_global_shortcut'
    `);
    const idxUser = await db.query(`
        SELECT indexname FROM pg_indexes WHERE tablename='quick_answers' AND indexname='idx_quick_answers_user_shortcut'
    `);
    assert.equal(idxGlobal.rows.length, 1);
    assert.equal(idxUser.rows.length, 1);
});

// Operador crea su propia plantilla (atajo único por check).
await check("operador crea plantilla propia", async () => {
    const res = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '/hola-a', 'Hola {cliente}, ¿en qué te ayudo?', false]);
    assert.equal(res.rows[0].result.success, true);
    assert.equal(res.rows[0].result.shortcut, '/hola-a');
    assert.equal(res.rows[0].result.body, 'Hola {cliente}, ¿en qué te ayudo?');
    assert.equal(res.rows[0].result.is_global, false);
    assert.ok(res.rows[0].result.id);
});

// Plantilla insertada directamente de otro operador no aparece al listar como actor.
await check("plantilla de otro operador no aparece al listar", async () => {
    await db.query(`INSERT INTO public.quick_answers (user_id, shortcut, body, is_global) VALUES ($1,'/precio-other','Precio de {producto}',false)`, [OTHER]);
    const { rows } = await db.query(`SELECT * FROM public.admin_list_quick_answers($1)`, [ACTOR]);
    const shortcuts = rows.map((r) => r.shortcut);
    assert.ok(!shortcuts.includes('/precio-other'), 'plantilla de otro operador no debe aparecer');
});

// Operador no puede crear plantilla global (solo owner/admin).
await check("operador no crea plantilla global", async () => {
    const res = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '/global-a', 'plantilla global', true]);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'global_quick_answer_admin_only');
});

// Owner crea plantilla global.
await check("owner crea plantilla global", async () => {
    const res = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [OWNER, '/global-a', 'plantilla global del owner', true]);
    assert.equal(res.rows[0].result.success, true);
    assert.equal(res.rows[0].result.is_global, true);
});

// Listar devuelve propias del actor + globales (no ajenas).
await check("listar devuelve propias del actor y globales", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_list_quick_answers($1)`, [ACTOR]);
    const shortcuts = rows.map((r) => r.shortcut);
    assert.ok(shortcuts.includes('/hola-a'), '/hola-a propia del actor');
    assert.ok(shortcuts.includes('/global-a'), '/global-a visible para el actor');
});

// Rechaza listar de otro operador (auth.uid()).
await check("rechaza listar quick answers de otro operador", async () => {
    await assert.rejects(
        db.query(`SELECT * FROM public.admin_list_quick_answers($1)`, [OTHER]),
        /only accepts the caller own user id/
    );
});

// Actualizar plantilla propia.
await check("operador actualiza su propia plantilla", async () => {
    const { rows } = await db.query(`SELECT id FROM public.quick_answers WHERE shortcut=$1 AND user_id=$2`, ['/hola-a', ACTOR]);
    const id = rows[0].id;
    const res = await db.query(`SELECT public.admin_update_quick_answer($1,$2,$3,$4,$5) AS result`, [id, ACTOR, '/hola-a', 'Hola {cliente}, ¿qué necesitas?', false]);
    assert.equal(res.rows[0].result.success, true);
    const { rows: upd } = await db.query(`SELECT body FROM public.quick_answers WHERE id=$1`, [id]);
    assert.equal(upd[0].body, 'Hola {cliente}, ¿qué necesitas?');
});

// No actualizar plantilla ajena (insertada de OTHER).
await check("no actualiza plantilla ajena", async () => {
    await db.query(`INSERT INTO public.quick_answers (user_id, shortcut, body, is_global) VALUES ($1,'/otra-ajena','cuerpo',false)`, [OTHER]);
    const { rows } = await db.query(`SELECT id FROM public.quick_answers WHERE shortcut=$1 AND user_id=$2`, ['/otra-ajena', OTHER]);
    const id = rows[0].id;
    const res = await db.query(`SELECT public.admin_update_quick_answer($1,$2,$3,$4,$5) AS result`, [id, ACTOR, '/otra-ajena', 'cambio', false]);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'not_quick_answer_owner');
});

// Eliminar plantilla propia.
await check("operador elimina su propia plantilla", async () => {
    const res = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '/tmp-a', 'temporal', false]);
    const id = res.rows[0].result.id;
    const del = await db.query(`SELECT public.admin_delete_quick_answer($1,$2) AS result`, [id, ACTOR]);
    assert.equal(del.rows[0].result.success, true);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.quick_answers WHERE id=$1`, [id]);
    assert.equal(rows[0].n, 0);
});

// No eliminar plantilla ajena.
await check("no elimina plantilla ajena", async () => {
    await db.query(`INSERT INTO public.quick_answers (user_id, shortcut, body, is_global) VALUES ($1,'/tmp-other','temporal otro',false)`, [OTHER]);
    const { rows } = await db.query(`SELECT id FROM public.quick_answers WHERE shortcut=$1 AND user_id=$2`, ['/tmp-other', OTHER]);
    const id = rows[0].id;
    const del = await db.query(`SELECT public.admin_delete_quick_answer($1,$2) AS result`, [id, ACTOR]);
    assert.equal(del.rows[0].result.success, false);
    assert.equal(del.rows[0].result.code, 'not_quick_answer_owner');
});

// Atajo duplicado propio se rechaza.
await check("rechaza atajo duplicado propio", async () => {
    await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '/dup-final', 'primero', false]);
    const res = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '/dup-final', 'segundo', false]);
    assert.equal(res.rows[0].result.success, false);
});

// Atajo vacío o cuerpo vacío se rechazan.
await check("rechaza atajo o cuerpo vacío", async () => {
    const emptyShortcut = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '   ', 'cuerpo', false]);
    assert.equal(emptyShortcut.rows[0].result.success, false);
    assert.equal(emptyShortcut.rows[0].result.code, 'invalid_quick_answer');
    const emptyBody = await db.query(`SELECT public.admin_create_quick_answer($1,$2,$3,$4) AS result`, [ACTOR, '/ok-final', '   ', false]);
    assert.equal(emptyBody.rows[0].result.success, false);
    assert.equal(emptyBody.rows[0].result.code, 'invalid_quick_answer');
});

// Privilegios de ejecución de RPCs.
await check("privilegios de ejecución de RPCs", async () => {
    const perms = await db.query(`
        SELECT
          has_function_privilege('authenticated','public.admin_create_quick_answer(uuid,text,text,boolean)','EXECUTE') AS auth_create,
          has_function_privilege('authenticated','public.admin_list_quick_answers(uuid)','EXECUTE') AS auth_list,
          has_function_privilege('anon','public.admin_create_quick_answer(uuid,text,text,boolean)','EXECUTE') AS anon_create,
          has_table_privilege('authenticated','public.quick_answers','INSERT') AS browser_insert,
          has_table_privilege('service_role','public.quick_answers','INSERT') AS service_insert
    `);
    assert.deepEqual(perms.rows[0], {
        auth_create: true, auth_list: true, anon_create: false,
        browser_insert: false, service_insert: true,
    });
});

await db.close();
console.log(`\n${checks} quick-answers SQL checks passed.`);
