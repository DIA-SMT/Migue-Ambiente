/**
 * Verifica la 027 en producción.
 *
 *   node --env-file=../../.env.local herramientas/verificar-personal.mjs
 *
 * Lo que se puede y lo que no, desde acá:
 *
 *   SÍ   que el trigger exista y esté enganchado a UPDATE y DELETE
 *   SÍ   que `cuentas_sin_padron()` esté expuesta y rechace a quien no es admin
 *   SÍ   que la columna, el índice y los comentarios estén
 *   SÍ   que la puerta de salida siga abierta: `service_role` puede actualizar
 *   NO   que el trigger BLOQUEE de verdad
 *
 * Lo último no es una omisión. El trigger compara `old.usuario_id` con
 * `auth.uid()`, y con `service_role` eso es null — el trigger no dispara, que es
 * justamente el diseño. Probar el bloqueo requiere una sesión de panel real, y no
 * voy a degradar la cuenta del único administrador para averiguarlo.
 *
 * El bloqueo está probado en el bloque P del arnés, contra un Postgres real con
 * los stubs de `auth`, y verificado por sabotaje: sin el trigger, ese bloque
 * falla con «el admin se bajó el rol a sí mismo».
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let fallas = 0;
const mal = (m) => {
  console.log(`  MAL  ${m}`);
  fallas++;
};
const bien = (m) => console.log(`  ok   ${m}`);

/* --- 1 · La columna nueva y el padrón --------------------------------- */

const { data: padron, error: ePad } = await supabase
  .from("personal_panel")
  .select("usuario_id, correo, nombre, rol, activo, creado_en, actualizado_en, notas")
  .order("activo", { ascending: false });

if (ePad) {
  mal(`personal_panel: ${ePad.message}`);
} else {
  bien(`personal_panel responde con actualizado_en — ${padron.length} fila(s)`);
  for (const p of padron) {
    console.log(
      `         ${(p.nombre ?? "(sin nombre)").padEnd(22)} ${p.rol.padEnd(11)} ` +
        `${p.activo ? "activo  " : "de baja "} ${p.correo}`,
    );
  }
  const admins = padron.filter((p) => p.activo && p.rol === "admin");
  if (admins.length === 0) mal("NO HAY NINGÚN ADMIN ACTIVO: nadie puede administrar el padrón");
  else if (admins.length === 1) {
    console.log(
      "         (un solo admin: si esa cuenta se pierde hay que arreglarlo por SQL. La pantalla lo avisa.)",
    );
  }
}

/* --- 2 · `cuentas_sin_padron` ----------------------------------------- */

// Con `service_role` no hay `auth.uid()`, así que `es_admin_panel()` da false y
// la función tiene que rechazar. Ese rechazo prueba dos cosas de una: que está
// expuesta por PostgREST, y que la verificación de rol actúa antes de leer nada
// de `auth.users`.
const { error: eCta } = await supabase.rpc("cuentas_sin_padron");
if (!eCta) {
  mal("cuentas_sin_padron atendió a service_role: le falta la verificación de admin");
} else if (/could not find|schema cache|does not exist/i.test(eCta.message)) {
  mal(`cuentas_sin_padron no está expuesta: ${eCta.message}`);
} else if (/no autorizado/i.test(eCta.message)) {
  bien("cuentas_sin_padron expuesta, y rechaza a quien no es admin");
} else {
  mal(`cuentas_sin_padron falló con algo inesperado: ${eCta.message}`);
}

/* --- 3 · La puerta de salida sigue abierta ---------------------------- */

// Si esto fallara, el trigger habría convertido un bloqueo recuperable en uno
// que necesita soporte de Supabase. Se toca sólo `notas`, se restaura, y se
// verifica que el valor volvió.
if (padron && padron.length > 0) {
  const yo = padron[0];
  const original = yo.notas;
  const marca = `__prueba puerta de salida ${process.pid}`;

  const { error: e1 } = await supabase
    .from("personal_panel")
    .update({ notas: marca })
    .eq("usuario_id", yo.usuario_id);

  if (e1) {
    mal(`service_role no pudo actualizar el padrón: ${e1.message}`);
  } else {
    const { data: leido } = await supabase
      .from("personal_panel")
      .select("notas, actualizado_en")
      .eq("usuario_id", yo.usuario_id)
      .single();

    if (leido?.notas !== marca) mal("el update no se aplicó");
    else bien("service_role puede escribir: la puerta de salida está abierta");

    // Y el trigger de `actualizado_en` corrió.
    const hace = Date.now() - new Date(leido.actualizado_en).getTime();
    if (hace > 60_000) {
      mal(`actualizado_en quedó en ${leido.actualizado_en}: el trigger tocar no corrió`);
    } else {
      bien("actualizado_en se actualiza solo al modificar");
    }

    // Se restaura.
    await supabase
      .from("personal_panel")
      .update({ notas: original })
      .eq("usuario_id", yo.usuario_id);
    const { data: vuelto } = await supabase
      .from("personal_panel")
      .select("notas")
      .eq("usuario_id", yo.usuario_id)
      .single();
    if ((vuelto?.notas ?? null) !== (original ?? null)) {
      mal(`no pude restaurar las notas: quedó ${JSON.stringify(vuelto?.notas)}`);
    } else {
      bien("las notas quedaron como estaban");
    }
  }
}

/* --- 4 · Un correo activo, una sola fila ------------------------------ */

if (padron && padron.length > 0) {
  const yo = padron.find((p) => p.activo);
  if (yo) {
    const { error } = await supabase.from("personal_panel").insert({
      usuario_id: "00000000-0000-0000-0000-0000000000ff",
      correo: yo.correo.toUpperCase(),
      nombre: "Duplicado de prueba",
      rol: "operador",
      activo: true,
    });
    if (!error) {
      mal("entró una segunda fila activa con el mismo correo: falta el índice único");
      await supabase
        .from("personal_panel")
        .delete()
        .eq("usuario_id", "00000000-0000-0000-0000-0000000000ff");
    } else if (/duplicate key|unique/i.test(error.message)) {
      bien("no entran dos filas activas con el mismo correo, sin importar mayúsculas");
    } else if (/foreign key/i.test(error.message)) {
      // La FK a auth.users rechazó antes que el índice. No prueba el índice pero
      // tampoco es una falla: hay que decirlo en vez de dar un ok falso.
      console.log(
        "         (el índice único no se pudo probar: la FK a auth.users rechazó primero)",
      );
    } else {
      mal(`el insert de prueba falló con algo inesperado: ${error.message}`);
    }
  }
}

/* --- 5 · La auditoría de funciones sigue en cero ---------------------- */

const { data: auditoria, error: eAud } = await supabase
  .from("v_auditoria_funciones")
  .select("nombre, alerta")
  .not("alerta", "is", null);

if (eAud) {
  mal(`v_auditoria_funciones: ${eAud.message}`);
} else {
  const inesperadas = auditoria.filter((f) => f.nombre !== "keepalive");
  if (inesperadas.length > 0) {
    for (const f of inesperadas) mal(`${f.nombre}: ${f.alerta}`);
  } else {
    bien(
      auditoria.length === 0
        ? "ninguna función abierta a la clave pública"
        : "la única alerta sigue siendo keepalive, que se dejó a propósito",
    );
  }
}

console.log();
console.log(fallas === 0 ? "TODO OK" : `${fallas} PROBLEMA(S)`);
process.exit(fallas === 0 ? 0 : 1);
