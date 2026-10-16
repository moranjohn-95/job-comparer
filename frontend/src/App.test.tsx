import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "./App";
import {
  deleteSavedComparison, getComparisonSummaries, getSavedComparison,
  getSavedComparisons, getSavedCv, resetSessionRequests,
} from "./api";

// Most existing journeys begin signed out. Keep their endpoint mocks intact
// while modelling the new initial /me request explicitly.
async function renderSignedOutApp() {
  const configuredFetch = globalThis.fetch;
  let initialMe = true;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.has("Authorization")).toBe(false);
    if (!["GET", "HEAD", "OPTIONS"].includes(init?.method ?? "GET")) {
      expect(headers.get("X-CSRF-Protection")).toBe("1");
      if (init?.body instanceof FormData) expect(headers.has("Content-Type")).toBe(false);
    }
    if (String(input).endsWith("/me") && initialMe) {
      initialMe = false;
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return configuredFetch(input, init);
  });
  render(<App />);
  await waitFor(() => expect(screen.queryByText("Checking your session…")).not.toBeInTheDocument());
}

afterEach(() => {
  cleanup();
  if (mockedDialog) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    mockedDialog = false;
  }
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

let mockedDialog = false;

test("opens the privacy policy directly and returns home without changing data", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    return Promise.resolve(savedDraftResponse(String(input)));
  });
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/privacy");
  await renderSignedOutApp();

  expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  expect(screen.queryByText("Draft for owner review")).not.toBeInTheDocument();
  const policy = screen.getByRole("article", { name: "Privacy notice" });
  const contact = within(policy).getByRole("region", { name: "Contact and data controller" });
  expect(policy).not.toHaveTextContent("John Moran");
  expect(within(policy).getAllByRole("heading", { level: 2 }).at(-1))
    .toHaveTextContent("Contact and data controller");
  expect(within(contact).getByRole("link", { name: "privacy@jobcomparer.com" }))
    .toHaveAttribute("href", "mailto:privacy@jobcomparer.com");
  for (const name of ["Information we handle", "AI comparisons", "Retention and deletion",
    "Your rights", "Contact and data controller"]) {
    expect(screen.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  expect(screen.getByText(/saved CV text and the selected job description are sent to OpenAI/)).toBeVisible();
  expect(screen.getByText(/Replacing or deleting it does not remove excerpts from earlier comparisons/)).toBeVisible();
  const footer = within(screen.getByRole("navigation", { name: "Footer" }));
  expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  const returnLink = screen.getByRole("link", { name: "Back to home" });
  expect(returnLink).toHaveAttribute("href", "/");
  fireEvent.click(returnLink);

  expect(window.location.pathname).toBe("/");
  expect(screen.queryByRole("heading", { name: "Privacy Policy" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Job description")).toBeVisible();
  expect(footer.getByRole("link", { name: "Privacy" })).not.toHaveAttribute("aria-current");
});

test("opens the terms directly and returns home without changing data", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    return Promise.resolve(savedDraftResponse(String(input)));
  });
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/terms");
  await renderSignedOutApp();

  expect(screen.getByRole("heading", { level: 1, name: "Terms of Use" })).toBeVisible();
  const terms = within(screen.getByRole("article", { name: "Terms of use" }));
  for (const name of ["What Job Comparer provides", "AI guidance, not a guarantee",
    "Your information and account", "Acceptable use", "Availability and changes",
    "Responsibility", "Privacy"]) {
    expect(terms.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  expect(terms.getByText(/Results do not guarantee an interview, employment or suitability/)).toBeVisible();
  expect(terms.getByText(/Nothing in these terms excludes or limits/)).toBeVisible();
  const privacyLink = terms.getByRole("link", { name: "Privacy Policy" });
  expect(privacyLink).toHaveAttribute("href", "/privacy");
  fireEvent.click(privacyLink);
  expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  expect(window.location.pathname).toBe("/privacy");
  window.history.back();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Terms of Use" })).toBeVisible());
  const footer = within(screen.getByRole("navigation", { name: "Footer" }));
  expect(footer.getByRole("link", { name: "Terms" })).toHaveAttribute("aria-current", "page");
  const returnLink = screen.getByRole("link", { name: "Back to home" });
  expect(returnLink).toHaveAttribute("href", "/");
  fireEvent.click(returnLink);

  expect(window.location.pathname).toBe("/");
  expect(screen.queryByRole("heading", { name: "Terms of Use" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Job description")).toBeVisible();
  expect(footer.getByRole("link", { name: "Terms" })).not.toHaveAttribute("aria-current");
});

test.each([
  ["Privacy", "Privacy Policy"],
  ["Terms", "Terms of Use"],
])("preserves the session and unsaved drafts through %s navigation and browser Back", async (link, heading) => {
  const { writes, fetchMock } = mockEmptyDashboard();
  render(<App />);
  const title = await screen.findByLabelText("Job title");
  fireEvent.change(title, { target: { value: "Unsubmitted role" } });
  fireEvent.change(screen.getByLabelText("Job description"), { target: { value: "Unsubmitted description" } });
  fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(screen.getByLabelText("Paste your CV text"), { target: { value: "Unsubmitted CV" } });

  fireEvent.click(screen.getByRole("link", { name: link }));
  expect(screen.getByRole("heading", { name: heading })).toBeVisible();
  expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
  window.history.back();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Start a comparison" })).toBeVisible());

  fireEvent.click(screen.getByRole("link", { name: link }));
  fireEvent.click(screen.getByRole("link", { name: "Back to dashboard" }));
  expect(screen.getByText("ada@example.com")).toBeVisible();
  expect(screen.getByLabelText("Job title")).toHaveValue("Unsubmitted role");
  expect(screen.getByLabelText("Job description")).toHaveValue("Unsubmitted description");
  expect(screen.getByLabelText("Paste your CV text")).toHaveValue("Unsubmitted CV");
  expect(writes).toEqual([]);
  for (const [, init] of fetchMock.mock.calls) {
    expect(init?.method ?? "GET").toBe("GET");
  }
});

// jsdom has no native dialog implementation. Browser checks cover its focus
// containment; these shims exercise our opening, cancellation and restoration.
function enableDialogMock() {
  if ("showModal" in HTMLDialogElement.prototype) return;
  mockedDialog = true;
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
}

test("restores the cookie session on startup without replaying mutations", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(
    String(input).endsWith("/jobs")
      ? { ok: true, json: async () => [] }
      : savedDraftResponse(String(input)),
  ));
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
  expect(await screen.findByText("ada@example.com")).toBeVisible();
  expect(await screen.findByRole("heading", { name: "Start a comparison" })).toBeVisible();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/login"))).toBe(false);
  for (const [, init] of vi.mocked(globalThis.fetch).mock.calls) {
    expect(init?.credentials).toBe("include");
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  }
});

test.each(["network", "server"])("retries an initial %s session error", async (failure) => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith("/me") && ++attempts === 1) {
      return failure === "network" ? Promise.reject(new TypeError("Network error"))
        : Promise.resolve(new Response(null, { status: 503 }));
    }
    return Promise.resolve(String(input).endsWith("/jobs")
      ? { ok: true, json: async () => [] } : savedDraftResponse(String(input)));
  }));
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to check your session");
  expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry session" }));
  expect(await screen.findByText("ada@example.com")).toBeVisible();
  expect(attempts).toBe(2);
});

test.each([401, 403])("clears a blocked session (%s) without replaying its draft", async (status) => {
  let jobReads = 0;
  const writes: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
    if (url.endsWith("/jobs")) {
      jobReads += 1;
      return Promise.resolve(jobReads === 2
        ? new Response(status === 403 ? JSON.stringify({ detail: {
          code: "email_verification_required", message: "Verify your email before signing in.", email: "ada@example.com",
        } }) : null, { status }) : { ok: true, json: async () => [] });
    }
    if (url.endsWith("/cv")) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Start a comparison" });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Private draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  if (status === 401) expect(await screen.findByRole("alert")).toHaveTextContent("Your session has expired");
  else {
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  }
  expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue("Private draft")).not.toBeInTheDocument();
  enterLogin();
  await screen.findByRole("heading", { name: "Start a comparison" });
  expect(screen.getByLabelText("Job title")).toHaveValue("");
  expect(writes).toEqual(["POST /api/login", "POST /api/login"]);
});

test("shows a connected status for a healthy API response", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "ok" }),
  });
  vi.stubGlobal("fetch", fetchMock);

  await renderSignedOutApp();

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/health",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("shows an unavailable status for an unexpected health response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "not-ok" }),
    }),
  );

  await renderSignedOutApp();

  expect(
    await screen.findByRole("button", { name: "Retry connection" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Unable to reach the API. Please try again.",
    ),
  ).toBeVisible();
});

test("treats an HTTP error as unavailable without reading its body", async () => {
  const readBody = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      json: readBody,
    }),
  );

  await renderSignedOutApp();

  await screen.findByRole("button", { name: "Retry connection" });
  expect(readBody).not.toHaveBeenCalled();
});

test("can retry after a network failure", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Network error"))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
  vi.stubGlobal("fetch", fetchMock);

  await renderSignedOutApp();
  await screen.findByRole("button", { name: "Retry connection" });
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

test("opens the login view from the public home navigation", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(screen.getByRole("heading", { name: "Log in" })).toBeVisible();
});

test("shows a selected PDF filename locally", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  const file = new File(["cv"], "ada-lovelace.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: { files: [file] },
  });

  expect(screen.getByRole("status")).toHaveTextContent(
    "Selected: ada-lovelace.pdf",
  );
});

test("rejects an invalid CV file locally", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  const file = new File(["cv"], "notes.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: { files: [file] },
  });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a PDF or DOCX file.",
  );
});

test("shows locally pasted CV text state", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  fireEvent.change(screen.getByLabelText("Paste your CV text"), {
    target: { value: "Experienced software engineer." },
  });

  expect(screen.getByRole("status")).toHaveTextContent(
    "CV text added locally.",
  );
});

test("keeps an entered job description in the local draft", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  fireEvent.change(screen.getByLabelText("Job description"), {
    target: { value: "Build reliable APIs and work with product teams." },
  });

  expect(screen.getByLabelText("Job description")).toHaveValue(
    "Build reliable APIs and work with product teams.",
  );
});

test("requires a CV, job details, and job description before opening signup", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Add a valid CV file or paste your CV text.",
  );
  expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(
    "Add a job description.",
  );
  expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(
    "Add a job title.",
  );
  expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(
    "Add a company name.",
  );
  expect(
    screen.queryByRole("heading", { name: "Sign up" }),
  ).not.toBeInTheDocument();
});

test("rejects job details longer than the backend limits", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  fireEvent.change(screen.getByLabelText("Paste your CV text"), {
    target: { value: "Ada CV" },
  });
  fireEvent.change(screen.getByLabelText("Job title"), {
    target: { value: "t".repeat(201) },
  });
  fireEvent.change(screen.getByLabelText("Company name"), {
    target: { value: "Analytical Engines" },
  });
  fireEvent.change(screen.getByLabelText("Job description"), {
    target: { value: "Build software." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Job title must be 200 characters or fewer.",
  );
  expect(
    screen.queryByRole("heading", { name: "Sign up" }),
  ).not.toBeInTheDocument();
});

test("asks which CV to use and preserves the draft through signup and login", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();

  const file = new File(["cv"], "ada-lovelace.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: { files: [file] },
  });
  fireEvent.change(screen.getByLabelText("Paste your CV text"), {
    target: { value: "Ada CV" },
  });
  fireEvent.change(screen.getByLabelText("Job title"), {
    target: { value: "Software Engineer" },
  });
  fireEvent.change(screen.getByLabelText("Company name"), {
    target: { value: "Analytical Engines" },
  });
  fireEvent.change(screen.getByLabelText("Job description"), {
    target: { value: "Build software." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose whether to use the uploaded file or pasted CV text.",
  );

  fireEvent.click(screen.getByLabelText("Use the pasted CV text"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    screen.getByText("Create an account to save your CV and job description."),
  ).toBeVisible();
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-enough-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long-enough-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByRole("heading", { name: "Check your email" });
  fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  fireEvent.click(screen.getByRole("link", { name: "Back to home" }));
  expect(screen.getByLabelText("Paste your CV text")).toHaveValue("Ada CV");
  expect(screen.getByLabelText("Job description")).toHaveValue(
    "Build software.",
  );
  expect(screen.getByLabelText("Job title")).toHaveValue("Software Engineer");
  expect(screen.getByLabelText("Company name")).toHaveValue(
    "Analytical Engines",
  );
  expect(screen.getByLabelText("Use the pasted CV text")).toBeChecked();
  expect(screen.getByText("Selected: ada-lovelace.pdf")).toBeVisible();
});

test("opens signup from the home hero and can return to login", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) }),
  );
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Sign up to compare" }));
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(screen.getByLabelText("Email address")).toBeVisible();
});

test("shows signup validation and recoverable delivery errors", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith("/health"))
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: "ok" }),
      });
    return Promise.resolve({
      ok: false,
      status: 503,
      json: async () => ({ detail: { code: "email_delivery_failed", message: "Email could not be sent. Please retry." } }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Sign up to compare" }));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "short" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "short" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Password must have at least 12 characters.",
  );
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "long-enough-password" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "long-enough-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Email could not be sent. Please retry.",
  );
  expect(screen.getByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Resend email" })).toBeEnabled();
});

test("shows check-email after signup and provides explicit sign-in navigation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).endsWith("/health")
            ? { status: "ok" }
            : { id: 1, email: "ada@example.com" },
      }),
    ),
  );
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Sign up to compare" }));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "long-enough-password" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "long-enough-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Resend email" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  expect(await screen.findByRole("heading", { name: "Log in" })).toBeVisible();
});

test("consumes a fragment token only on password-confirmed submission", async () => {
  const token = "a".repeat(43);
  window.history.replaceState(null, "", `/verify-email#token=${token}`);
  const confirms: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).not.toContain(token);
    if (String(input).endsWith("/verification/confirm")) {
      confirms.push(init!);
      return Promise.resolve(new Response(JSON.stringify(confirms.length === 1
        ? { detail: { code: "invalid_verification", message: "Invalid or expired link, or incorrect password." } }
        : { message: "Email verified." }), { status: confirms.length === 1 ? 400 : 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ status: "ok" })));
  }));
  await renderSignedOutApp();
  expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeVisible();
  expect(window.location.hash).toBe("");
  expect(JSON.stringify(window.history.state)).not.toContain(token);
  expect(confirms).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Account password"), { target: { value: "wrong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid or expired");
  fireEvent.change(screen.getByLabelText("Account password"), { target: { value: "correct-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
  expect(await screen.findByRole("heading", { name: "Email verified" })).toBeVisible();
  expect(confirms).toHaveLength(2);
  expect(JSON.parse(String(confirms[1].body))).toEqual({ token, password: "correct-password" });
  expect(confirms[1].method).toBe("POST");
  expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  expect(screen.getByRole("heading", { name: "Log in" })).toBeVisible();
});

test("verification-required login offers resend and honours cooldown errors", async () => {
  let resends = 0;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith("/login")) return Promise.resolve(new Response(JSON.stringify({ detail: {
      code: "email_verification_required", message: "Verify your email before signing in.",
    } }), { status: 403 }));
    if (String(input).endsWith("/verification/resend")) {
      resends += 1;
      return Promise.resolve(new Response(JSON.stringify({ detail: "Please wait before resending." }), {
        status: 429, headers: { "Retry-After": "60" },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify({ status: "ok" })));
  }));
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Check your email" });
  expect(resends).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Resend email" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Please wait before resending");
  expect(screen.getByRole("button", { name: "Resend email" })).toBeDisabled();
  expect(resends).toBe(1);
});

test("shows an error when login credentials are rejected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/health"))
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: "ok" }),
        });
      return Promise.resolve({
        ok: false,
        json: async () => ({ detail: "Invalid email or password" }),
      });
    }),
  );
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "incorrect" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid email or password",
  );
});

test("returns to the dashboard with the account email after login", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/health"))
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: "ok" }),
      });
    if (String(input).endsWith("/login"))
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 1, email: "ada@example.com" }),
      });
    expect(init).toMatchObject({
      credentials: "include", headers: expect.any(Headers),
    });
    return Promise.resolve({
      ok: true,
      json: async () => ({ id: 1, email: "ada@example.com" }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(await screen.findByText("ada@example.com")).toBeVisible();
  expect(screen.getByRole("button", { name: "Log out" })).toBeVisible();
});

test("retries server logout before clearing the signed-in account", async () => {
  let logoutAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/logout")) {
        logoutAttempts += 1;
        return Promise.resolve(new Response(null, { status: logoutAttempts === 1 ? 503 : 204 }));
      }
      if (String(input).endsWith("/health"))
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: "ok" }),
        });
      if (String(input).endsWith("/login"))
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 1, email: "ada@example.com" }),
        });
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 1, email: "ada@example.com" }),
      });
    }),
  );
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
  expect(await screen.findByText("Could not log out on the server. Please retry.")).toBeVisible();
  expect(screen.getByText("ada@example.com")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry logout" }));
  expect(await screen.findByRole("button", { name: "Log in" })).toBeVisible();
  expect(logoutAttempts).toBe(2);
  expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument();
});

function completeTextDraft() {
  fireEvent.change(screen.getByLabelText("Paste your CV text"), {
    target: { value: "Ada CV" },
  });
  fireEvent.change(screen.getByLabelText("Job title"), {
    target: { value: "Software Engineer" },
  });
  fireEvent.change(screen.getByLabelText("Company name"), {
    target: { value: "Analytical Engines" },
  });
  fireEvent.change(screen.getByLabelText("Job description"), {
    target: { value: "Build software." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

function enterLogin() {
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "ada@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "long-enough-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
}

test("saves a valid text draft after login, without comparing it", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    }
    if (url.endsWith("/login")) {
      return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) });
    }
    if (url.endsWith("/me")) {
      return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) });
    }
    if (url.endsWith("/cv")) {
      expect(init).toMatchObject({ method: "PUT", credentials: "include", headers: expect.any(Headers) });
      return Promise.resolve({ ok: true, json: async () => ({ text: "Ada CV" }) });
    }
    expect(url).toMatch(/\/jobs$/);
    expect(init).toMatchObject({ method: "POST", credentials: "include", headers: expect.any(Headers) });
    return Promise.resolve({ ok: true, json: async () => ({ id: 2, title: "Software Engineer", company_name: "Analytical Engines" }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  completeTextDraft();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  expect(await screen.findByText("Job saved")).toBeVisible();
  expect(screen.getByText(/Software Engineer at Analytical Engines/)).toBeVisible();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("compare"))).toBe(false);
});

test("uploads a selected CV file before saving the job", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/health")) return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    if (url.endsWith("/login")) return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) });
    if (url.endsWith("/me")) return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) });
    if (url.endsWith("/cv/upload")) {
      expect(init?.body).toBeInstanceOf(FormData);
      return Promise.resolve({ ok: true, json: async () => ({ text: "Ada CV" }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ id: 2, title: "Engineer", company_name: "Engines" }) });
  }));
  await renderSignedOutApp();
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: { files: [new File(["cv"], "ada.pdf", { type: "application/pdf" })] },
  });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Engineer" } });
  fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Engines" } });
  fireEvent.change(screen.getByLabelText("Job description"), { target: { value: "Build." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByText("Job saved");
  expect(calls.findIndex((url) => url.endsWith("/cv/upload"))).toBeLessThan(
    calls.findIndex((url) => url.endsWith("/jobs")),
  );
});

test("retries a failed job save without uploading the CV again", async () => {
  let jobAttempts = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "GET" && (url.endsWith("/jobs") || url.endsWith("/comparisons"))) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url.endsWith("/health")) return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    if (url.endsWith("/login")) return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) });
    if (url.endsWith("/me") || url.endsWith("/cv")) return Promise.resolve({ ok: true, json: async () => url.endsWith("/me") ? ({ id: 1, email: "ada@example.com" }) : ({ text: "Ada CV" }) });
    jobAttempts += 1;
    if (jobAttempts === 1) return Promise.resolve({ ok: false, json: async () => ({ detail: "Job save failed" }) });
    return Promise.resolve({ ok: true, json: async () => ({ id: 2, title: "Software Engineer", company_name: "Analytical Engines" }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  completeTextDraft();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  expect(await screen.findByRole("alert")).toHaveTextContent("Job save failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await screen.findByText("Job saved");
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/cv") && init?.method === "PUT")).toHaveLength(1);
  expect(jobAttempts).toBe(2);
});

const comparisonResult = {
  matched_requirements: [
    {
      requirement: "TypeScript",
      cv_evidence: "Built TypeScript web applications.",
      job_evidence: "Experience with TypeScript is required.",
    },
  ],
  possible_gaps: [
    {
      requirement: "Kubernetes",
      job_evidence: "Operate services on Kubernetes.",
      status: "not_found_in_cv",
    },
  ],
  interpretation:
    "A possible gap means evidence was not found in the saved CV; it does not establish that the person lacks the skill.",
};

function mockEmptyDashboard(options: {
  failUpload?: boolean;
  failCompare?: boolean;
  initialCv?: string;
  initialJobs?: Array<{ id: number; title: string; company_name: string }>;
  newerHistoryEntry?: boolean;
} = {}) {
  const job = { id: 73, title: "Engineer", company_name: "Example Company" };
  let cv: string | null = options.initialCv ?? null;
  let jobs = options.initialJobs ?? [];
  let comparedJob: typeof job | null = null;
  const writes: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const fail = (detail: string) => ({ ok: false, status: 503, json: async () => ({ detail }) });
    if (path === "/health") return ok({ status: "ok" });
    if (path === "/login") return ok({ id: 1, email: "ada@example.com" });
    expect(init?.credentials).toBe("include");
    if (path === "/me") return ok({ id: 1, email: "ada@example.com" });
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/jobs" && method === "POST") {
      expect(JSON.parse(String(init?.body))).toEqual({ title: job.title,
        company_name: job.company_name, description: "Build software." });
      jobs = [job, ...jobs];
      return ok(job);
    }
    if (path === "/jobs") return ok(jobs);
    if (path === "/cv" && method === "PUT") {
      cv = JSON.parse(String(init?.body)).text;
      return ok({ text: cv });
    }
    if (path === "/cv/upload") {
      expect(init?.body).toBeInstanceOf(FormData);
      if (options.failUpload) {
        options.failUpload = false;
        return fail("Upload temporarily unavailable");
      }
      cv = "Uploaded CV text";
      return ok({ text: cv });
    }
    if (path === "/cv") return cv === null
      ? { ok: false, status: 404, json: async () => ({ detail: "CV not found" }) }
      : ok({ text: cv });
    const compareMatch = path.match(/^\/jobs\/(\d+)\/compare$/);
    if (compareMatch) {
      const selectedJob = jobs.find((entry) => entry.id === Number(compareMatch[1]));
      expect(selectedJob && cv !== null).toBeTruthy();
      if (options.failCompare) {
        options.failCompare = false;
        return fail("AI provider is unavailable");
      }
      comparedJob = selectedJob!;
      return { ...ok(comparisonResult), headers: new Headers({ "X-Comparison-Id": "91" }) };
    }
    const entry = { id: 91, job_id: comparedJob?.id, created_at: "2026-10-07T12:00:00Z",
      cv_outdated: false, result: comparisonResult };
    if (path === `/jobs/${comparedJob?.id}/comparisons/91`) return ok(entry);
    const historyMatch = path.match(/^\/jobs\/(\d+)\/comparisons$/);
    if (historyMatch) return ok(comparedJob?.id === Number(historyMatch[1]) ? [entry] : []);
    if (path === "/comparisons") {
      if (!comparedJob) return ok([]);
      const summary = { ...entry,
        job_title: comparedJob.title, company_name: comparedJob.company_name,
        matched_requirements_count: 1, possible_gaps_count: 1, needs_review_count: 0,
      };
      // Another save may finish later; navigation must still use the response ID.
      return ok(options.newerHistoryEntry
        ? [{ ...summary, id: 92, created_at: "2026-10-07T12:01:00Z" }, summary]
        : [summary]);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { writes, fetchMock };
}

async function openEmptyDashboard() {
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Start a comparison" });
  return within(screen.getByRole("main"));
}

function fillEmptyJob(main: ReturnType<typeof within>) {
  fireEvent.change(main.getByLabelText("Job title"), { target: { value: "Engineer" } });
  fireEvent.change(main.getByLabelText("Company name"), { target: { value: "Example Company" } });
  fireEvent.change(main.getByLabelText("Job description"), { target: { value: "Build software." } });
}

test("empty Dashboard opens the exact saved comparison and refreshes sidebar screens", async () => {
  const { writes, fetchMock } = mockEmptyDashboard({ newerHistoryEntry: true });
  let main = await openEmptyDashboard();
  expect(main.queryByRole("button", { name: /^Save(?: |$)/ })).not.toBeInTheDocument();
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(main.getByRole("alert")).toHaveTextContent("Enter a job title");
  expect(writes).toEqual([]);
  fillEmptyJob(main);
  fireEvent.click(main.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(main.getByLabelText("Paste your CV text"), { target: { value: "My TypeScript CV" } });
  // Visit both pages before saving to ensure their existing instances refresh.
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  await screen.findByText("You have no saved jobs yet.");
  fireEvent.click(screen.getByRole("button", { name: "My CV" }));
  await screen.findByText("No CV saved yet.");
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  await screen.findByText("You have no saved comparisons yet.");
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  main = within(screen.getByRole("main"));
  expect(main.getByLabelText("Paste your CV text")).toHaveValue("My TypeScript CV");
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(main.getByRole("button", { name: "Working…" })).toBeDisabled();
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(await screen.findByRole("button", { name: "TypeScript" })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/jobs/73/comparisons/91",
    expect.objectContaining({ method: "GET", credentials: "include", headers: expect.any(Headers) }),
  );
  expect(screen.getByRole("button", { name: "Comparisons" })).toHaveAttribute("aria-current", "page");
  expect(writes).toEqual(["POST /jobs", "PUT /cv", "POST /jobs/73/compare"]);
  fireEvent.click(screen.getByRole("button", { name: "Back to Dashboard" }));
  expect(await screen.findByRole("heading", { name: "Start a comparison" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "Requirement details" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("region", { name: "Recent comparisons" })).toHaveTextContent("Engineer");
  expect(writes).toEqual(["POST /jobs", "PUT /cv", "POST /jobs/73/compare"]);
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  expect(await screen.findByRole("button", { name: "View job: Engineer at Example Company" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "My CV" }));
  fireEvent.click(await screen.findByRole("button", { name: "View current CV" }));
  expect(screen.getByRole("region", { name: "Saved CV text" })).toHaveTextContent("My TypeScript CV");
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  expect(await screen.findByRole("list", { name: "Saved comparisons" })).toHaveTextContent("Engineer");
});

test.each(["file", "text"] as const)("Dashboard preserves both CV drafts and submits only the active %s method", async (method) => {
  const { writes, fetchMock } = mockEmptyDashboard();
  const main = await openEmptyDashboard();
  fillEmptyJob(main);
  const uploadTab = main.getByRole("tab", { name: "Upload a file" });
  const textTab = main.getByRole("tab", { name: "Paste text" });
  expect(uploadTab).toHaveAttribute("aria-selected", "true");
  expect(main.getByRole("tabpanel", { name: "Upload a file" })).toBeVisible();
  expect(main.queryByRole("tabpanel", { name: "Paste text" })).not.toBeInTheDocument();
  const file = new File(["cv"], "preserved.pdf", { type: "application/pdf" });
  fireEvent.change(main.getByLabelText("Choose a file"), { target: { files: [file] } });

  fireEvent.keyDown(uploadTab, { key: "ArrowRight" });
  expect(textTab).toHaveFocus();
  expect(textTab).toHaveAttribute("aria-selected", "true");
  expect(main.getByRole("tabpanel", { name: "Paste text" })).toBeVisible();
  expect(main.queryByRole("tabpanel", { name: "Upload a file" })).not.toBeInTheDocument();
  // A populated inactive file must not make the blank text method valid.
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(main.getByRole("alert")).toBeVisible();
  expect(writes).toEqual([]);
  const text = method === "file" ? "x".repeat(50_001) : "Preserved CV text";
  fireEvent.change(main.getByLabelText("Paste your CV text"), { target: { value: text } });
  fireEvent.keyDown(textTab, { key: "Home" });
  expect(uploadTab).toHaveFocus();
  expect(uploadTab).toHaveAttribute("aria-selected", "true");
  expect(main.getByText("Selected: preserved.pdf")).toBeVisible();

  if (method === "text") {
    // An invalid inactive file must not prevent submission of valid text.
    fireEvent.change(main.getByLabelText("Choose a file"), {
      target: { files: [new File(["invalid"], "invalid.exe")] },
    });
  }
  fireEvent.keyDown(uploadTab, { key: "End" });
  expect(textTab).toHaveFocus();
  expect(main.getByLabelText("Paste your CV text")).toHaveValue(text);
  if (method === "file") fireEvent.click(uploadTab);
  expect(writes).toEqual([]);
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(writes).toEqual(["POST /jobs", method === "file" ? "POST /cv/upload" : "PUT /cv",
    "POST /jobs/73/compare"]);
  const cvRequest = fetchMock.mock.calls.find(([url, init]) => method === "file"
    ? String(url).endsWith("/cv/upload")
    : String(url).endsWith("/cv") && init?.method === "PUT");
  const cvBody = cvRequest?.[1]?.body;
  if (method === "file") expect((cvBody as FormData).get("file")).toBe(file);
  else expect(JSON.parse(String(cvBody))).toEqual({ text });
});

test("empty Dashboard reuses its saved job after upload and comparison failures", async () => {
  const { writes } = mockEmptyDashboard({ failUpload: true, failCompare: true });
  const main = await openEmptyDashboard();
  fillEmptyJob(main);
  const file = new File(["cv"], "cv.pdf", { type: "application/pdf" });
  fireEvent.change(main.getByLabelText("Choose a file"), { target: { files: [file] } });
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(await main.findByRole("alert")).toHaveTextContent("Your job is saved, but your CV could not be saved.");
  expect(main.getByRole("group", { name: "Job details" })).toHaveTextContent("Engineer");
  expect(main.getByRole("group", { name: "Job details" })).toHaveTextContent("Example Company");
  expect(main.getByText("Selected: cv.pdf")).toBeVisible();
  expect(writes).toEqual(["POST /jobs", "POST /cv/upload"]);
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  await waitFor(() => expect(main.getByRole("alert")).toHaveTextContent("Your job and CV are saved, but the comparison failed."));
  await waitFor(() => expect(main.getByRole("button", { name: "Compare" })).toBeEnabled());
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(writes).toEqual(["POST /jobs", "POST /cv/upload", "POST /cv/upload",
    "POST /jobs/73/compare", "POST /jobs/73/compare"]);
});

test("returning Dashboard explicitly selects a saved job by ID and reuses the saved CV", async () => {
  const { writes } = mockEmptyDashboard({
    initialCv: "My saved CV",
    initialJobs: [
      { id: 74, title: "Engineer", company_name: "Another Company" },
      { id: 73, title: "Engineer", company_name: "Example Company" },
    ],
  });
  const main = await openEmptyDashboard();
  const jobPicker = main.getByRole("combobox", { name: "Use saved job" });
  expect(jobPicker).toHaveValue("");
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  expect(writes).toEqual([]);
  fireEvent.change(jobPicker, { target: { value: "73" } });
  expect(jobPicker).toHaveValue("73");
  expect(main.getByRole("button", { name: "Compare" })).toBeEnabled();
  expect(main.queryByLabelText("Job description")).not.toBeInTheDocument();
  expect(main.queryByLabelText("Paste your CV text")).not.toBeInTheDocument();

  fireEvent.click(main.getByRole("button", { name: "Add new job" }));
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  fillEmptyJob(main);
  expect(main.getByRole("button", { name: "Compare" })).toBeEnabled();
  fireEvent.click(main.getByRole("button", { name: "Use saved job" }));
  expect(main.getByRole("combobox", { name: "Use saved job" })).toHaveValue("73");
  expect(main.queryByLabelText("Job description")).not.toBeInTheDocument();
  fireEvent.click(main.getByRole("button", { name: "Add new job" }));
  expect(main.getByLabelText("Job title")).toHaveValue("Engineer");
  expect(main.getByLabelText("Company name")).toHaveValue("Example Company");
  expect(main.getByLabelText("Job description")).toHaveValue("Build software.");
  fireEvent.click(main.getByRole("button", { name: "Use saved job" }));

  fireEvent.click(main.getByRole("button", { name: "Replace CV" }));
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  fireEvent.click(main.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(main.getByLabelText("Paste your CV text"), {
    target: { value: "Unsubmitted replacement CV" },
  });
  expect(main.getByRole("button", { name: "Compare" })).toBeEnabled();
  fireEvent.click(main.getByRole("tab", { name: "Upload a file" }));
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  expect(writes).toEqual([]);
  fireEvent.click(main.getByRole("tab", { name: "Paste text" }));
  expect(main.getByLabelText("Paste your CV text")).toHaveValue("Unsubmitted replacement CV");
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  await screen.findByText("You have no saved comparisons yet.");
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  expect(main.getByRole("combobox", { name: "Use saved job" })).toHaveValue("73");
  expect(main.getByLabelText("Paste your CV text")).toHaveValue("Unsubmitted replacement CV");
  fireEvent.click(main.getByRole("button", { name: "Cancel replacement" }));
  expect(main.queryByLabelText("Paste your CV text")).not.toBeInTheDocument();
  expect(main.getByRole("button", { name: "Compare" })).toBeEnabled();
  expect(writes).toEqual([]);
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(writes).toEqual(["POST /jobs/73/compare"]);
});

test("Dashboard with only a saved CV adds a job without saving the CV again", async () => {
  const { writes } = mockEmptyDashboard({ initialCv: "My saved CV" });
  const main = await openEmptyDashboard();
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  fillEmptyJob(main);
  expect(main.queryByLabelText("Paste your CV text")).not.toBeInTheDocument();
  expect(main.getByRole("button", { name: "Compare" })).toBeEnabled();
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(writes).toEqual(["POST /jobs", "POST /jobs/73/compare"]);
});

test("Dashboard with only saved jobs accepts a CV and reuses the explicitly selected job", async () => {
  const { writes } = mockEmptyDashboard({ initialJobs: [
    { id: 73, title: "Engineer", company_name: "Example Company" },
  ] });
  const main = await openEmptyDashboard();
  const jobPicker = main.getByRole("combobox", { name: "Use saved job" });
  expect(jobPicker).toHaveValue("");
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  fireEvent.change(jobPicker, { target: { value: "73" } });
  expect(main.getByRole("button", { name: "Compare" })).toBeDisabled();
  fireEvent.click(main.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(main.getByLabelText("Paste your CV text"), {
    target: { value: "My TypeScript CV" },
  });
  expect(main.getByRole("button", { name: "Compare" })).toBeEnabled();
  fireEvent.click(main.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(writes).toEqual(["PUT /cv", "POST /jobs/73/compare"]);
});

function savedDraftResponse(url: string) {
  if (url.endsWith("/comparisons")) {
    return { ok: true, json: async () => [] };
  }
  if (url.endsWith("/health")) {
    return { ok: true, json: async () => ({ status: "ok" }) };
  }
  if (url.endsWith("/login")) {
    return { ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) };
  }
  if (url.endsWith("/me")) {
    return { ok: true, json: async () => ({ id: 1, email: "ada@example.com" }) };
  }
  if (url.endsWith("/cv")) {
    return { ok: true, json: async () => ({ text: "Ada CV" }) };
  }
  return {
    ok: true,
    json: async () => ({
      id: 7,
      title: "Software Engineer",
      company_name: "Analytical Engines",
    }),
  };
}

async function saveTextDraftAndLogIn() {
  completeTextDraft();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByText("Job saved");
}

test("shows evidence-based comparison results only after Compare is clicked", async () => {
  let comparisonCount = 0;
  const job = { id: 7, title: "Software Engineer", company_name: "Analytical Engines" };
  const needsReview = {
    requirement: "Emergency response certification",
    reason: "The listed training does not establish the required certification.",
    job_evidence: "Emergency response certification required.",
    cv_evidence: "Completed workplace safety training.",
  };
  const savedResults = new Map<number, typeof comparisonResult & {
    needs_review: typeof needsReview[];
  }>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/jobs") && init?.method === "GET") {
      return Promise.resolve({ ok: true, json: async () => [job] });
    }
    const savedId = url.match(/\/jobs\/7\/comparisons\/(\d+)$/)?.[1];
    if (savedId) {
      return Promise.resolve({ ok: true, json: async () => ({
        id: Number(savedId), job_id: job.id, created_at: "2026-10-07T12:00:00Z",
        cv_outdated: false, result: savedResults.get(Number(savedId)),
      }) });
    }
    if (url.endsWith("/jobs/7/compare")) {
      comparisonCount += 1;
      expect(init).toMatchObject({
        method: "POST",
        credentials: "include", headers: expect.any(Headers),
      });
      const result = {
        ...comparisonResult,
        matched_requirements: comparisonCount === 1
          ? comparisonResult.matched_requirements : [],
        possible_gaps: comparisonCount < 3 ? comparisonResult.possible_gaps : [],
        needs_review: [needsReview],
      };
      const id = 100 + comparisonCount;
      savedResults.set(id, result);
      return Promise.resolve({ ok: true,
        headers: new Headers({ "X-Comparison-Id": String(id) }),
        json: async () => result });
    }
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  await saveTextDraftAndLogIn();
  expect(screen.queryByRole("heading", { name: "Saved comparison" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(await screen.findByText("Built TypeScript web applications."))
    .toBeVisible();
  const matchRow = screen.getByRole("button", { name: "TypeScript" });
  expect(matchRow).toHaveAttribute("aria-pressed", "true");
  expect(matchRow).toHaveAttribute("type", "button");
  const requestsBeforeSelection = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(matchRow).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText("Operate services on Kubernetes.")).toBeVisible();
  expect(screen.queryByText("Built TypeScript web applications."))
    .not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Needs review 1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: needsReview.requirement }));
  expect(screen.getByText(needsReview.reason)).toBeVisible();
  expect(screen.getByText(needsReview.cv_evidence))
    .toBeVisible();
  expect(screen.getByText(needsReview.job_evidence))
    .toBeVisible();
  expect(screen.getByText(comparisonResult.interpretation)).toBeVisible();
  expect(fetchMock.mock.calls).toHaveLength(requestsBeforeSelection);
  expect(screen.getAllByRole("region", { name: "Requirement details" }))
    .toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  expect(await screen.findByRole("button", { name: "View job: Software Engineer at Analytical Engines" }))
    .toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  expect(await screen.findByRole("heading", { name: "Start a comparison" })).toBeVisible();
  expect(screen.queryByText(needsReview.reason)).not.toBeInTheDocument();
  expect(comparisonCount).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("button", {
    name: "Kubernetes", pressed: true,
  })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to Dashboard" }));
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("button", {
    name: needsReview.requirement, pressed: true,
  })).toBeVisible();
});

test("disables Compare while a comparison request is running", async () => {
  let resolveComparison: ((value: Response) => void) | undefined;
  const result = { ...comparisonResult, matched_requirements: [], possible_gaps: [] };
  const comparisonRequest = new Promise<Response>((resolve) => {
    resolveComparison = resolve;
  });
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/jobs/7/compare")) return comparisonRequest;
    if (url.endsWith("/jobs/7/comparisons/91")) {
      return Promise.resolve({ ok: true, json: async () => ({
        id: 91, job_id: 7, created_at: "2026-10-07T12:00:00Z", cv_outdated: false,
        result,
      }) });
    }
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  await saveTextDraftAndLogIn();
  const button = screen.getByRole("button", { name: "Compare" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(await screen.findByText("Comparing your CV and job…")).toBeVisible();
  expect(button).toBeDisabled();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("compare"))).toHaveLength(1);
  resolveComparison?.({
    ok: true,
    headers: new Headers({ "X-Comparison-Id": "91" }),
    json: async () => result,
  } as Response);
  expect(await screen.findByRole("heading", { name: "Saved comparison" })).toBeVisible();
  expect(await screen.findByText("No matched requirements were returned."))
    .toBeVisible();
  expect(screen.getByText("No possible gaps were returned.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: /Needs review/ }))
    .not.toBeInTheDocument();
  expect(screen.getByText(comparisonResult.interpretation)).toBeVisible();
});

test("shows comparison API errors without retrying or saving another draft", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/jobs") && init?.method === "GET") {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url.endsWith("/jobs/7/compare")) {
      return Promise.resolve({
        ok: false,
        json: async () => ({ detail: "AI comparisons are disabled" }),
      });
    }
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  await saveTextDraftAndLogIn();
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Comparison unavailable: AI comparisons are disabled",
  );
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/cv") && init?.method === "PUT")).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/jobs") && init?.method === "POST")).toHaveLength(1);
});

test("loads Jobs in API order and retries errors including expired auth", async () => {
  const jobs = [
    { id: 9, title: "Researcher", company_name: "North Lab" },
    { id: 2, title: "Technician", company_name: "South Lab" },
  ];
  let attempts = 0;
  let detailAttempts = 0;
  const description = "First paragraph.\n\nSecond paragraph.\nAnother line.";
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/jobs/9")) {
      expect(init).toMatchObject({
        method: "GET", credentials: "include", headers: expect.any(Headers),
      });
      detailAttempts += 1;
      return Promise.resolve(detailAttempts === 1
        ? { ok: false, json: async () => ({ detail: "Invalid or expired token" }) }
        : detailAttempts === 2
          ? { ok: false, status: 404 }
          : { ok: true, json: async () => ({ ...jobs[0], description }) });
    }
    if (String(input).endsWith("/jobs") && init?.method === "GET") {
      expect(init.credentials).toBe("include");
      attempts += 1;
      // The first read belongs to the Dashboard overview.
      if (attempts === 1) return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve(attempts === 2
        ? { ok: false, json: async () => ({ detail: "Invalid or expired token" }) }
        : { ok: true, json: async () => attempts === 3 ? jobs : [] });
    }
    return Promise.resolve(savedDraftResponse(String(input)));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Dashboard" });
  const beforeJobs = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  expect(screen.getByText("Loading saved jobs…")).toBeVisible();
  expect(await screen.findByRole("alert"))
    .toHaveTextContent("Invalid or expired token");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const list = await screen.findByRole("list", { name: "Saved jobs" });
  expect([...list.querySelectorAll("h2")].map((node) => node.textContent))
    .toEqual(jobs.map((job) => job.title));
  expect(screen.getByText("North Lab")).toBeVisible();
  fireEvent.click(screen.getByRole("button", {
    name: "View job: Researcher at North Lab",
  }));
  expect(screen.getByText("Loading job details…")).toBeVisible();
  expect(await screen.findByRole("alert"))
    .toHaveTextContent("Invalid or expired token");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("alert"))
    .toHaveTextContent("This job was not found");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const details = await screen.findByRole("region", { name: "Job description" });
  expect(details.querySelector(".job-description-text")?.textContent)
    .toBe(description);
  expect(screen.getByRole("heading", { name: "Researcher", level: 1 }))
    .toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to jobs" }));
  const returnedList = screen.getByRole("list", { name: "Saved jobs" });
  expect([...returnedList.querySelectorAll(".saved-job-summary")]
    .map((node) => node.textContent))
    .toEqual([...list.querySelectorAll(".saved-job-summary")]
      .map((node) => node.textContent));
  expect(attempts).toBe(3);
  expect(screen.getByRole("button", { name: "Jobs" }))
    .toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  expect(await screen.findByText("You have no saved jobs yet."))
    .toBeVisible();
  expect(fetchMock.mock.calls.slice(beforeJobs).every(
    ([, init]) => init?.method === "GET",
  )).toBe(true);
});

test("discards the homepage handoff and pending Jobs response after another login", async () => {
  let resolveJobs!: (response: unknown) => void;
  let jobsSignal: AbortSignal | undefined;
  let account = 0;
  const pending = new Promise((resolve) => { resolveJobs = resolve; });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/login")) {
      account += 1;
      return Promise.resolve({
        ok: true, json: async () => ({ id: account, email: `user-${account}@example.com` }),
      });
    }
    if (String(input).endsWith("/me")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: account, email: `user${account}@example.com` }),
      });
    }
    if (String(input).endsWith("/jobs") && init?.method === "GET") {
      if (!jobsSignal) {
        jobsSignal = init.signal as AbortSignal;
        return pending;
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    return Promise.resolve(savedDraftResponse(String(input)));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  await saveTextDraftAndLogIn();
  await waitFor(() => expect(jobsSignal).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  await waitFor(() => expect(jobsSignal?.aborted).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Dashboard" });
  expect(await screen.findByRole("heading", { name: "Start a comparison" })).toBeVisible();
  expect(screen.queryByText("Job saved")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Job title")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  resolveJobs({ ok: false, status: 401, json: async () => [
    { id: 1, title: "Previous account job", company_name: "Previous company" },
  ] });
  expect(await screen.findByText("You have no saved jobs yet."))
    .toBeVisible();
  expect(screen.queryByText("Previous account job")).not.toBeInTheDocument();
  expect(screen.getByText("user2@example.com")).toBeVisible();
});

test("discards stale job details when switching Jobs or logging out", async () => {
  const jobs = [
    { id: 9, title: "Researcher", company_name: "North Lab" },
    { id: 2, title: "Technician", company_name: "South Lab" },
  ];
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/jobs")) {
      return Promise.resolve({ ok: true, json: async () => jobs });
    }
    if (url.endsWith("/jobs/9")) {
      signal = init?.signal as AbortSignal;
      return new Promise((resolve) => { finish = resolve; });
    }
    if (url.endsWith("/jobs/2")) {
      return Promise.resolve({
        ok: true, json: async () => ({ ...jobs[1], description: "Current job" }),
      });
    }
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Dashboard" });
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  fireEvent.click(await screen.findByRole("button", { name: /View job: Researcher/ }));
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  expect(signal?.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /View job: Technician/ }));
  finish({ ok: true, json: async () => ({ ...jobs[0], description: "Stale job" }) });
  expect(await screen.findByText("Current job")).toBeVisible();
  expect(screen.queryByText("Stale job")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to jobs" }));
  fireEvent.click(screen.getByRole("button", { name: /View job: Researcher/ }));
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  await waitFor(() => expect(signal?.aborted).toBe(true));
  finish({ ok: true, json: async () => ({ ...jobs[0], description: "Stale job" }) });
  await waitFor(() => expect(screen.queryByText("Stale job"))
    .not.toBeInTheDocument());
});

test("opens saved comparison categories and returns without comparing", async () => {
  const job = { id: 7, title: "Researcher", company_name: "North Lab" };
  const entry = {
    id: 42, job_id: 7, created_at: "2026-10-06T10:30:00Z",
    cv_outdated: false, result: comparisonResult,
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/jobs") && init?.method === "GET") {
      return Promise.resolve({ ok: true, json: async () => [job] });
    }
    if (url.endsWith("/jobs/7")) {
      return Promise.resolve({
        ok: true, json: async () => ({ ...job, description: "Saved description" }),
      });
    }
    if (url.endsWith("/comparisons")) {
      return Promise.resolve({ ok: true, json: async () => [entry] });
    }
    if (url.endsWith("/comparisons/42")) {
      return Promise.resolve({ ok: true, json: async () => entry });
    }
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  await saveTextDraftAndLogIn();
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  fireEvent.click(await screen.findByRole("button", { name: /View job:/ }));
  fireEvent.click(await screen.findByRole("button", { name: /View comparison:/ }));

  expect(await screen.findByRole("region", { name: /Matched requirements/ }))
    .toHaveTextContent(comparisonResult.matched_requirements[0].requirement);
  expect(screen.getByRole("region", { name: /Possible gaps/ }))
    .toHaveTextContent(comparisonResult.possible_gaps[0].requirement);
  fireEvent.click(screen.getByRole("button", { name: "Back to job" }));
  expect(screen.getByRole("heading", { name: job.title })).toBeVisible();
  expect(fetchMock.mock.calls.filter(([url, init]) =>
    String(url).endsWith("/compare") && init?.method === "POST",
  )).toHaveLength(0);
});

const deletionJob = { id: 7, title: "Researcher", company_name: "North Lab" };
const deletionSummaries = [42, 43].map((id) => ({
  id, job_id: 7, job_title: deletionJob.title,
  company_name: deletionJob.company_name,
  created_at: `2026-10-0${id - 40}T10:30:00Z`,
  matched_requirements_count: 1, possible_gaps_count: 1, needs_review_count: 0,
}));
const deletionDetails = deletionSummaries.map((entry) => ({
  id: entry.id, job_id: 7, created_at: entry.created_at,
  cv_outdated: false, result: comparisonResult,
}));

async function renderDeletionHistory(
  remove: () => Promise<Response>, count = 2,
) {
  enableDialogMock();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") return remove();
    // Deliberately return pre-delete data on subsequent reads to exercise
    // stale-response suppression as well as invalidation of mounted caches.
    if (url === "/api/comparisons") return Promise.resolve(Response.json(deletionSummaries.slice(0, count)));
    if (url === "/api/jobs/7/comparisons") return Promise.resolve(Response.json(deletionDetails.slice(0, count)));
    if (url === "/api/jobs") return Promise.resolve(Response.json([deletionJob]));
    if (url === "/api/jobs/7") return Promise.resolve(Response.json({ ...deletionJob, description: "Saved job description" }));
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Start a comparison" });
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  await screen.findByRole("list", { name: "Saved comparisons" });
  return fetchMock;
}

function openDeleteDialog() {
  const trigger = screen.getByRole("button", { name: /Delete comparison.*comparison 42/ });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Delete comparison?" }) };
}

test("confirms the selected comparison and cancels without deleting, restoring focus", async () => {
  const remove = vi.fn();
  await renderDeletionHistory(remove);
  const { trigger, dialog } = openDeleteDialog();
  expect(dialog).toHaveTextContent("Researcher at North Lab");
  expect(dialog).toHaveTextContent("Comparison 42");
  expect(dialog).toHaveTextContent("Your saved job and CV will remain. You can’t undo this action.");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: /Delete comparison for/ })).toHaveLength(2);
});

test("deletes the exact comparison without parsing 204 and refreshes summaries and cached history", async () => {
  const response = new Response(null, { status: 204 });
  const parse = vi.spyOn(response, "json");
  const fetchMock = await renderDeletionHistory(async () => response);
  // Populate the per-job history cache before deleting from Comparisons.
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  fireEvent.click(await screen.findByRole("button", { name: /View job: Researcher/ }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: /View comparison:/ })).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  await screen.findByRole("list", { name: "Saved comparisons" });
  const { dialog } = openDeleteDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete comparison" }));
  expect(await screen.findByText("Comparison deleted.")).toHaveAttribute("role", "status");
  expect(screen.queryByRole("button", { name: /Delete comparison.*comparison 42/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Delete comparison.*comparison 43/ })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Comparisons" })).toHaveFocus());
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe("/api/jobs/7/comparisons/42");
  expect(writes[0][1]?.credentials).toBe("include");
  expect(new Headers(writes[0][1]?.headers).get("X-CSRF-Protection")).toBe("1");
  expect(parse).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  const summary = screen.getByRole("link", { name: /^Comparisons/ });
  await waitFor(() => expect(within(summary).getByText("1")).toBeVisible());
  expect(within(screen.getByRole("link", { name: /^Saved jobs/ })).getByText("1")).toBeVisible();
  expect(within(screen.getByRole("link", { name: /^My CV/ })).getByText("Saved")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: /View comparison:/ })).toHaveLength(1));
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/jobs/7/comparisons")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  await screen.findByRole("list", { name: "Saved comparisons" });
  expect(screen.getAllByRole("button", { name: /Delete comparison for/ })).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([, init]) => !["GET", "DELETE", "POST"].includes(init?.method ?? "GET"))).toHaveLength(0);
  expect(fetchMock.mock.calls.filter(([url, init]) => init?.method === "POST" && url !== "/api/login")).toHaveLength(0);
});

test("keeps the comparison during pending and error states, then retries to the empty state", async () => {
  let finish!: (response: Response) => void;
  const remove = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await renderDeletionHistory(remove, 1);
  const { dialog } = openDeleteDialog();
  const confirm = within(dialog).getByRole("button", { name: "Delete comparison" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(within(dialog).getByRole("status")).toHaveTextContent("Deleting comparison");
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(dialog).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Delete comparison.*comparison 42/ })).toBeInTheDocument();
  finish(Response.json({ detail: "Service temporarily unavailable" }, { status: 503 }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Service temporarily unavailable");
  expect(screen.getByRole("button", { name: /Delete comparison.*comparison 42/ })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete comparison" }));
  expect(remove).toHaveBeenCalledTimes(2);
  finish(new Response(null, { status: 204 }));
  expect(await screen.findByText("You have no saved comparisons yet.")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("reconciles a missing comparison and explains why it disappeared", async () => {
  await renderDeletionHistory(async () => new Response(null, { status: 404 }), 1);
  const { dialog } = openDeleteDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete comparison" }));
  expect(await screen.findByText("This comparison is no longer available. The list has been updated.")).toHaveAttribute("role", "status");
  expect(screen.getByText("You have no saved comparisons yet.")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("ignores late pre-delete summary, history and detail responses only in their own session", async () => {
  resetSessionRequests();
  const finish: Array<() => void> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    const url = String(input);
    const value = url === "/api/comparisons" ? deletionSummaries
      : url.endsWith("/42") ? deletionDetails[0] : deletionDetails;
    return Promise.resolve({ ok: true, json: () => new Promise((resolve) => {
      finish.push(() => resolve(value));
    }) });
  }));
  const signal = new AbortController().signal;
  const summary = getComparisonSummaries(signal);
  const history = getSavedComparisons(7, signal);
  const detail = getSavedComparison(7, 42, signal);
  const unavailable = expect(detail).rejects.toMatchObject({ status: 404 });
  await waitFor(() => expect(finish).toHaveLength(3));
  await deleteSavedComparison(7, 42, signal);
  finish.forEach((resolve) => resolve());
  expect((await summary).map((entry) => entry.id)).toEqual([43]);
  expect((await history).map((entry) => entry.id)).toEqual([43]);
  await unavailable;
  resetSessionRequests();
  const nextSession = getComparisonSummaries(signal);
  await waitFor(() => expect(finish).toHaveLength(4));
  finish[3]();
  expect((await nextSession).map((entry) => entry.id)).toEqual([42, 43]);
});

async function renderJobDeletion(remove: () => Promise<Response>, count = 2) {
  enableDialogMock();
  const jobs = [deletionJob, { id: 8, title: "Designer", company_name: "South Lab" }].slice(0, count);
  const summaries = [...deletionSummaries, ...(count === 2 ? [{
    ...deletionSummaries[0], id: 44, job_id: 8,
    job_title: "Designer", company_name: "South Lab",
  }] : [])];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") return remove();
    if (url.endsWith("/compare")) return Promise.resolve(Response.json({ detail: "Mock comparison failure" }, { status: 503 }));
    // Keep returning stale snapshots: deleted jobs and related history must
    // not reappear on navigation or in refreshed overview data.
    if (url === "/api/jobs") return Promise.resolve(Response.json(jobs));
    if (url === "/api/comparisons") return Promise.resolve(Response.json(summaries));
    const history = url.match(/^\/api\/jobs\/(\d+)\/comparisons$/);
    if (history) return Promise.resolve(Response.json(summaries.filter((entry) => entry.job_id === Number(history[1])).map((entry) => ({
      ...entry, cv_outdated: false, result: comparisonResult,
    }))));
    return Promise.resolve(savedDraftResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Start a comparison" });
  return fetchMock;
}

async function openJobDeletion() {
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete job: Researcher at North Lab" }));
  return screen.getByRole("dialog", { name: "Delete job?" });
}

test("job deletion clears related history and retry selection while preserving other records and drafts", async () => {
  const response = new Response(null, { status: 204 });
  const parse = vi.spyOn(response, "json");
  const fetchMock = await renderJobDeletion(async () => response);
  fireEvent.change(screen.getByLabelText("Use saved job"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Mock comparison failure");
  fireEvent.click(screen.getByRole("button", { name: "Add new job" }));
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Unfinished job" } });
  fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Draft company" } });
  fireEvent.click(screen.getByRole("button", { name: "Use saved job" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace CV" }));
  fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(screen.getByLabelText("Paste your CV text"), { target: { value: "Unfinished CV draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  await screen.findByRole("list", { name: "Saved comparisons" });
  const dialog = await openJobDeletion();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete job" }));
  expect(await screen.findByText("Job deleted.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /View job: Researcher/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /View job: Designer/ })).toBeVisible();
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe("/api/jobs/7");
  expect(new Headers(writes[0][1]?.headers).get("X-CSRF-Protection")).toBe("1");
  expect(parse).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  const history = await screen.findByRole("list", { name: "Saved comparisons" });
  expect(within(history).getAllByRole("button", { name: /View comparison/ })).toHaveLength(1);
  expect(history).toHaveTextContent("Designer");
  expect(history).not.toHaveTextContent("Researcher");
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  await waitFor(() => expect(within(screen.getByRole("link", { name: /^Saved jobs/ })).getByText("1")).toBeVisible());
  expect(within(screen.getByRole("link", { name: /^Comparisons/ })).getByText("1")).toBeVisible();
  expect(within(screen.getByRole("link", { name: /^My CV/ })).getByText("Saved")).toBeVisible();
  expect(screen.getByLabelText("Use saved job")).toHaveValue("");
  expect(screen.queryByRole("option", { name: /Researcher/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Mock comparison failure/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Paste your CV text")).toHaveValue("Unfinished CV draft");
  expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add new job" }));
  expect(screen.getByLabelText("Job title")).toHaveValue("Unfinished job");
  expect(screen.getByLabelText("Company name")).toHaveValue("Draft company");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/compare"))).toHaveLength(1);
});

test("job deletion cancellation keeps the job without sending a request", async () => {
  const remove = vi.fn();
  await renderJobDeletion(remove);
  const dialog = await openJobDeletion();
  expect(dialog).toHaveTextContent("Researcher at North Lab");
  expect(dialog).toHaveTextContent("This deletes this saved job and all its saved comparisons. Your saved CV will remain. You can’t undo this action.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /View job: Researcher/ })).toBeVisible();
  expect(remove).not.toHaveBeenCalled();
});

test("job deletion retains the row on failure and reconciles an already-missing job on retry", async () => {
  let finish!: (response: Response) => void;
  const remove = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await renderJobDeletion(remove, 1);
  const dialog = await openJobDeletion();
  const confirm = within(dialog).getByRole("button", { name: "Delete job" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /View job: Researcher/ })).toBeInTheDocument();
  finish(Response.json({ detail: "Temporarily unavailable" }, { status: 503 }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Temporarily unavailable");
  expect(screen.getByRole("button", { name: /View job: Researcher/ })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete job" }));
  finish(new Response(null, { status: 404 }));
  expect(await screen.findByText("You have no saved jobs yet.")).toBeVisible();
  expect(screen.getByText("This job is no longer available. The list has been updated.")).toHaveAttribute("role", "status");
  expect(remove).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  expect(await screen.findByText("You have no saved comparisons yet.")).toBeVisible();
});

async function renderCvDeletion(
  remove: () => Promise<Response>,
  work: () => Promise<Response> = async () => new Response(null, { status: 204 }),
) {
  enableDialogMock();
  let cv: string | null = "Original saved CV";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      const response = await remove();
      if ([204, 404].includes(response.status)) cv = null;
      return response;
    }
    if (init?.method === "PUT" || url.endsWith("/compare")) {
      const response = await work();
      if (response.ok && init?.method === "PUT") cv = JSON.parse(String(init.body)).text;
      return response;
    }
    if (url === "/api/cv") return cv === null ? new Response(null, { status: 404 }) : Response.json({ text: cv });
    if (url === "/api/jobs") return Response.json([deletionJob]);
    if (url === "/api/comparisons") return Response.json(deletionSummaries);
    if (url.match(/^\/api\/jobs\/7\/comparisons\/\d+$/)) return Response.json({
      ...deletionDetails[0], id: Number(url.split("/").at(-1)), cv_outdated: cv === null,
    });
    return savedDraftResponse(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderSignedOutApp();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  enterLogin();
  await screen.findByRole("heading", { name: "Start a comparison" });
  return fetchMock;
}

async function showCurrentCv() {
  fireEvent.click(screen.getByRole("button", { name: "My CV" }));
  await screen.findByRole("button", { name: "View current CV" });
}

function confirmCvDeletion() {
  fireEvent.click(screen.getByRole("button", { name: "Delete current CV" }));
  const dialog = screen.getByRole("dialog", { name: "Delete current CV?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete CV" }));
  return dialog;
}

test("CV deletion clears saved state and stale reads, preserves drafts and invalidates comparison details", async () => {
  const response = new Response(null, { status: 204 });
  const parse = vi.spyOn(response, "json");
  const fetchMock = await renderCvDeletion(async () => response);
  fireEvent.change(screen.getByLabelText("Use saved job"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace CV" }));
  fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(screen.getByLabelText("Paste your CV text"), { target: { value: "Dashboard CV draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  fireEvent.click((await screen.findAllByRole("button", { name: /View comparison for/ }))[0]);
  await screen.findByRole("region", { name: /Matched requirements/ });
  await showCurrentCv();
  const file = new File(["draft"], "unsaved.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByRole("main").querySelector('input[type="file"]')!, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(screen.getByLabelText("CV text"), { target: { value: "My CV unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "View current CV" }));
  expect(screen.getByRole("region", { name: "Saved CV text" })).toHaveTextContent("Original saved CV");
  fireEvent.click(screen.getByRole("button", { name: "Back to My CV" }));
  let finishRead!: () => void;
  const stale = Response.json({ text: "Original saved CV" });
  vi.spyOn(stale, "json").mockImplementation(() => new Promise((resolve) => {
    finishRead = () => resolve({ text: "Original saved CV" });
  }));
  fetchMock.mockResolvedValueOnce(stale);
  const lateRead = getSavedCv(new AbortController().signal);
  await waitFor(() => expect(finishRead).toBeTypeOf("function"));
  confirmCvDeletion();
  expect(await screen.findByText("No CV saved yet.")).toBeVisible();
  finishRead();
  expect(await lateRead).toBeNull();
  expect(screen.queryByRole("button", { name: "View current CV" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete current CV" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("CV text")).toHaveValue("My CV unsaved draft");
  fireEvent.click(screen.getByRole("tab", { name: "Upload file" }));
  expect(screen.getByText("Selected: unsaved.pdf")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  await waitFor(() => expect(within(screen.getByRole("link", { name: /^My CV/ })).getByText("Not added")).toBeVisible());
  expect(within(screen.getByRole("link", { name: /^Saved jobs/ })).getByText("1")).toBeVisible();
  expect(within(screen.getByRole("link", { name: /^Comparisons/ })).getByText("2")).toBeVisible();
  expect(screen.getByLabelText("Use saved job")).toHaveValue("7");
  expect(screen.getByLabelText("Paste your CV text")).toHaveValue("Dashboard CV draft");
  expect(screen.queryByText("Using your saved CV")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Comparisons" }));
  expect(await screen.findByText(/CV used for this comparison is no longer/)).toBeVisible();
  expect(screen.getByRole("region", { name: /Matched requirements/ })).toBeVisible();
  const mutations = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
  expect(mutations.map(([url]) => url)).toEqual(["/api/login", "/api/cv"]);
  expect(mutations[1][1]?.method).toBe("DELETE");
  expect(new Headers(mutations[1][1]?.headers).get("X-CSRF-Protection")).toBe("1");
  expect(parse).not.toHaveBeenCalled();
});

test("CV deletion cancels without changes and is disabled during saves and comparisons", async () => {
  const remove = vi.fn();
  let finish!: (response: Response) => void;
  await renderCvDeletion(remove, () => new Promise((resolve) => { finish = resolve; }));
  await showCurrentCv();
  fireEvent.click(screen.getByRole("button", { name: "Delete current CV" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("Comparisons may still contain excerpts from this CV");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "View current CV" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(screen.getByLabelText("CV text"), { target: { value: "Explicit replacement" } });
  fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
  expect(screen.getByRole("button", { name: "Delete current CV" })).toBeDisabled();
  finish(new Response(null, { status: 204 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete current CV" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  fireEvent.change(screen.getByLabelText("Use saved job"), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await showCurrentCv();
  expect(screen.getByRole("button", { name: "Delete current CV" })).toBeDisabled();
  finish(Response.json({ detail: "Mock comparison failed" }, { status: 503 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete current CV" })).toBeEnabled());
  expect(remove).not.toHaveBeenCalled();
});

test("CV deletion keeps the saved CV on failure and reconciles 404 on retry", async () => {
  let finish!: (response: Response) => void;
  const remove = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await renderCvDeletion(remove);
  await showCurrentCv();
  fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
  fireEvent.change(screen.getByLabelText("CV text"), { target: { value: "Unsubmitted draft" } });
  const dialog = confirmCvDeletion();
  fireEvent.click(within(dialog).getByRole("button", { name: "Deleting…" }));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Save replacement" })).toBeDisabled();
  expect(within(dialog).getByRole("status")).toHaveTextContent("Deleting CV");
  finish(Response.json({ detail: "Temporarily unavailable" }, { status: 503 }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Temporarily unavailable");
  expect(screen.getByRole("button", { name: "View current CV" })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete CV" }));
  finish(new Response(null, { status: 404 }));
  expect(await screen.findByText("No CV saved yet.")).toBeVisible();
  expect(screen.getByText("Your saved CV is no longer available. The display has been updated.")).toHaveAttribute("role", "status");
  expect(screen.getByLabelText("CV text")).toHaveValue("Unsubmitted draft");
  expect(remove).toHaveBeenCalledTimes(2);
});
