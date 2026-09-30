import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  sandboxBridgeAuthorizationSource,
  type SandboxBridgeAuthorizationFailure,
} from "./sandbox-callback-bridge-auth.js";

type Check = (
  authorization: string | undefined,
  rawHeaders: string[],
  tokensMatch: (received: string) => boolean,
) => SandboxBridgeAuthorizationFailure | null;

// Evaluate the exact source the generated gateway embeds.
const checkBridgeAuthorization = runInNewContext(
  `${sandboxBridgeAuthorizationSource()}; checkBridgeAuthorization`,
  {},
) as Check;

const TOKEN = "run-bridge-token";
const tokensMatch = (received: string) => received === TOKEN;

function check(values: string[]) {
  const rawHeaders = values.flatMap((value) => ["Authorization", value]);
  return checkBridgeAuthorization(values[0], rawHeaders, tokensMatch);
}

describe("sandbox bridge authorization check", () => {
  it("accepts exactly the header it accepted before", () => {
    expect(check([`Bearer ${TOKEN}`])).toBeNull();
    // Node exposes the first of repeated headers; that one decides.
    expect(check([`Bearer ${TOKEN}`, "Bearer wrong-key-7f3a"])).toBeNull();
  });

  it("names the case and the header to send", () => {
    const cases: Array<[string[], string, string]> = [
      [[], "bridge_authorization_missing", "The request has no Authorization header."],
      [["Bearer wrong-key-7f3a", `Bearer ${TOKEN}`], "bridge_authorization_repeated", "The request has 2 Authorization headers"],
      [[`Bearer${TOKEN}`], "bridge_authorization_malformed", "there is no space between Bearer and the token"],
      [[`bearer ${TOKEN}`], "bridge_authorization_malformed", "write the scheme as Bearer, with a capital B"],
      [[`Bearer  ${TOKEN}`], "bridge_authorization_malformed", "put exactly one space between Bearer and the token"],
      [[`Bearer ${TOKEN} extra`], "bridge_authorization_malformed", "the token must be one value with no spaces in it"],
      [["Bearer"], "bridge_authorization_malformed", "nothing follows Bearer"],
      [[""], "bridge_authorization_malformed", "the header is empty"],
      [[`Token ${TOKEN}`], "bridge_authorization_malformed", "it does not start with the word Bearer"],
      [["Bearer wrong-key-7f3a"], "bridge_token_invalid", "The bearer token is not valid for this run."],
    ];
    for (const [values, code, detail] of cases) {
      const failure = check(values);
      expect(failure?.code, values.join(" | ")).toBe(code);
      expect(failure?.error).toContain(detail);
      expect(failure?.error).toContain("Send exactly one header: Authorization: Bearer $PAPERCLIP_API_KEY.");
      expect(failure?.error).not.toContain(TOKEN);
      expect(failure?.error).not.toContain("wrong-key-7f3a");
    }
  });
});
