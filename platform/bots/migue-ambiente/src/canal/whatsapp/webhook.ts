/**
 * El webhook de WhatsApp: la puerta por la que Meta nos golpea.
 *
 * POR QUÉ HACE FALTA ESTO Y CON TELEGRAM NO. Telegram usa long polling: el bot
 * llama a la API y pregunta si hay algo nuevo, así que nunca hay que atender a
 * nadie. WhatsApp Cloud API es al revés — Meta nos hace un POST por cada
 * mensaje— y para eso hay que estar escuchando en un puerto.
 *
 * QUÉ HACE Y QUÉ NO. Esto es SOLO transporte: verifica que el pedido venga de
 * Meta, contesta, y le pasa el cuerpo a quien corresponda. No traduce mensajes
 * ni toca flujos; eso es el adaptador, que todavía no existe. Se separa así
 * porque el transporte se puede probar hoy, con `curl` y sin credenciales,
 * mientras el alta en Meta va por su carril.
 *
 * LAS TRES REGLAS QUE NO SE NEGOCIAN:
 *
 *   1 · La firma se calcula sobre los BYTES CRUDOS. Ver `verificar.ts`.
 *
 *   2 · Se contesta 200 ANTES de procesar. Meta espera unos pocos segundos y
 *       si no llega el 200 reintenta el mismo mensaje. Procesar primero y
 *       contestar después convierte cada respuesta lenta en un mensaje
 *       duplicado, y un duplicado en el flujo de retiro es un segundo ticket
 *       para el mismo vecino.
 *
 *   3 · Un fallo procesando NO cambia el 200. Ya se contestó. El error se
 *       registra y se pierde ese mensaje, que es mejor que una tormenta de
 *       reintentos de Meta contra algo que está roto.
 *
 * La contracara de la regla 2 es que hay que deduplicar: los reintentos que sí
 * ocurran —una caída nuestra, un timeout de red— van a traer un `id` que ya
 * vimos. Para eso es la columna `canal_mensaje_id` de la migración 035.
 */
import { createLogger, type ManejadorHttp } from "@bots/core";
import { descripcionDeError } from "@migue/dominio";
import type { ServerResponse } from "node:http";
import { desafioDeAlta, firmaValida } from "./verificar.ts";

const log = createLogger("whatsapp");

/** Un mensaje entrante, tal como viene en el sobre de Meta. */
export interface MensajeCrudo {
  /** El `wamid`. Es lo que hay que guardar para no procesarlo dos veces. */
  readonly id: string;
  readonly de: string;
  readonly tipo: string;
  /**
   * El `profile.name` del `contacts[]` cuyo `wa_id` coincide con `de`.
   *
   * Se aparea ACÁ y no en el normalizador porque los contactos viajan al lado
   * de los mensajes, dentro del mismo `value` — afuera de este recorrido ya no
   * se puede saber cuál corresponde a cuál.
   */
  readonly nombre: string | null;
  /** Epoch en segundos, como string, tal cual lo manda Meta. "" si no vino. */
  readonly timestamp: string;
  /** El objeto del mensaje tal como vino, para que el normalizador lo traduzca. */
  readonly crudo: Record<string, unknown>;
}

export interface Entrega {
  readonly mensajes: readonly MensajeCrudo[];
  /**
   * Cuántos avisos de estado traía (enviado, entregado, leído).
   *
   * Se cuentan aparte y NO se procesan. Vienen por el mismo webhook y con la
   * misma forma, y confundirlos con mensajes hace que el bot le conteste al
   * acuse de recibo de su propia respuesta: un bucle contra sí mismo.
   */
  readonly estados: number;
}

function comoLista(valor: unknown): readonly unknown[] {
  return Array.isArray(valor) ? valor : [];
}

function comoObjeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null ? (valor as Record<string, unknown>) : {};
}

function comoTexto(valor: unknown): string {
  return typeof valor === "string" ? valor : "";
}

/**
 * Abre el sobre de Meta y saca lo que llegó.
 *
 * El sobre tiene tres capas —`entry[]`, `changes[]`, `value`— y una entrega
 * puede traer varios mensajes de varias personas. Se recorre entero en vez de
 * asumir `entry[0].changes[0]`, que es lo que funciona en las pruebas y falla
 * el día que dos vecinos escriben en el mismo segundo.
 *
 * Es tolerante por diseño: cualquier campo que no venga se saltea en vez de
 * lanzar. Un sobre con una forma inesperada tiene que dejar pasar lo que sí se
 * entiende, no tirar toda la entrega.
 */
export function abrirEntrega(cuerpo: unknown): Entrega {
  const mensajes: MensajeCrudo[] = [];
  let estados = 0;

  for (const entrada of comoLista(comoObjeto(cuerpo)["entry"])) {
    for (const cambio of comoLista(comoObjeto(entrada)["changes"])) {
      const valor = comoObjeto(comoObjeto(cambio)["value"]);

      estados += comoLista(valor["statuses"]).length;

      // Los nombres de perfil viajan en `contacts[]`, al lado de los mensajes.
      const nombres = new Map<string, string>();
      for (const contacto of comoLista(valor["contacts"])) {
        const c = comoObjeto(contacto);
        const waId = comoTexto(c["wa_id"]);
        const nombre = comoTexto(comoObjeto(c["profile"])["name"]);
        if (waId !== "" && nombre !== "") nombres.set(waId, nombre);
      }

      for (const mensaje of comoLista(valor["messages"])) {
        const m = comoObjeto(mensaje);
        const id = comoTexto(m["id"]);
        // Sin id no hay forma de deduplicar, y sin deduplicar es preferible
        // ignorarlo a arriesgar un ticket repetido.
        if (id === "") continue;
        const de = comoTexto(m["from"]);
        mensajes.push({
          id,
          de,
          tipo: comoTexto(m["type"]) || "desconocido",
          nombre: nombres.get(de) ?? null,
          timestamp: comoTexto(m["timestamp"]),
          crudo: m,
        });
      }
    }
  }

  return { mensajes, estados };
}

export interface OpcionesWebhook {
  /** La ruta pública, la misma que se carga en el panel de Meta. */
  readonly ruta: string;
  /** El `hub.verify_token`: una cadena que inventamos y va en los dos lados. */
  readonly tokenVerificacion: string;
  /** El App Secret de la aplicación de Meta, con el que se firma cada POST. */
  readonly secretoApp: string;
  /** Qué hacer con lo que llegó. Se llama DESPUÉS de haber contestado 200. */
  readonly alLlegar: (entrega: Entrega, cuerpo: unknown) => Promise<void> | void;
}

function texto(res: ServerResponse, estado: number, cuerpo: string): void {
  res.writeHead(estado, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(cuerpo),
  });
  res.end(cuerpo);
}

/**
 * Arma las rutas para `startHttpServer`.
 *
 * Devuelve el objeto en vez de levantar el servidor para que el arranque siga
 * teniendo un solo lugar donde se abren recursos, y para que las pruebas puedan
 * montar estas mismas rutas en un puerto efímero.
 */
export function rutasDelWebhook(opciones: OpcionesWebhook): Record<string, ManejadorHttp> {
  const { ruta, tokenVerificacion, secretoApp, alLlegar } = opciones;

  return {
    [`GET ${ruta}`]: (pedido, respuesta) => {
      const consulta = new URL(pedido.url ?? "", "http://localhost").searchParams;
      const desafio = desafioDeAlta(consulta, tokenVerificacion);

      if (desafio === null) {
        log.warn("alta de webhook rechazada: el hub.verify_token no coincide");
        return texto(respuesta, 403, "no");
      }

      log.info("alta de webhook verificada");
      // Tal cual, en texto plano. Meta compara el cuerpo carácter por carácter.
      texto(respuesta, 200, desafio);
    },

    [`POST ${ruta}`]: (pedido, respuesta, cuerpo, crudo) => {
      const firma = pedido.headers["x-hub-signature-256"];
      if (!firmaValida(crudo, typeof firma === "string" ? firma : undefined, secretoApp)) {
        log.warn({ bytes: crudo.length }, "POST con firma inválida, descartado");
        return texto(respuesta, 403, "no");
      }

      // Regla 2: el 200 sale primero. Todo lo que sigue es a espaldas de Meta.
      texto(respuesta, 200, "ok");

      const entrega = abrirEntrega(cuerpo);
      if (entrega.mensajes.length === 0 && entrega.estados > 0) {
        // El caso más frecuente de todos, y no es un mensaje: son los acuses de
        // nuestras propias respuestas. Se registra fino para no llenar el log.
        log.debug({ estados: entrega.estados }, "sólo avisos de estado");
        return;
      }

      log.info(
        {
          mensajes: entrega.mensajes.length,
          estados: entrega.estados,
          tipos: [...new Set(entrega.mensajes.map((m) => m.tipo))].join(","),
        },
        "entrega recibida",
      );

      // Regla 3: si esto falla, el 200 ya salió y no se toca.
      void (async () => {
        try {
          await alLlegar(entrega, cuerpo);
        } catch (error) {
          log.error({ err: descripcionDeError(error) }, "falló el proceso de la entrega");
        }
      })();
    },
  };
}
