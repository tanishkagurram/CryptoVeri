/**
 * CooL Financial Demo — server
 *
 * A small "AI credit decision" API that seals every decision as CooL
 * execution evidence, the same way the pitch deck describes:
 *
 *   SEAL   cool.record()   -> hybrid ML-DSA-65 + Ed25519 signed receipt
 *   LOG    (inside record) -> RFC 6962 transparency log, inclusion proof
 *   VERIFY cool.verify()   -> offline, 7 independent domains, never a bare bool
 *
 * This uses the real, published `cool-nwc` SDK — nothing here is mocked.
 * Without a dstack endpoint configured, the SDK runs its built-in simulator,
 * which is real cryptography, clearly labelled `simulated` wherever it
 * appears (see the README's "Phala dstack" section).
 */
import { createHash, randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { CooL, formatVerdict } from "cool-nwc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cool = new CooL({ applicationId: "cool-fin-demo" });

// Guard SDK startup so a cold start (e.g. on a fresh Vercel instance) can't
// hard-crash the function — instead /api/health reports it and the
// evidence-producing routes fail with a clear, honest error.
let coolReady = false;
let coolInitError = null;
try {
  await cool.ready();
  coolReady = true;
} catch (err) {
  coolInitError = err;
  console.error("cool-nwc SDK failed to initialize:", err);
}

function requireCool(res) {
  if (coolReady) return true;
  res.status(503).json({
    error: "The cool-nwc SDK is not ready on this instance yet.",
    detail: coolInitError?.message ?? "unknown initialization error",
  });
  return false;
}

// In-memory store of receipts issued this session, keyed by recordId.
// A real deployment would persist these; for a local demo, memory is enough.
const receipts = new Map();

/**
 * A tiny, deterministic "credit risk model" — deterministic so the same
 * applicant always gets the same score, with a small amount of jitter so
 * repeated identical applications aren't byte-identical decisions.
 */
function scoreApplicant({ name, income, loanAmount, purpose }) {
  const incomeN = Number(income) || 0;
  const loanN = Number(loanAmount) || 1;
  const ratio = incomeN / Math.max(loanN, 1);

  // Deterministic base component from the applicant's name, so the same
  // name nudges the score the same way every time.
  const nameHash = createHash("sha256").update(String(name || "")).digest();
  const nameComponent = (nameHash[0] / 255) * 0.15;

  const purposeWeight = { home: 0.05, education: 0.08, business: -0.02, personal: -0.05 }[
    String(purpose || "").toLowerCase()
  ] ?? 0;

  let raw = 0.35 + Math.min(ratio / 6, 0.45) + nameComponent + purposeWeight;
  raw += (randomInt(-30, 31) / 1000); // +/-0.03 jitter
  const score = Math.max(0, Math.min(1, raw));

  return {
    score: Math.round(score * 1000) / 1000,
    decision: score >= 0.55 ? "approved" : "denied",
    modelId: "credit-risk-scorer",
    modelVersion: "1.4.2",
  };
}

/**
 * Flip one character deep inside a string value at an arbitrary JSON path,
 * so the UI can let you corrupt exactly the field you click on rather than
 * always the same hardcoded one. `path` is an array of keys/indices, e.g.
 * ["record", "event", "metadata_hash"].
 */
function tamperAtPath(evidence, path) {
  const clone = JSON.parse(JSON.stringify(evidence));
  let node = clone;
  for (let i = 0; i < path.length - 1; i++) {
    node = node?.[path[i]];
    if (node == null) throw new Error("that field doesn't exist on this receipt");
  }
  const key = path[path.length - 1];
  const value = node?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("only text/hash/signature fields can be tampered with here");
  }
  const chars = value.split("");
  // Flip the last alphanumeric character we find, working from the end —
  // works for hex, base64, ULIDs, and plain strings alike.
  for (let i = chars.length - 1; i >= 0; i--) {
    if (/[0-9a-zA-Z]/.test(chars[i])) {
      const c = chars[i];
      chars[i] = c === "a" ? "b" : c === "A" ? "B" : c === "0" ? "1" : "a";
      break;
    }
  }
  node[key] = chars.join("");
  return clone;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// A few uncontroversial, dependency-free security headers — nothing here
// changes behavior, so it's safe on any host including Vercel.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

/**
 * Live scoring preview — same model as /api/apply, but no evidence is
 * sealed. Lets the UI update a score meter on every slider move without
 * minting a receipt for every keystroke.
 */
app.post("/api/preview", (req, res) => {
  const { name, income, loanAmount, purpose } = req.body ?? {};
  const result = scoreApplicant({ name, income, loanAmount, purpose });
  res.json(result);
});

/**
 * Submit a loan application. Runs the mock model, then seals the decision
 * as CooL evidence. Sensitive applicant data is committed as a salted hash
 * inside the SDK and discarded — only the receipt id and digest travel back
 * out in the normal response; we also return the full evidence object here
 * so this demo's UI can let you inspect and verify it client-side.
 */
app.post("/api/apply", async (req, res) => {
  if (!requireCool(res)) return;
  try {
    const { name, income, loanAmount, purpose } = req.body ?? {};
    if (!name || !income || !loanAmount) {
      return res.status(400).json({ error: "name, income and loanAmount are required" });
    }

    const result = scoreApplicant({ name, income, loanAmount, purpose });

    const { evidence, recordId, executionId, digest } = await cool.record({
      type: "model.execution",
      metadata: {
        model: result.modelId,
        version: result.modelVersion,
        route: "/api/apply",
      },
      payloads: {
        input: JSON.stringify({ name, income, loanAmount, purpose }),
        output: JSON.stringify({ score: result.score, decision: result.decision }),
      },
      software: { name: "cool-fin-demo", version: "1.0.0", digest: null },
    });

    const entry = {
      evidence,
      decision: result.decision,
      score: result.score,
      name,
      model: { id: result.modelId, version: result.modelVersion },
      recordId,
      executionId,
      digest,
      mode: cool.environment.mode,
      sealedAt: new Date().toISOString(),
    };
    receipts.set(recordId, entry);

    res.json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/**
 * Verify a piece of evidence offline. Accepts either a recordId issued by
 * this server, or a raw evidence object pasted in directly (so the "no
 * login, no API key" claim in the deck is actually demonstrable — anyone
 * can paste a receipt here and it verifies against nothing but its own bytes).
 */
app.post("/api/verify", async (req, res) => {
  if (!requireCool(res)) return;
  try {
    const { recordId, evidence: rawEvidence } = req.body ?? {};
    const evidence = rawEvidence ?? (recordId ? receipts.get(recordId)?.evidence : null);
    if (!evidence) {
      return res.status(404).json({ error: "no evidence found for that recordId, and none was provided" });
    }

    const verdict = await cool.verify(evidence);
    res.json({
      ok: verdict.ok,
      checks: verdict.checks,
      reasons: verdict.reasons,
      report: formatVerdict(verdict),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/**
 * Return a deliberately tampered copy of a receipt. `path` (array of keys)
 * says exactly which field to corrupt — this is what makes the inspector
 * field-by-field: click a leaf, tamper only that leaf, re-verify, and see
 * exactly which domains that field feeds into.
 */
app.post("/api/tamper", async (req, res) => {
  try {
    const { recordId, evidence: rawEvidence, path: fieldPath } = req.body ?? {};
    const evidence = rawEvidence ?? (recordId ? receipts.get(recordId)?.evidence : null);
    if (!evidence) {
      return res.status(404).json({ error: "no evidence found for that recordId, and none was provided" });
    }
    if (!Array.isArray(fieldPath) || fieldPath.length === 0) {
      return res.status(400).json({ error: "path (array of keys) is required" });
    }
    res.json({ evidence: tamperAtPath(evidence, fieldPath) });
  } catch (err) {
    res.status(400).json({ error: err.message ?? "could not tamper with that field" });
  }
});

/** Fetch one full receipt (with evidence) by recordId, for the history rail. */
app.get("/api/receipt/:id", (req, res) => {
  const entry = receipts.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "unknown recordId" });
  res.json(entry);
});

/** The session's sealed receipts, most recent first — for the history rail. */
app.get("/api/history", (_req, res) => {
  const list = [...receipts.values()]
    .reverse()
    .map(({ evidence, ...meta }) => meta);
  res.json({ receipts: list });
});

/**
 * Clear this session's in-memory receipt history. This only forgets local
 * bookkeeping (the Map above) so the UI's history rail can be reset — it
 * does not, and cannot, touch anything already appended to the real
 * transparency log via cool.record().
 */
app.post("/api/history/clear", (_req, res) => {
  receipts.clear();
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  if (!coolReady) {
    return res.json({ ok: false, mode: "unavailable", error: coolInitError?.message });
  }
  res.json({ ok: cool.attestation.ok, mode: cool.environment.mode });
});

// Friendly JSON 404 for unknown API routes, instead of Express's default HTML page.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "unknown API route" });
});

// Last-resort error handler so an unexpected throw returns JSON, not a stack trace.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ---------------------------------------------------------------------------
// Deployment note: on Vercel this whole file runs as a serverless function
// (see vercel.json), so we never call app.listen() there — Vercel's Node
// runtime owns the socket and just calls the exported handler per request.
// Locally (`npm start`) it behaves exactly as a normal Express server.
//
// One real consequence of serverless deploys: `receipts` above is an
// in-memory Map scoped to a single function instance. On Vercel that
// instance can be recycled between requests, so the history rail, "load by
// recordId", and the compare view are only reliable within one warm
// instance/session — they are not guaranteed across cold starts. The
// "seal → verify/tamper" and "paste-and-verify" flows are unaffected
// because the browser already holds the full evidence object and sends it
// with every request; the 🔗 Share link button in the UI also encodes the
// whole receipt in the URL for exactly this reason. For a real deployment,
// back `receipts` with a real datastore (Vercel KV, Postgres, etc.).
// ---------------------------------------------------------------------------

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`CooL financial demo listening on http://localhost:${PORT}`);
    console.log(`evidence plane mode: ${cool.environment.mode}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await cool.flush();
      await cool.close();
      server.close(() => process.exit(0));
    });
  }
}

export default app;
