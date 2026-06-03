# Build prompt — paste into a new session

> Copy everything below the line into a new Claude Code session in this repo.

---

You are working in the `resume_optimizer` repo: a Next.js 15 (App Router) app
called "Resume Fit Audit" that scores how well a resume fits a job description
and can rewrite the resume + draft a cover letter.

Current architecture:
- `app/page.js` → renders `ResumeFitAudit.jsx` (the `"use client"` UI).
- `ResumeFitAudit.jsx` → POSTs `{ mode, resume, jobDescription, context }` to
  `/api/grade` via the `gradeViaApi()` helper. **This file is canonical for the
  grading judgment/honesty — do NOT alter the grading rules, tone, or
  calibration here.**
- `app/api/grade/route.js` → server route. Reads `ANTHROPIC_API_KEY` from env,
  calls the Anthropic Messages API with structured JSON output. Contains the
  reusable assets: `PIPELINE_RULES` (the honesty rubric), `REPORT_SCHEMA`,
  `DOCS_SCHEMA`, `buildReportPrompt`, `buildDocsPrompt`, `parseModelJson`.
  Current model = `claude-sonnet-4-6` (keep it configurable via the `MODEL`
  const; do not change the value unless I ask).

I want to build **three additional versions** alongside the existing web app,
all reusing the SAME grading rubric and schemas so the judgment is identical
across them. The deciding principle throughout: **where the model inference runs
determines who pays.** A "smart" component calls the Anthropic API (my key, my
credits). A "dumb" MCP server does NO model call — the connecting host's model
does the grading (the host's subscription pays).

## Ground rules (apply to every version)
- Reuse `PIPELINE_RULES`, `REPORT_SCHEMA`, `DOCS_SCHEMA`, and the prompt builders
  from `route.js` verbatim. If sharing them across files, extract them into a
  small shared module (e.g. `app/lib/grading.js`) and import from both the route
  and the MCP server — do not fork/reword them.
- Never log API keys or full request headers/bodies anywhere.
- Keep the honesty calibration intact (most fits 4–7, 2+ level jump caps at 4,
  no invented experience, verb-evidence rules, no em/en dashes).

---

## Version A — Web app with "bring your own API key" (Tier 2)
Goal: same shared link works for anyone; if a user pastes their own Anthropic
**API key**, the grade runs on THEIR key (I pay $0); if blank, fall back to my
server key. This is still a server-side API call (Design A infra), just with a
swappable key.

Do:
1. `route.js`: read an optional `x-anthropic-api-key` **header**; prefer it over
   `process.env.ANTHROPIC_API_KEY`. If neither exists → 401 with a clear message.
   If a user key is present but doesn't start with `sk-ant-` → 400 with a clear
   message. Pass the chosen key to `new Anthropic({ apiKey })`. In the success
   response add `keyOwner: userKey ? "user" : "server"`.
2. `ResumeFitAudit.jsx`: add `gradeViaApi`'s `apiKey` param and forward it as the
   `x-anthropic-api-key` header only when non-empty. Thread `apiKey` through both
   call sites (report + docs).
3. `ResumeFitAudit.jsx`: add an optional `type="password"`, `autoComplete="off"`
   key field with state, plus helper text: stays in the browser, sent over HTTPS
   for this request only, never stored or logged. Optionally show a small badge
   from `keyOwner` ("running on your key" vs "shared key").
4. Note in the README: a public link where blank = my key lets strangers spend my
   credits — recommend gating the no-key path (login/allowlist/rate-limit) or
   requiring a key for non-owners.

It's an API key, NOT a Pro/Max subscription — a subscription can't be tapped by a
website.

---

## Version B — Local MCP server for my own use (Design B, personal)
Goal: I run this in my own Claude Code / Claude Desktop. A **dumb** MCP server
(no Anthropic call) feeds my host model the data + rubric, and MY current host
model (e.g. Opus 4.8 via my subscription) does the grading. $0 API credits.

Do:
1. New standalone MCP server (separate process, `@modelcontextprotocol/sdk`,
   stdio transport). Put it under e.g. `mcp/server.js` with its own package
   entry/script. It must NOT import or call `@anthropic-ai/sdk`.
2. Tools:
   - `prepare_resume_audit({ resume, jobDescription, context? })` → returns the
     resume text, **code-computed** JD keyword frequencies (do the "appears 3+
     times" counting in JS, not via a model), plus `PIPELINE_RULES` and the
     target report JSON shape, with an instruction telling the host to grade per
     those rules and return that JSON.
   - `prepare_resume_docs({ resume, jobDescription, context? })` → analogous, for
     the tailored-resume + cover-letter task using `buildDocsPrompt`'s framing.
   - `validate_audit({ json })` → deterministically validate the host's output
     against `REPORT_SCHEMA` (shape + fitGrade range), return `{ ok, errors }` so
     the host must redo malformed output. Re-adds the schema guarantee lost when
     leaving the API's `json_schema`.
3. Provide the exact config snippet to register it in Claude Code and Claude
   Desktop (command + args path to the server).
4. README section: model used = whatever my host session runs; I control it
   because it's my host; subscription pays; no web UI (conversational).

---

## Version C — Remote MCP server to share with others (Design B, shared)
Goal: deploy the SAME dumb server once (Vercel) so a friend can add a URL as a
custom connector in their own host. Their model grades, their subscription pays;
I pay only trivial hosting ($0 API credits).

Do:
1. Expose the Version B tools over **HTTP transport** (remote MCP) by **reusing
   the existing Next.js app on Vercel** — add the MCP endpoint as a route in the
   same app (e.g. `app/api/mcp/route.js` using the MCP streamable-HTTP
   transport), importing the same shared grading module. Do NOT create a
   separate service. Still NO Anthropic call. Because Vercel functions are
   stateless, use the **stateless** streamable-HTTP mode (no reliance on
   in-memory sessions between requests) — each tool call must stand alone.
2. Document how a friend adds the deployed URL as a remote MCP server / custom
   connector in Claude Desktop, and note the gating reality: they need a
   plan/app that supports custom connectors and their own subscription.
3. Note auth is optional/low-stakes here because the server holds no key and runs
   no inference; mention OAuth as a later option if they want it private.

---

## Deliverables & acceptance
- A shared grading module imported by the route + both MCP entry points; rubric
  and schemas reused verbatim (judgment identical across all versions).
- Version A: blank key → server key path works; pasted valid key → used; bad key
  → friendly error; key never logged.
- Version B: `npm`-runnable stdio server; the three tools return correct
  deterministic data; `validate_audit` rejects out-of-range grades; working
  Claude Code + Desktop config snippets.
- Version C: HTTP MCP route reachable locally; deploy notes for Vercel; connector
  setup steps.
- README updated with a "who pays / which model" table covering: my MCP use, a
  friend's remote-MCP use, and the web app (BYO-key and shared-key).

Start by proposing the file layout and the shared-module extraction, then
implement Version A, then B, then C. Ask me before changing the `MODEL` value or
the grading rules.
