import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    for (const name of ["Worker", "SharedWorker", "Blob", "RTCPeerConnection", "RTCDataChannel"]) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source).toContain("disableGlobal(");
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });

  it("installs its message handler when some globals are getter-only", () => {
    // Engines such as WebKit expose getter-only globals; a strict-mode
    // assignment to them throws. The bootstrap must survive that and still
    // disable what it can.
    const proto = {};
    for (const name of ["caches", "indexedDB"]) {
      Object.defineProperty(proto, name, { get: () => ({ open() {} }), configurable: true });
    }
    const self = Object.create(proto) as Record<string, unknown>;
    Object.assign(self, { fetch() {}, XMLHttpRequest() {}, Worker() {}, Blob() {}, postMessage() {} });
    Object.defineProperty(self, "frozenApi", { value: () => {}, writable: false, configurable: false });

    expect(() => new Function("self", getWorkerBootstrapSource())(self)).not.toThrow();
    expect(typeof self.onmessage).toBe("function");
    expect(self.fetch).toBeUndefined();
    expect(self.Worker).toBeUndefined();
    expect(self.caches).toBeUndefined();
    expect(self.indexedDB).toBeUndefined();
  });
});
