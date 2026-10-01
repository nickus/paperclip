// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { ProviderQuotaCard } from "./ProviderQuotaCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function baseProps() {
  return {
    provider: "anthropic",
    rows: [],
    budgetMonthlyCents: 0,
    totalCompanySpendCents: 0,
    weekSpendCents: 0,
    windowRows: [],
    showDeficitNotch: false,
  };
}

describe("ProviderQuotaCard subscription-quota section", () => {
  it("renders no subscription-quota section at all for an ok:true result with empty windows and no error", () => {
    // Mirrors claude_local's host-login probe under Bedrock auth:
    // { provider: "anthropic", source: "bedrock", ok: true, windows: [] }.
    const emptyResult: ProviderQuotaResult = {
      provider: "anthropic",
      source: "bedrock",
      ok: true,
      windows: [],
      label: "Server login",
    };

    const node = render(<ProviderQuotaCard {...baseProps()} quotaResults={[emptyResult]} />);

    expect(node.textContent).not.toContain("Subscription quota");
    expect(node.textContent).not.toContain("Server login");
  });

  it("still renders a panel for a result that carries windows", () => {
    const withWindows: ProviderQuotaResult = {
      provider: "anthropic",
      source: "anthropic-oauth",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 42, resetsAt: null, valueLabel: null, detail: null }],
      label: "Claude login",
    };

    const node = render(<ProviderQuotaCard {...baseProps()} quotaResults={[withWindows]} />);

    expect(node.textContent).toContain("Subscription quota");
    expect(node.textContent).toContain("Claude login");
  });

  it("still renders a panel for a result that carries an error, even with no windows", () => {
    const errored: ProviderQuotaResult = {
      provider: "anthropic",
      ok: false,
      windows: [],
      error: "Could not read live Claude usage right now, and no recent run data is available either.",
      label: "payments-bot token",
    };

    const node = render(<ProviderQuotaCard {...baseProps()} quotaResults={[errored]} />);

    expect(node.textContent).toContain("Subscription quota");
    expect(node.textContent).toContain("payments-bot token");
    expect(node.textContent).toContain("Could not read live Claude usage right now");
  });

  it("drops only the empty/errorless entries while keeping the rest, in a mixed multi-credential list", () => {
    const empty: ProviderQuotaResult = {
      provider: "anthropic",
      source: "bedrock",
      ok: true,
      windows: [],
      label: "Server login",
    };
    const withWindows: ProviderQuotaResult = {
      provider: "anthropic",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 10, resetsAt: null, valueLabel: null, detail: null }],
      label: "Claude login",
    };

    const node = render(<ProviderQuotaCard {...baseProps()} quotaResults={[empty, withWindows]} />);

    expect(node.textContent).toContain("Subscription quota");
    expect(node.textContent).toContain("Claude login");
    expect(node.textContent).not.toContain("Server login");
  });
});
