// Integration tests against the real cool-nwc SDK (simulator mode).
//
// These hit the actual Express app on an ephemeral port — no mocking of
// cool.record() / cool.verify() — so a green run here is real evidence that
// the seal -> inspect -> tamper -> verify loop works end to end, not just
// that the UI renders. Run with: npm test
//
// Uses Node's built-in test runner (node:test), so there is no extra
// dependency to install or vet.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import app from "../server.mjs";

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}

async function get(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, json: await res.json() };
}

test("health check reports the SDK's real attestation mode", async () => {
  const { status, json } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // Honesty check: without dstack hardware configured this MUST say
  // "simulated", never "ok"/"pass" on the hardware-dependent checks.
  assert.equal(json.mode, "simulated");
});

test("preview scores an applicant without minting any evidence", async () => {
  const { status, json } = await post("/api/preview", {
    name: "Asha",
    income: 90000,
    loanAmount: 120000,
    purpose: "home",
  });
  assert.equal(status, 200);
  assert.ok(json.score >= 0 && json.score <= 1);
  assert.ok(["approved", "denied"].includes(json.decision));
});

test("apply seals a real cool.receipt.v2 via cool.record()", async () => {
  const { status, json } = await post("/api/apply", {
    name: "Rahul",
    income: 50000,
    loanAmount: 100000,
    purpose: "education",
  });
  assert.equal(status, 200);
  assert.equal(json.evidence.schema, "cool.receipt.v2");
  assert.ok(json.recordId, "recordId should be present");
  assert.ok(json.digest, "binding digest should be present");
  // The hardware-dependent field must be honestly labelled, not "pass".
  assert.equal(json.evidence.attestation.mode, "simulated");
});

test("apply rejects incomplete applications with 400, not a crash", async () => {
  const { status, json } = await post("/api/apply", { name: "No Income" });
  assert.equal(status, 400);
  assert.match(json.error, /required/);
});

test("a freshly sealed receipt verifies clean across all domains", async () => {
  const applied = await post("/api/apply", {
    name: "Meera",
    income: 70000,
    loanAmount: 90000,
    purpose: "business",
  });
  const { status, json } = await post("/api/verify", {
    evidence: applied.json.evidence,
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // Every domain the SDK actually attempts must come back "pass"; the two
  // hardware-dependent ones (attestation/enclave) are honestly "simulated",
  // never "pass" — that distinction is the whole point of this demo.
  assert.equal(json.checks.binding.status, "pass");
  assert.equal(json.checks.signature.status, "pass");
  assert.equal(json.checks.inclusion.status, "pass");
  assert.equal(json.checks.attestation.status, "simulated");
  assert.equal(json.checks.enclave.status, "simulated");
});

test("paste-and-verify works from evidence alone, no recordId or server state", async () => {
  const applied = await post("/api/apply", {
    name: "Zoya",
    income: 40000,
    loanAmount: 200000,
    purpose: "personal",
  });
  // Simulate a totally fresh client: only the raw evidence JSON travels,
  // exactly like the "paste & verify" panel in the UI.
  const { status, json } = await post("/api/verify", {
    evidence: JSON.parse(JSON.stringify(applied.json.evidence)),
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test("tampering metadata_hash breaks binding and signature checks", async () => {
  const applied = await post("/api/apply", {
    name: "Kabir",
    income: 60000,
    loanAmount: 60000,
    purpose: "home",
  });
  const tampered = await post("/api/tamper", {
    evidence: applied.json.evidence,
    path: ["record", "event", "metadata_hash"],
  });
  assert.equal(tampered.status, 200);

  const verdict = await post("/api/verify", { evidence: tampered.json.evidence });
  assert.equal(verdict.json.ok, false);
  assert.equal(verdict.json.checks.binding.status, "fail");
  assert.equal(verdict.json.checks.signature.status, "fail");
});

test("tampering the STH root hash breaks only inclusion, not signature", async () => {
  const applied = await post("/api/apply", {
    name: "Ingrid",
    income: 80000,
    loanAmount: 40000,
    purpose: "business",
  });
  const tampered = await post("/api/tamper", {
    evidence: applied.json.evidence,
    path: ["sth", "root_hash"],
  });
  assert.equal(tampered.status, 200, `tamper call failed: ${JSON.stringify(tampered.json)}`);
  const verdict = await post("/api/verify", { evidence: tampered.json.evidence });
  assert.equal(verdict.json.ok, false);
  assert.equal(verdict.json.checks.inclusion.status, "fail");
  // The record's own signature over its own fields is untouched by an STH
  // change — this is exactly the "seven independent domains" claim in the
  // README, and this test is what makes that claim checkable, not asserted.
  assert.equal(verdict.json.checks.signature.status, "pass");
});

test("unknown API routes return JSON 404s, never an HTML error page", async () => {
  const { status, json } = await get("/api/nope");
  assert.equal(status, 404);
  assert.equal(json.error, "unknown API route");
});

test("history rail reflects sealed receipts and can be cleared", async () => {
  await post("/api/apply", { name: "Test", income: 1, loanAmount: 1 });
  const before = await get("/api/history");
  assert.ok(before.json.receipts.length > 0);

  const cleared = await post("/api/history/clear");
  assert.equal(cleared.json.ok, true);

  const after = await get("/api/history");
  assert.equal(after.json.receipts.length, 0);
});
