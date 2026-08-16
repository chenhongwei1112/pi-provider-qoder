import type { OAuthAuthInfo, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interactiveLogin } from "../login.js";

// getMachineId reads (and may create) a file under the real agent directory;
// pin it so the flow never touches the filesystem and the URL is deterministic.
vi.mock("../cosy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cosy.js")>();
  return { ...actual, getMachineId: () => "test-machine-id" };
});

const OFFICIAL_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";

/** Empty PAT answer from the prompt → falls through to the browser device flow. */
function makeCallbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn(async () => ""),
    onSelect: vi.fn(async () => undefined),
    onProgress: vi.fn(),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: "",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Dispatch fetch mocks by URL: the device flow polls `deviceToken/poll` and then
 * makes a best-effort `userinfo` call whose failure is swallowed. Poll responses
 * are consumed in order; the last one repeats if the flow keeps polling.
 */
function mockFetchSequence(pollResponses: Array<() => Response>) {
  let pollCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/deviceToken/poll")) {
      const next = pollResponses[Math.min(pollCount, pollResponses.length - 1)];
      pollCount++;
      return next();
    }
    if (url.includes("/api/v1/userinfo")) {
      return jsonResponse(500, {});
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function pollCallsOf(fetchMock: ReturnType<typeof mockFetchSequence>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes("deviceToken/poll"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("interactiveLogin device flow", () => {
  it("builds the authorize URL with the official client_id and parameter order", async () => {
    const fetchMock = mockFetchSequence([]);
    const controller = new AbortController();
    let authUrl = "";
    const callbacks = makeCallbacks({
      signal: controller.signal,
      onAuth: vi.fn((info: OAuthAuthInfo) => {
        authUrl = info.url;
        controller.abort();
      }),
    });

    await expect(interactiveLogin(callbacks, "global")).rejects.toThrow("Login cancelled");

    expect(authUrl).toContain("client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
    expect(authUrl).toContain("challenge_method=S256");
    expect(authUrl).toContain("machine_id=test-machine-id");
    const query = authUrl.slice(authUrl.indexOf("?") + 1);
    const keys = query.split("&").map((pair) => pair.split("=")[0]);
    expect(keys).toEqual(["challenge", "challenge_method", "nonce", "machine_id", "client_id"]);
    // The abort lands before the first poll, so nothing is ever fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats only 404 as pending and completes on a 200 token response", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      () => jsonResponse(404, { errorCode: "NotFound" }),
      () => jsonResponse(404, { errorCode: "NotFound" }),
      () =>
        jsonResponse(200, {
          token: "qoder-access-token",
          user_id: "user-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        }),
    ]);

    const promise = interactiveLogin(makeCallbacks(), "global");
    await vi.runAllTimersAsync();
    const creds = await promise;

    expect(creds.access).toBe("qoder-access-token");
    expect(creds.userID).toBe("user-1");
    expect(creds.refresh).toBe("refresh-1|user-1|test-machine-id");

    const polls = pollCallsOf(fetchMock);
    expect(polls).toHaveLength(3);
    const pollURL = String(polls[0][0]);
    expect(pollURL).toContain("https://openapi.qoder.sh/api/v1/deviceToken/poll?");
    expect(pollURL).toContain("nonce=");
    expect(pollURL).toContain("verifier=");
    expect(pollURL).toContain("challenge_method=S256");
  });

  it("does not treat 202 as pending: a non-404 failure aborts the login", async () => {
    vi.useFakeTimers();
    // A real 202 carries ok=true; this synthetic non-ok 202 pins the contract that
    // only 404 is a pending signal and any other non-ok status fails the login.
    mockFetchSequence([
      () =>
        ({
          status: 202,
          ok: false,
          statusText: "Accepted",
          text: async () => "still pending",
        }) as unknown as Response,
    ]);

    const promise = interactiveLogin(makeCallbacks(), "global");
    const assertion = expect(promise).rejects.toThrow("Device token poll failed: 202");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("sends no User-Agent header on device token polls", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      () => jsonResponse(200, { token: "t", user_id: "u", refresh_token: "r", expires_in: 3600 }),
    ]);

    const promise = interactiveLogin(makeCallbacks(), "global");
    await vi.runAllTimersAsync();
    await promise;

    const polls = pollCallsOf(fetchMock);
    expect(polls.length).toBeGreaterThan(0);
    for (const [, init] of polls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers).not.toHaveProperty("User-Agent");
      expect(headers).toMatchObject({ Accept: "application/json" });
    }
  });

  it("rejects browser login in CN mode", async () => {
    const fetchMock = mockFetchSequence([]);

    await expect(interactiveLogin(makeCallbacks(), "cn")).rejects.toThrow(/CN browser login is not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
