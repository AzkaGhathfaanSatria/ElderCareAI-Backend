import { EventEmitter } from "events";

/** Bus event in-memory untuk SSE. Satu proses saja; kalau API di-scale, ganti dengan Redis pub/sub. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export type ElderEvent = "vital" | "alert" | "fall";

export function publish(elderId: number, event: ElderEvent, data: unknown = {}) {
  bus.emit(`elder:${elderId}`, { event, data });
}
