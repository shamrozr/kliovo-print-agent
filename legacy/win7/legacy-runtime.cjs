"use strict";

// Electron 22 embeds Node 16: AbortSignal.timeout exists, global fetch may not.
// Keep this shim in the legacy package, leaving the modern runtime untouched.
exports.installLegacyFetch = function installLegacyFetch() {
  if (typeof globalThis.fetch !== "function") {
    const fetch = require("node-fetch");
    globalThis.fetch = fetch;
    globalThis.Headers = fetch.Headers;
    globalThis.Request = fetch.Request;
    globalThis.Response = fetch.Response;
  }
};
