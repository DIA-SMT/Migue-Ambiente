/**
 * Límite de frecuencia por usuario, compartido por los canales.
 *
 * En memoria y no en Redis, a propósito: el bot corre con `instances: 1`
 * garantizado (bots.json), así que un Map alcanza y evita un viaje a Redis en
 * cada mensaje. Cada canal crea SU instancia: un vecino que satura WhatsApp no
 * consume la cubeta de nadie en Telegram.
 */

interface Cubeta {
  cuenta: number;
  desde: number;
}

export interface LimiteDeFrecuencia {
  /** true si este usuario se pasó de la ventana. Cuenta el intento. */
  excede(usuario: string): boolean;
  /** Corta el interval de limpieza. Para el apagado ordenado y las pruebas. */
  detener(): void;
}

export function crearLimiteDeFrecuencia(opciones?: {
  readonly ventanaMs?: number;
  readonly maxPorVentana?: number;
}): LimiteDeFrecuencia {
  const ventanaMs = opciones?.ventanaMs ?? 60_000;
  const maxPorVentana = opciones?.maxPorVentana ?? 20;
  const cubetas = new Map<string, Cubeta>();

  // Limpieza periódica: sin esto el Map crece con cada usuario que escribió
  // una vez. unref() para no mantener vivo el proceso por esto.
  const limpieza = setInterval(() => {
    const ahora = Date.now();
    for (const [usuario, cubeta] of cubetas) {
      if (ahora - cubeta.desde > ventanaMs * 2) cubetas.delete(usuario);
    }
  }, ventanaMs);
  limpieza.unref();

  return {
    excede(usuario: string): boolean {
      const ahora = Date.now();
      const cubeta = cubetas.get(usuario);

      if (cubeta === undefined || ahora - cubeta.desde > ventanaMs) {
        cubetas.set(usuario, { cuenta: 1, desde: ahora });
        return false;
      }

      cubeta.cuenta++;
      return cubeta.cuenta > maxPorVentana;
    },
    detener(): void {
      clearInterval(limpieza);
    },
  };
}
