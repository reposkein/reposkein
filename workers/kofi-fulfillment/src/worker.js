/** Cloudflare Worker entry point. Everything real lives in `handler.js`, so
 *  the handler can be unit-tested as a plain function with a fake KV and a
 *  fake `Request` — no wrangler, no miniflare, no second test runner. */

import { handleRequest } from "./handler.js";

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{waitUntil: (p: Promise<unknown>) => void}} ctx
   */
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      // Never leak an internal error to a public endpoint, and never return
      // a 4xx for our own bug: a 500 is what makes Ko-fi retry, which is the
      // behaviour we want when the failure is ours.
      console.error("kofi-fulfillment:", err && err.stack ? err.stack : String(err));
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};
