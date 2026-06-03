# Resume Fit Audit

A small Next.js (App Router) app that audits how well a resume fits a job
description. It has two modes:

- **Fit report** — scores the match (0–100) and surfaces matched/missing
  keywords, strengths, gaps, and prioritized recommendations.
- **Tailored docs** — rewrites the resume to target the role and drafts a cover
  letter, using only facts already present in the resume.

The Anthropic API key lives only on the server. The browser talks to the
`/api/grade` route, and that route calls the Anthropic Messages API — the key is
read from an environment variable and never shipped to the client.

## How it works

```
browser (app/page.js)  ──POST /api/grade──▶  server route (app/api/grade/route.js)
                                                   │
                                                   └── Anthropic Messages API (key from env)
```

- `app/api/grade/route.js` — server-only route. Reads `ANTHROPIC_API_KEY`,
  validates the request, and calls the model with structured JSON output.
- `app/page.js` — the UI. A `"use client"` component that POSTs to `/api/grade`
  and renders the result. It never sees the API key.

The request body is `{ mode, resume, jobDescription }` where `mode` is
`"report"` or `"docs"`. The response is `{ mode, result }`.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file from the example and add your key:

   ```bash
   cp .env.example .env.local
   ```

   Then edit `.env.local` and set `ANTHROPIC_API_KEY`. Get a key from
   <https://console.anthropic.com/>. `.env.local` is gitignored — it is never
   committed and is only read on the server.

3. Start the dev server:

   ```bash
   npm run dev
   ```

4. Open <http://localhost:3000>.

## Deploy to Vercel

1. Push this project to a Git repository (GitHub, GitLab, or Bitbucket).

2. In the [Vercel dashboard](https://vercel.com/new), import the repository.
   Vercel auto-detects Next.js — no build configuration is needed.

3. Before (or right after) the first deploy, add the environment variable under
   **Project → Settings → Environment Variables**:

   | Name                | Value              | Environments                     |
   | ------------------- | ------------------ | -------------------------------- |
   | `ANTHROPIC_API_KEY` | your Anthropic key | Production, Preview, Development  |

   (Or via CLI: `vercel env add ANTHROPIC_API_KEY`.)

4. Deploy. If you added the variable after the first build, trigger a redeploy so
   the new environment variable is picked up.

Because the key is only referenced in the server route via
`process.env.ANTHROPIC_API_KEY`, it stays on Vercel's servers and is never
exposed in the client bundle. Do **not** prefix it with `NEXT_PUBLIC_` — that
would inline it into the browser bundle.

## Notes

- The model defaults to `claude-opus-4-8`. To use a different model, set the
  `ANTHROPIC_MODEL` environment variable (e.g. `ANTHROPIC_MODEL=claude-sonnet-4-6`
  in `.env.local` for local dev, or in **Project → Settings → Environment
  Variables** on Vercel). No code change needed.
- `@anthropic-ai/sdk` is set to `latest` here for convenience; pin it to a
  specific version for reproducible builds.
