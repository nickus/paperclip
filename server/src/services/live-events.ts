import { EventEmitter } from "node:events";
import type { HeartbeatRunStreamJsonPayload, LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const allCompanyEvents = Symbol("all-company-live-events");
// Translated run output (`heartbeat.run.stream_json`) has its own channel: it
// reaches only sockets that opted in, never default subscribers or
// process-wide observers, so existing consumers see no extra traffic.
const streamJsonEmitter = new EventEmitter();
streamJsonEmitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  emitter.emit(allCompanyEvents, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}

/**
 * Internal process-wide observation of company-scoped events. This is kept
 * distinct from the public/global `*` stream so company subscriptions and
 * global instance events retain their existing routing semantics.
 */
export function subscribeAllCompanyLiveEvents(listener: LiveEventListener) {
  emitter.on(allCompanyEvents, listener);
  return () => emitter.off(allCompanyEvents, listener);
}

/**
 * Builds an event with the next id without publishing it, for messages sent
 * to one socket (such as the stream-json hello).
 */
export function createLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  return toLiveEvent(input);
}

export function publishStreamJsonEvent(input: {
  companyId: string;
  payload: HeartbeatRunStreamJsonPayload;
}) {
  const event = toLiveEvent({
    companyId: input.companyId,
    type: "heartbeat.run.stream_json",
    payload: input.payload as unknown as LiveEventPayload,
  });
  streamJsonEmitter.emit(input.companyId, event);
  return event;
}

export function subscribeCompanyStreamJsonEvents(companyId: string, listener: LiveEventListener) {
  streamJsonEmitter.on(companyId, listener);
  return () => streamJsonEmitter.off(companyId, listener);
}
