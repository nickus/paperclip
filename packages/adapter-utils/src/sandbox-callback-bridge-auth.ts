/**
 * The in-sandbox gateway's bearer-token check, with an actionable 401.
 *
 * An agent reaches the gateway with shell tools, and the ways a request goes
 * wrong are mechanical: no header, two headers (`curl -H` given twice, or one
 * from a config file plus one on the command line), `Bearer<token>` without
 * the space, a lowercase scheme, an empty `$PAPERCLIP_API_KEY`, or a key
 * copied from another run. A bare "invalid token" answer sends the agent
 * retrying the same request, so the gateway names the case and the header to
 * send. It never echoes any part of the received header.
 *
 * The gateway is a generated, dependency-free `.mjs`, so the check ships as
 * source text (see {@link sandboxBridgeAuthorizationSource}); a test evaluates
 * the same text.
 */

/** Stable codes for the four refusal cases, returned in the 401 body. */
export const SANDBOX_BRIDGE_AUTHORIZATION_FAILURE_CODES = [
  "bridge_authorization_missing",
  "bridge_authorization_repeated",
  "bridge_authorization_malformed",
  "bridge_token_invalid",
] as const;

export type SandboxBridgeAuthorizationFailureCode =
  (typeof SANDBOX_BRIDGE_AUTHORIZATION_FAILURE_CODES)[number];

export interface SandboxBridgeAuthorizationFailure {
  code: SandboxBridgeAuthorizationFailureCode;
  error: string;
}

// Plain JavaScript with no template literals, so it embeds verbatim inside the
// gateway's template literal.
const SANDBOX_BRIDGE_AUTHORIZATION_SOURCE = `const BRIDGE_AUTHORIZATION_USAGE = "Send exactly one header: Authorization: Bearer $PAPERCLIP_API_KEY";

// Why a single Authorization header is not "Bearer <token>", or null when it
// has that form. Never includes any part of the header value.
function describeMalformedBridgeAuthorization(header) {
  if (/^Bearer [^\\s]+$/.test(header)) return null;
  if (header.length === 0) return "the header is empty (is $PAPERCLIP_API_KEY set in this shell?)";
  if (/^bearer$/i.test(header)) return "nothing follows Bearer (is $PAPERCLIP_API_KEY set in this shell?)";
  if (/^bearer\\S/i.test(header)) return "there is no space between Bearer and the token";
  if (/^bearer\\s/i.test(header)) {
    if (!header.startsWith("Bearer")) return "write the scheme as Bearer, with a capital B";
    if (!/^Bearer [^\\s]/.test(header)) return "put exactly one space between Bearer and the token";
    return "the token must be one value with no spaces in it";
  }
  return "it does not start with the word Bearer";
}

// Check one gateway request. authorization is the header value Node exposes
// (the first one when the request repeats the header); rawHeaders is Node's
// flat name/value list, used only to count repeated headers. Returns null to
// accept, or { code, error } for the 401 body. Acceptance depends only on
// authorization, exactly as before; the rest only explains a refusal.
function checkBridgeAuthorization(authorization, rawHeaders, tokensMatch) {
  const header = typeof authorization === "string" ? authorization : "";
  const receivedToken = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (tokensMatch(receivedToken)) return null;
  let count = 0;
  const names = Array.isArray(rawHeaders) ? rawHeaders : [];
  for (let index = 0; index + 1 < names.length; index += 2) {
    if (String(names[index]).toLowerCase() === "authorization") count += 1;
  }
  if (count === 0 && header.length === 0) {
    return {
      code: "bridge_authorization_missing",
      error: "The request has no Authorization header. " + BRIDGE_AUTHORIZATION_USAGE + ".",
    };
  }
  if (count > 1) {
    return {
      code: "bridge_authorization_repeated",
      error: "The request has " + count + " Authorization headers (for example curl -H given twice). " +
        BRIDGE_AUTHORIZATION_USAGE + ".",
    };
  }
  const problem = describeMalformedBridgeAuthorization(header);
  if (problem) {
    return {
      code: "bridge_authorization_malformed",
      error: "The Authorization header is not in the form \\"Bearer <token>\\": " + problem + ". " +
        BRIDGE_AUTHORIZATION_USAGE + ".",
    };
  }
  return {
    code: "bridge_token_invalid",
    error: "The bearer token is not valid for this run. Use this run's own PAPERCLIP_API_KEY; " +
      "a key from another run, an earlier session or the host does not work here. " +
      BRIDGE_AUTHORIZATION_USAGE + ".",
  };
}`;

/**
 * Zero-dependency source that declares
 * `checkBridgeAuthorization(authorization, rawHeaders, tokensMatch)`. The
 * generated gateway embeds it; a test evaluates it directly.
 */
export function sandboxBridgeAuthorizationSource(): string {
  return SANDBOX_BRIDGE_AUTHORIZATION_SOURCE;
}
