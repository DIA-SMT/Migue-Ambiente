/**
 * Prueba el webhook de WhatsApp de punta a punta, sin Meta.
 *
 * Es lo que permite tener el transporte terminado y verificado ANTES de que
 * salga el trámite: si estas cinco pruebas pasan contra la URL pública, cuando
 * Meta apriete «Verificar y guardar» va a funcionar, porque hace exactamente lo
 * mismo que hacemos acá.
 *
 *   WHATSAPP_VERIFY_TOKEN=... WHATSAPP_APP_SECRET=... \
 *     node herramientas/verificar-webhook.mjs https://srv1915283.hstgr.cloud
 *
 * Sin URL prueba contra 127.0.0.1:3002, que es el bot corriendo en la misma
 * máquina. Con la URL pública se prueba además el certificado y el nginx, que
 * es donde de verdad se rompen estas cosas.
 *
 * El POST manda un sobre de SÓLO AVISOS DE ESTADO, no un mensaje. Así se puede
 * correr contra producción sin inventarle una consulta a nadie ni ensuciar la
 * tabla de conversaciones.
 */
import { createHmac } from "node:crypto";

const base = (process.argv[2] ?? "http://127.0.0.1:3002").replace(/\/+$/, "");
const ruta = process.env.WHATSAPP_WEBHOOK_RUTA?.trim() || "/hooks/whatsapp";
const token = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
const secreto = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";

if (token === "" || secreto === "") {
  console.error("Faltan WHATSAPP_VERIFY_TOKEN y/o WHATSAPP_APP_SECRET en el entorno.");
  process.exit(2);
}

const url = base + ruta;

function firmar(cuerpo, clave = secreto) {
  return "sha256=" + createHmac("sha256", clave).update(cuerpo).digest("hex");
}

const SOBRE = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "PRUEBA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "PRUEBA" },
            statuses: [{ id: "wamid.PRUEBA", status: "delivered" }],
          },
        },
      ],
    },
  ],
});

/** Cada prueba: qué se pide, qué código tiene que volver, y qué más mirar. */
const PRUEBAS = [
  {
    nombre: "alta con el token correcto",
    pedido: () =>
      fetch(`${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1234567`),
    espera: 200,
    // Lo único que Meta mira: el desafío devuelto tal cual.
    revisar: (cuerpo) => (cuerpo === "1234567" ? null : `devolvió «${cuerpo}» en vez del desafío`),
  },
  {
    nombre: "alta con el token equivocado",
    pedido: () => fetch(`${url}?hub.mode=subscribe&hub.verify_token=noesestemal&hub.challenge=1234567`),
    espera: 403,
  },
  {
    nombre: "mensaje con la firma correcta",
    pedido: () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": firmar(SOBRE) },
        body: SOBRE,
      }),
    espera: 200,
  },
  {
    nombre: "mensaje con la firma de otro secreto",
    pedido: () =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": firmar(SOBRE, "no-es-el-secreto"),
        },
        body: SOBRE,
      }),
    espera: 403,
  },
  {
    nombre: "mensaje sin firma",
    pedido: () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: SOBRE,
      }),
    espera: 403,
  },
];

console.log(`Verificando ${url}\n`);

let fallaron = 0;

for (const prueba of PRUEBAS) {
  let estado;
  let cuerpo = "";
  let problema = null;

  try {
    const r = await prueba.pedido();
    estado = r.status;
    cuerpo = (await r.text()).trim();
    if (estado !== prueba.espera) problema = `dio ${estado} y esperaba ${prueba.espera}`;
    else if (prueba.revisar) problema = prueba.revisar(cuerpo);
  } catch (error) {
    problema = `no pude conectarme: ${error.message}`;
  }

  if (problema === null) {
    console.log(`  ok    ${prueba.nombre}`);
  } else {
    fallaron++;
    console.log(`  FALLA ${prueba.nombre}`);
    console.log(`        ${problema}`);
    if (cuerpo !== "" && cuerpo.length < 200) console.log(`        cuerpo: ${cuerpo}`);
  }
}

console.log();
if (fallaron === 0) {
  console.log("Las cinco pasan. El webhook está listo para que Meta lo dé de alta.");
} else {
  console.log(`${fallaron} de ${PRUEBAS.length} fallaron.`);
  if (base.startsWith("https://")) {
    console.log("Si contra 127.0.0.1:3002 pasan y acá no, el problema está en nginx o el certificado.");
  }
}

// `process.exitCode` y no `process.exit()`: cortar el proceso de una mientras
// `fetch` todavía está cerrando sus sockets aborta con un error de libuv en
// Windows, y el código de salida termina siendo 127 aunque todo haya pasado.
process.exitCode = fallaron === 0 ? 0 : 1;
