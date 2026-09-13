# CryptoVeri — Live Evidence Sandbox for AI Financial Decisions (built on CooL)

A hands-on demo that seals every AI-driven credit decision as cryptographically
verifiable evidence, built on the real, published **[`cool-nwc`](https://www.npmjs.com/package/cool-nwc)**
SDK ("CooL", from `Northwind-Cipher/cool-sdk`).

---

## What problem we are solving

The major problem we want to solve is:

> "How can financial institutions cryptographically verify that the correct
> AI model was executed for a financial decision, while maintaining data
> privacy and preventing tampering?"

**Lack of Verifiable AI Execution**, **Tamper-Prone Audit Trails**, and a lack
of **transparency** have become widespread problems across many sectors of
the industry:

1. **Lack of verifiable AI execution.** Auditors need proof of *which exact
   model and version* made a decision, but today they mostly get a claim, not
   evidence.
2. **Privacy vs. transparency.** Proving what happened usually means exposing
   sensitive customer or transaction data — which financial systems can't do
   just to satisfy an audit.
3. **Tamper-prone audit trails.** Traditional logs can be edited or deleted by
   the same organization that's supposed to be audited by them, so they don't
   hold up as independent evidence.

Regulators increasingly expect strong AI governance and auditability, and
institutions remain accountable for AI risk even when the model comes from a
third party. Traditional logging approaches weren't built for that.

## What we built

We built **CryptoVeri** — a hands-on tool that mainly focuses on solving
these problems by offering **cryptographic execution receipts** and
**tamper-proof evidence** for AI-driven financial decisions. It's a
single-screen web app that plays out a full loan-decision lifecycle in front
of you:

- **Live scoring** — drag income / loan amount / purpose sliders and watch a
  score gauge and sparkline update in real time, before anything is sealed.
- **Seal a decision** — submitting an application calls the real SDK and
  returns a genuine `cool.receipt.v2` object, rendered as an interactive,
  searchable tree.
- **Click-to-tamper** — click any field in the receipt (a hash, a signature, a
  public key) to flip one character and instantly re-verify, watching exactly
  which of the seven independent check domains fail. Tampering `metadata_hash`
  breaks `binding` and `signature`; tampering a `key_directory` key only
  breaks `signature`/`enclave`; tampering `sth.root_hash` only breaks
  `inclusion`.
- **Paste & verify** — anyone can paste a `cool.receipt.v2` JSON blob and
  verify it offline, with no login, API key, or access to our servers,
  demonstrating that trust lives in the bytes, not in us.
- **Session history & compare** — every receipt sealed this session is listed
  and can be reloaded or diffed side-by-side against another.
- **Share link** — encodes an entire receipt into the URL fragment so a
  verification link works even across serverless cold starts.

Nothing at the cryptography layer is mocked. Without real Phala dstack/TEE
hardware configured, the SDK runs its own built-in simulator — real hybrid
signatures over a real transparency log — and every simulated check is
honestly labelled `simulated`, never faked as `pass`.

## How the CooL SDK is used

The app is a thin Express/vanilla-JS shell around two SDK calls:

```js
import { CooL, formatVerdict } from "cool-nwc";

const cool = new CooL({ applicationId: "cool-fin-demo" });
await cool.ready();

// SEAL: turn a model execution into signed, loggable evidence
const { evidence, recordId, executionId, digest } = await cool.record({
  type: "model.execution",
  metadata: { model, version, route: "/api/apply" },
  payloads: {
    input: JSON.stringify(applicantInput),
    output: JSON.stringify(modelOutput),
  },
  software: { name: "cool-fin-demo", version: "1.0.0", digest: null },
});

// VERIFY: independently check the evidence against seven domains
const verdict = await cool.verify(evidence);
// verdict.ok, verdict.checks, verdict.reasons, formatVerdict(verdict)
```

- `cool.record()` hashes the applicant's data and the model's output, discards
  the plaintext, and signs the resulting record twice — **ML-DSA-65**
  (post-quantum) and **Ed25519** (classical) — so the receipt stays provably
  untampered even if one signature scheme is later broken.
- The signed record is appended to an **RFC 6962** Merkle transparency log
  (the same structure behind Certificate Transparency), giving every entry an
  inclusion proof against a signed tree head.
- `cool.verify()` is fully offline: it checks structural binding, both
  signatures, log inclusion, key-directory freshness, and enclave/attestation
  status as **seven independent domains**, and returns a structured verdict —
  never a bare boolean.
- `/api/tamper` (a demo-only helper, not part of the SDK) corrupts one
  character in one field at an arbitrary JSON path, so the UI can show exactly
  which check domains depend on which fields.

## Why CooL is important

1. **Verifiable AI Decisions** — CooL creates cryptographic evidence of the
   model, inputs, outputs, and execution, making AI decisions independently
   verifiable.
2. **Tamper Detection, Transparency & Trust** — CooL detects changes to the
   evidence while providing a clear record of what data was used, which
   model ran, and what decision was produced, making the AI process more
   transparent and trustworthy.
3. **Auditability & Accountability** — Verifiable receipts provide a reliable
   evidence trail for audits, disputes, compliance, and understanding how an
   AI decision was produced.

In short: CooL is the mechanism that makes the seal → log → verify pipeline
*independently checkable*, which is the whole point of the demo.

## How to run the project

Requires **Node.js ≥ 20**.

```sh
npm install
npm start
```

Then open **http://localhost:3000**.

Nothing is persisted between restarts — receipts live in memory for the
session, which is enough for a full seal → inspect → tamper → verify loop.

### Deploying to Vercel

The app is a single Express server (`server.mjs`), exported for Vercel's
Node.js runtime via `vercel.json` — no build step required.

```sh
npm i -g vercel     # once
vercel               # deploy a preview
vercel --prod        # promote to production
```

Or push the folder to a Git repo and "Import Project" in the Vercel
dashboard, leaving the build command empty and output directory unset.

No environment variables are required to run the SDK's built-in simulator.
To point it at real Phala dstack hardware instead, add whatever connection
variables `cool-nwc` expects under Project Settings → Environment Variables.

## Architecture / workflow

```
┌─────────────┐        POST /api/preview        ┌──────────────────┐
│   Browser    │ ───────────────────────────────▶│  scoreApplicant()│
│ (index.html, │◀─────────────────────────────── │  (no evidence)   │
│  app.js,     │        { score, decision }       └──────────────────┘
│  style.css)  │
│              │        POST /api/apply           ┌──────────────────┐
│              │ ───────────────────────────────▶ │ scoreApplicant() │
│              │                                   │      then        │
│              │                                   │  cool.record()   │──▶ SEAL (sign)
│              │◀─────────────────────────────── │  { evidence, ...} │──▶ LOG (RFC 6962)
│              │        receipt.v2 tree            └──────────────────┘
│              │
│              │        POST /api/verify          ┌──────────────────┐
│              │ ───────────────────────────────▶ │  cool.verify()   │──▶ VERIFY (7 domains)
│              │◀─────────────────────────────── │  structured       │
│              │        verdict                    │  verdict          │
│              │                                   └──────────────────┘
│              │
│              │        POST /api/tamper          ┌──────────────────┐
│              │ ───────────────────────────────▶ │ tamperAtPath()   │
│              │◀─────────────────────────────── │ (demo helper)     │
└─────────────┘        corrupted receipt          └──────────────────┘
```

**SEAL → LOG → VERIFY**, end to end:

1. **Seal** — `cool.record()` hashes the applicant's input and the model's
   output, discards the plaintext, and double-signs the record (ML-DSA-65 +
   Ed25519).
2. **Log** — the signed record is appended to an RFC 6962 transparency log;
   the entry gets an inclusion proof against a signed tree head.
3. **Verify** — `cool.verify()` runs offline against the evidence bytes alone,
   checking seven independent domains and returning a structured
   pass/fail-per-domain report, not a single boolean.

Project layout:

```
server.mjs        Express API: /api/preview, /api/apply, /api/verify,
                  /api/tamper, /api/history, /api/receipt/:id, /api/health
public/
  index.html      Applicant form, receipt inspector, paste-and-verify panel
  style.css       Theme ("Aurora Noir": graphite + teal/indigo gradient,
                  light-mode toggle)
  app.js          Live preview, animated pipeline, click-to-tamper tree,
                  session history, compare view, share links
```

## Important technical decisions

- **Real SDK, not a mock.** `cool.record()` / `cool.verify()` are genuine
  calls against the published `cool-nwc` package — the only thing "demo"
  about this app is the credit-scoring model and the surrounding UI.
- **Deterministic-but-not-static scoring model.** The mock scorer combines an
  income/loan ratio, a deterministic hash of the applicant's name, a
  purpose-based weight, and a small amount of jitter — so results are
  explainable but not byte-identical on repeat submissions, closer to a real
  model's behavior.
- **Field-level tamper endpoint.** `/api/tamper` takes `{ evidence, path }`
  and flips one character at that exact JSON path, rather than one
  hardcoded "tamper demo" button — this is what lets the inspector show,
  field by field, which of the seven check domains each part of the receipt
  feeds into.
- **Honest failure modes.** SDK initialization is wrapped so a failed
  `cool.ready()` (e.g. on a cold serverless start) returns a clear `503`
  from evidence-producing routes instead of crashing the process; unknown
  `/api/*` routes return JSON, never an HTML 404 page.
- **Share-link over server state.** Because a serverless `Map` isn't durable
  across instances, the share-link feature encodes the *entire* receipt into
  the URL fragment, so verification never depends on which instance served
  the original request.
- **No new dependencies for security headers.** `X-Content-Type-Options`,
  `Referrer-Policy`, and `X-Frame-Options` are set by hand rather than
  pulling in a middleware package, to keep the dependency surface to just
  `express` and `cool-nwc`.

## Limitations & Future Scope

1. **Simulator-Based Prototype** — The current system uses simulated
   CooL/TEE capabilities; future versions can integrate real hardware-backed
   trusted execution.
2. **Need for Persistent Storage** — The prototype avoids dependence on
   server memory; production deployment would require secure, scalable
   long-term receipt storage.
3. **Beyond Integrity to Responsible AI** — Future versions can combine CooL
   evidence with explainability, fairness/bias checks, human review, and
   regulatory compliance for more trustworthy lending.
