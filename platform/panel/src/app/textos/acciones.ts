"use server";

/**
 * Guardar un texto del bot.
 *
 * Es la acción más directa del panel: lo que se guarda acá es lo que lee un
 * vecino. Por eso valida dos cosas antes de escribir, y las dos vienen de bugs
 * reales que ya pasaron en este proyecto:
 *
 *   1. Que no queden marcadores que el bot no sabe reemplazar. Un `{plazo}` mal
 *      escrito como `{palzo}` se le envía LITERAL al vecino, con las llaves.
 *   2. Que no se borre el texto de una clave que el código lee con `leerTexto`,
 *      que devuelve «[falta texto: clave]» cuando está vacío — y eso también se
 *      le manda al vecino.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";

export interface Resultado {
  readonly ok: boolean;
  readonly mensaje: string;
}

/**
 * Claves que el código lee con `tieneTexto()` y por lo tanto pueden ir vacías.
 *
 * El resto se lee con `leerTexto()`, que devuelve un marcador de error visible
 * si no hay texto. Vaciarlas sería mandarle «[falta texto: bienvenida]» a un
 * vecino.
 */
const PUEDEN_IR_VACIAS = new Set(["separa_fuera_de_avenidas"]);

export async function guardarTexto(
  clave: string,
  texto: string,
  marcadoresValidos: string[],
): Promise<Resultado> {
  const persona = await personaActual();
  if (!persona) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const limpio = texto.trim();

  if (limpio === "" && !PUEDEN_IR_VACIAS.has(clave)) {
    return {
      ok: false,
      mensaje:
        "Este mensaje no puede quedar vacío: el bot lo busca y, si no lo encuentra, le manda al " +
        "vecino un aviso de error en su lugar.",
    };
  }

  // Cualquier {palabra} que no esté en la lista de marcadores válidos. El bot
  // reemplaza sólo los que conoce y el resto los envía con las llaves puestas.
  const usados = [...limpio.matchAll(/\{[a-zA-Z_]+\}/g)].map((m) => m[0]);
  const invalidos = [...new Set(usados.filter((u) => !marcadoresValidos.includes(u)))];

  if (invalidos.length > 0) {
    return {
      ok: false,
      mensaje:
        `${invalidos.join(", ")} no ${invalidos.length === 1 ? "es un marcador" : "son marcadores"} ` +
        `que el bot sepa reemplazar, así que se lo enviaría al vecino con las llaves puestas. ` +
        `Los válidos son: ${marcadoresValidos.join(", ")}`,
    };
  }

  const { error, data } = await (await clienteServidor())
    .from("textos_bot")
    .update({ texto: limpio, actualizado_por: persona.usuarioId })
    .eq("clave", clave)
    .select("clave");

  if (error) {
    return {
      ok: false,
      mensaje: /row-level security/i.test(error.message)
        ? "No tenés permiso para editar los textos del bot."
        : error.message,
    };
  }
  if (!data || data.length === 0) return { ok: false, mensaje: "No encontré ese texto." };

  revalidatePath("/textos");
  return { ok: true, mensaje: "Guardado. El bot lo usa desde el próximo mensaje." };
}
