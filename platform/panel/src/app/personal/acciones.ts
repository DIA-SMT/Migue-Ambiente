"use server";

/**
 * Quién entra al panel.
 *
 * Estas acciones tocan el control de acceso, así que el criterio es distinto al
 * del resto del panel: acá NO se traduce un error a un mensaje amable y se sigue.
 * Si algo falla, falla ruidosamente.
 *
 * Todo lo que decide de verdad lo decide la base:
 *
 *   · la política `personal_lo_gestiona_un_admin` (017) exige ser admin;
 *   · el trigger `personal_no_se_autobloquea` (027) impide que alguien se saque a
 *     sí mismo el rol, el estado o su fila;
 *   · `cuentas_sin_padron()` (027) es lo único que puede resolver un correo a su
 *     cuenta de Supabase, porque `auth.users` es inalcanzable por HTTP.
 *
 * Acá se chequea igual antes de llamar, pero eso es para dar un mensaje que se
 * entienda, no para proteger nada. La protección está en la base y se probó por
 * su efecto, no por la definición de la política.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import type { CuentaSinPadron, Persona, RolPanel } from "@/lib/tipos";

export interface Resultado {
  readonly ok: boolean;
  readonly mensaje: string;
}

const ROLES: readonly RolPanel[] = ["operador", "supervisor", "admin"];

async function conAdmin() {
  const persona = await personaActual();
  if (!persona) return null;
  // El rol lo trae `personaActual()` de la base, no de una cookie ni del cliente.
  if (persona.rol !== "admin") return { persona, esAdmin: false as const };
  return { persona, esAdmin: true as const, supabase: await clienteServidor() };
}

/**
 * Traduce lo que devuelve Postgres.
 *
 * El caso que importa es el 42501 del trigger: su mensaje ya está escrito en
 * castellano y explica qué hacer, así que se pasa TAL CUAL en lugar de
 * reemplazarlo por uno genérico. Un «no tenés permiso» ahí sería una regresión.
 */
function traducir(mensaje: string, codigo: string | undefined): string {
  if (/No podés/.test(mensaje)) return mensaje;
  if (codigo === "23505" || /duplicate key/i.test(mensaje)) {
    return "Ese correo ya está en el padrón y activo. Si la persona volvió al área, reactivá la fila que ya existe en lugar de crear otra.";
  }
  if (codigo === "42501" || /row-level security/i.test(mensaje)) {
    return "Administrar el padrón es una acción de administrador.";
  }
  if (codigo === "23514") {
    return `Ese rol no existe. Los válidos son: ${ROLES.join(", ")}.`;
  }
  if (codigo === "23503" || /foreign key/i.test(mensaje)) {
    return "Esa cuenta no existe en Supabase. Puede haber sido borrada mientras mirabas la lista: recargá la página.";
  }
  return mensaje;
}

function refrescar() {
  revalidatePath("/personal");
}

/* ---------------------------------------------------------------- leer --- */

/**
 * Las cuentas de Supabase que todavía no están en el padrón.
 *
 * Va por RPC porque es el único camino: PostgREST expone sólo `public` y
 * `graphql_public`, así que `auth.users` no se puede consultar ni con la clave
 * del sistema. La función devuelve únicamente las que faltan —no un listado de
 * usuarios— y nada que permita autenticarse.
 */
export async function cuentasSinPadron(): Promise<
  { ok: true; cuentas: CuentaSinPadron[] } | { ok: false; mensaje: string }
> {
  const acceso = await conAdmin();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (!acceso.esAdmin) {
    return { ok: false, mensaje: "Ver las cuentas pendientes es una acción de administrador." };
  }

  const { data, error } = await acceso.supabase.rpc("cuentas_sin_padron");
  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  return { ok: true, cuentas: (data ?? []) as CuentaSinPadron[] };
}

/* ------------------------------------------------------------ escribir --- */

/**
 * Da de alta en el padrón a alguien que YA tiene cuenta de Supabase.
 *
 * No crea la cuenta, y no puede: eso se hace en Supabase con Auto Confirm, y el
 * registro público está deshabilitado. Acá sólo se habilita el acceso al panel.
 */
export async function darDeAlta(entrada: {
  usuarioId: string;
  correo: string;
  nombre: string;
  rol: RolPanel;
  notas: string;
}): Promise<Resultado> {
  const acceso = await conAdmin();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (!acceso.esAdmin) {
    return { ok: false, mensaje: "Dar de alta a alguien es una acción de administrador." };
  }

  if (!ROLES.includes(entrada.rol)) {
    return { ok: false, mensaje: `Ese rol no existe. Los válidos son: ${ROLES.join(", ")}.` };
  }
  const nombre = entrada.nombre.trim();
  if (nombre === "") {
    // No es un capricho: la lista sin nombres es una lista de correos, y quien
    // revise quién tiene acceso dentro de seis meses no va a reconocer a nadie.
    return { ok: false, mensaje: "Poné el nombre de la persona: sin eso la lista no se puede leer." };
  }

  const { error } = await acceso.supabase.from("personal_panel").insert({
    usuario_id: entrada.usuarioId,
    correo: entrada.correo.trim().toLowerCase(),
    nombre,
    rol: entrada.rol,
    activo: true,
    creado_por: acceso.persona.usuarioId,
    notas: entrada.notas.trim() || null,
  });

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  refrescar();
  return {
    ok: true,
    mensaje: `${nombre} ya puede entrar al panel como ${entrada.rol}. Va a iniciar sesión con el correo y la contraseña que tenga en Supabase.`,
  };
}

export async function cambiarRol(usuarioId: string, rol: RolPanel): Promise<Resultado> {
  const acceso = await conAdmin();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (!acceso.esAdmin) {
    return { ok: false, mensaje: "Cambiar un rol es una acción de administrador." };
  }
  if (!ROLES.includes(rol)) {
    return { ok: false, mensaje: `Ese rol no existe. Los válidos son: ${ROLES.join(", ")}.` };
  }

  const { error, data } = await acceso.supabase
    .from("personal_panel")
    .update({ rol })
    .eq("usuario_id", usuarioId)
    .select("nombre, correo");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  // RLS no lanza cuando el UPDATE no alcanza ninguna fila: devuelve cero. Sin
  // este chequeo la pantalla diría «listo» y nada habría cambiado.
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "No se cambió nada. Puede ser un permiso, o la fila ya no existe." };
  }
  refrescar();
  return { ok: true, mensaje: `${data[0]!.nombre ?? data[0]!.correo} ahora es ${rol}.` };
}

/**
 * Da de baja o reactiva.
 *
 * NO borra la fila, y eso es la decisión de fondo: `activo` existe para que quede
 * el registro de que esa persona estuvo habilitada. Un padrón sin historia no es
 * auditable, y el control de acceso de un municipio tiene que serlo.
 */
export async function cambiarEstado(usuarioId: string, activo: boolean): Promise<Resultado> {
  const acceso = await conAdmin();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (!acceso.esAdmin) {
    return { ok: false, mensaje: "Dar de baja o reactivar es una acción de administrador." };
  }

  const { error, data } = await acceso.supabase
    .from("personal_panel")
    .update({ activo })
    .eq("usuario_id", usuarioId)
    .select("nombre, correo");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "No se cambió nada. Puede ser un permiso, o la fila ya no existe." };
  }
  refrescar();
  const quien = data[0]!.nombre ?? data[0]!.correo;
  return {
    ok: true,
    mensaje: activo
      ? `${quien} vuelve a tener acceso al panel.`
      : `${quien} ya no puede entrar. La fila queda, con el registro de que estuvo habilitado.`,
  };
}

export async function guardarNotas(usuarioId: string, notas: string): Promise<Resultado> {
  const acceso = await conAdmin();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (!acceso.esAdmin) return { ok: false, mensaje: "Es una acción de administrador." };

  const { error, data } = await acceso.supabase
    .from("personal_panel")
    .update({ notas: notas.trim() || null })
    .eq("usuario_id", usuarioId)
    .select("usuario_id");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) return { ok: false, mensaje: "No se guardó nada." };
  refrescar();
  return { ok: true, mensaje: "Guardado." };
}
