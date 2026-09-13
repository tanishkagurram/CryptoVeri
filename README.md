# CooL — live evidence sandbox

[![CI](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/ci.yml)

> Replace `YOUR_USERNAME/YOUR_REPO` above with your actual GitHub path once
> you push this — that turns the badge from a broken image into a live,
> clickable "tests pass on the real SDK" signal on your repo's front page.

A single-screen, hands-on tool built on the real, published **[`cool-nwc`](https://www.npmjs.com/package/cool-nwc)**
SDK (the "CooL" project from `Northwind-Cipher/cool-sdk`). No pitch-deck copy, no marketing
sections — just the working model, front and center.

## Why this, and not just another demo

Every credit-decision demo in this space *says* it uses the real SDK. Few let you check that
claim yourself. This one does, in three ways:

1. **An automated test suite runs the actual `cool.record()` / `cool.verify()` calls** — not
   mocks — and asserts on the SDK's real, structured verdict shape (`{status, detail}` per
   check domain), including that the two hardware-dependent checks come back honestly
   `"simulated"`, never `"pass"`. See [`tests/api.test.mjs`](tests/api.test.mjs) and run it
   yourself with `npm test`. CI runs it on every push.
2. **Paste-and-verify needs nothing from this server** — copy any sealed receipt's JSON,
   paste it into the right-hand panel, and it verifies against nothing but its own bytes.
   You don't have to trust the demo; you can watch the verifier work.
3. **Every claim in this README is falsifiable in under a minute**: clone it, `npm install`,
   `npm test`, `npm start`, seal a decision, tamper a field, watch the right checks fail.

Nothing here is mocked at the cryptography layer: `cool.record()` and `cool.verify()` are the
real SDK calls, producing real hybrid ML-DSA-65 + Ed25519 signatures over a real RFC 6962
transparency log, running in the SDK's built-in simulator (no TEE hardware or Phala dstack
required — every receipt is honestly labelled `simulated`, never `pass`, on the two
hardware-dependent checks).

## What you can do

- **Drag the sliders** on the left — income, loan amount, purpose — and watch the score meter
  update live, before anything is sealed. This calls a lightweight `/api/preview` endpoint that
  runs the scoring model without minting evidence.
- **Seal a decision** to actually call `cool.record()`. You get back a real `cool.receipt.v2`
  object, rendered as an interactive tree in the middle panel.
- **Click any value in the tree** — a hash, a signature, a ULID, a public key — to flip one
  character in *just that field*, then it auto re-verifies. Watch which of the seven check
  domains break: tamper a core field (like `metadata_hash`) and both `binding` and `signature`
  fail; tamper a `key_directory` public key and only `signature`/`enclave` fail; tamper the
  `sth.root_hash` and only `inclusion` fails. Each domain is checked independently — that's the
  whole point of the design.
- **Reset tampering** restores the clean, originally-sealed receipt so you can try a different
  field.
- **Session history** on the left keeps every receipt you've sealed this run — click one to
  reload it into the inspector.
- **Paste & verify** on the right runs the same offline verifier against any `cool.receipt.v2`
  JSON you paste in — proving the "no login, no API key, no access to our systems" claim is
  real: verification trusts nothing but the bytes you give it.

## What's new in this pass

Everything below is presentation and UX layered on top of the same real
`cool.record()` / `cool.verify()` calls — nothing about the cryptography,
the SDK, or what counts as a valid receipt has changed.

- **"Aurora Noir" theme** — graphite background with a teal → indigo aurora
  gradient, a faint grid, and a light-mode toggle (☀️/🌙) in the top bar
  that's just a CSS variable swap.
- **Share link** — the 🔗 button next to the receipt encodes the *entire*
  receipt into the URL fragment (`#r=…`) and copies it. Opening that link
  loads and auto-verifies the receipt client-side with no server lookup at
  all, so it survives serverless cold starts and works across instances.
- **First-visit tooltip** pointing at "Run AI decision", dismissed once and
  remembered locally.
- **Hardened for cold starts** — SDK initialization is wrapped so a failed
  `cool.ready()` reports a clear `503` from `/api/apply` and `/api/verify`
  instead of crashing the process; unknown `/api/*` routes return JSON, not
  an HTML 404 page; a couple of standard security headers are set with no
  new dependencies.
- **Live score gauge** — a small ring meter next to the applicant form that
  fills and changes colour (red → amber → green) as you drag the income /
  loan sliders, backed by the same `/api/preview` endpoint as before.
- **Session sparkline** — a tiny canvas chart trailing your last ~40 live
  score estimates, so you can see how the sliders move the model.
- **Animated Seal → Log → Verify pipeline** — the three explainer steps now
  light up in sequence while `/api/apply` is in flight. This is an honest
  UI staging of the same single real request; no step is faked as "done"
  before the server actually responds.
- **Field search** in the receipt tree — filter to `signature`, `sth`,
  `key_directory`, etc. instead of scrolling.
- **Copy / download the receipt** — copy the full `cool.receipt.v2` JSON or
  the record's binding digest, or download the JSON to verify it elsewhere.
- **Compare two receipts** — hold `Alt` and click two entries in the session
  history to open a side-by-side diff of their evidence fields.
- **Confetti + optional sound** on a clean `verify`, a shake on a failed
  one; sound is off by default (🔈 in the top bar) and uses only a couple of
  WebAudio beeps — no audio files.
- **Keyboard shortcuts**: `V` verify, `T` tamper & re-verify, `R` reset
  tampering.
- **Health pill** in the top bar calling `/api/health`, so you can see the
  SDK's attestation mode at a glance.
- **Clear session** button for the history rail (`POST /api/history/clear`
  just empties the server's in-memory `Map` — it can't and doesn't touch
  anything already appended to the real transparency log).

## Run it locally

Requires **Node.js ≥ 20**.

```sh
npm install
npm start
```

Then open **http://localhost:3000**.

Nothing is persisted between server restarts — receipts live in memory for the session, which
is enough for the full seal → inspect → tamper → verify loop.

## Run the tests

```sh
npm test
```

Uses Node's built-in test runner (`node --test`) — no extra dependency to install or audit.
The suite spins up the actual Express app on an ephemeral port and drives it through
`fetch()`, calling the real `cool.record()` / `cool.verify()` (simulator mode), including:

- sealing a decision and asserting the receipt is a genuine `cool.receipt.v2`
- a clean receipt verifying `pass` on every domain the SDK actually attempts, and honestly
  `simulated` (never `pass`) on the two hardware-dependent ones
- tampering `metadata_hash` breaking `binding` + `signature` but not `inclusion`
- tampering the transparency log's `sth.root_hash` breaking only `inclusion`, leaving the
  record's own `signature` valid — the concrete evidence behind the "seven independent
  domains" claim above, not just an assertion of it
- malformed input returning a clean `400` instead of a crash
- unknown routes and history-clearing behaving as documented

CI (`.github/workflows/ci.yml`) runs this same suite on every push.

## Deploy to Vercel

The app is a single Express server (`server.mjs`) exported for Vercel's Node.js runtime via
`vercel.json`; no build step is needed.

**Option A — CLI**

```sh
npm i -g vercel     # once, if you don't have it
vercel               # deploy a preview
vercel --prod         # promote to production
```

**Option B — Dashboard**

Push this folder to a Git repo and "Import Project" in the Vercel dashboard. Leave the build
command empty and the output directory unset — `vercel.json` handles routing everything
(`/`, `/api/*`, static files under `public/`) to `server.mjs`.

No environment variables are required to run the SDK's built-in simulator. If you later point
this at real Phala dstack hardware, add whatever connection variables `cool-nwc` expects under
Project Settings → Environment Variables.

**One thing that's genuinely different on serverless:** `receipts` in `server.mjs` is an
in-memory `Map`, scoped to a single function instance. Vercel can recycle that instance between
requests, so the session history rail, "load by recordId", and the compare view aren't
guaranteed to survive a cold start. The core loop — seal, inspect, tamper, verify, and
paste-and-verify — is unaffected, because the browser already holds the full evidence object
and sends it with every request. The 🔗 **Share link** button exists specifically to route
around this: it encodes the whole receipt into the URL itself, so a shared link verifies
correctly no matter which instance serves it. For a deployment that needs durable history,
swap the `Map` for Vercel KV, Postgres, or similar.

## Project layout

```
server.mjs        Express API: /api/preview, /api/apply, /api/verify, /api/tamper,
                  /api/history, /api/receipt/:id, /api/health
public/
  index.html      The workspace: applicant form, receipt inspector, paste-and-verify
  style.css       Theme
  app.js          Live preview, pipeline animation, click-to-tamper tree, history
```

## Notes on the tamper mechanic

`POST /api/tamper` takes `{ evidence, path }`, where `path` is an array of keys describing
exactly which field to corrupt (e.g. `["record","event","metadata_hash"]`). It flips one
character in that field's string value and returns the modified receipt — nothing else changes.
This is what makes the inspector genuinely field-by-field rather than a single canned "tamper
demo" button.

To see this running against real Phala dstack / Intel TDX hardware instead of the simulator,
see [`docs/dstack.md`](https://github.com/Northwind-Cipher/cool-sdk/blob/main/docs/dstack.md)
in the upstream SDK repo.
