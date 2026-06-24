import Anthropic from "@anthropic-ai/sdk";

// Run on the Node.js runtime (the Anthropic SDK is not edge-compatible).
export const runtime = "nodejs";
// Give long model calls room: a docs generation with adaptive thinking can
// run well past 60s. 300s is the max on Vercel Hobby (free) with fluid compute
// (enabled by default); Pro/Enterprise allow more. The NDJSON heartbeat below
// keeps the connection warm so it isn't dropped before this cap is reached.
export const maxDuration = 300;

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

// The grading pipeline, ported verbatim from the ResumeFitAudit prototype.
// Sent as the system prompt — it is the stable instruction shared by every
// request, so the per-request resume/JD are the only things that vary. (Too
// short to prompt-cache on Opus 4.8, whose minimum cacheable prefix is 4096
// tokens; the per-request resume/JD vary anyway, so there's little to cache.)
const PIPELINE_RULES = `You are a panel of three experts running as one automated pipeline: a RECRUITER (15+ years screening at top firms, never flatters), an EDITOR (repositions honestly, quantifies, active voice), and a CRITIC (skeptical hiring manager who forces revisions).

CALIBRATION AND HONESTY (non-negotiable):
- Be calibrated, not encouraging. Most honest fits land at 4 to 7 out of 10. Reserve 9 to 10 for a resume that already reads as written for that exact role. A title or seniority jump of 2+ levels caps the grade at 4; state that as the reason.
- Never invent experience, achievements, numbers, titles, or dates. Use only what the resume and context support.
- Never inflate a verb beyond its evidence: "led" requires people reporting to the person, "owned" requires decision authority, "architected" requires design ownership, "managed" requires direct reports. Downgrade unsupported verbs (e.g. "trained a team" never becomes "led a team").
- If unsure whether a claim is defensible, downgrade it and flag it rather than inflating.
- For anything a newcomer could not finish in 90 days, use honest verbs ("begin", "draft", "map", "the start of"), never "transform" or "deliver".
- Never use em dashes or en dashes anywhere. Use commas, parentheses, semicolons, or "to" for ranges.`;

// Structured-output schemas match the exact JSON shapes the prompts describe, so
// the response should always conform. parseModelJson() adds a small fallback for
// the rare non-conforming response.
const REPORT_SCHEMA = {
  type: "object",
  properties: {
    role: { type: "string" },
    jdThesis: { type: "string" },
    companyRead: { type: "string" },
    fitGrade: { type: "integer" },
    gradeReasoning: { type: "string" },
    leadHook: { type: "string" },
    fitPoints: { type: "array", items: { type: "string" } },
    gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gap: { type: "string" },
          strategy: { type: "string" },
        },
        required: ["gap", "strategy"],
        additionalProperties: false,
      },
    },
    // Offensive keyword work: JD terms the candidate LEGITIMATELY supports but
    // phrased differently or buried. The single highest-leverage ATS fix.
    keywordsToSurface: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          currentPhrasing: { type: "string" },
          suggestedRephrase: { type: "string" },
        },
        required: ["term", "currentPhrasing", "suggestedRephrase"],
        additionalProperties: false,
      },
    },
    keywordsMissing: { type: "array", items: { type: "string" } },
    // Format/structure problems that get a resume filtered before a human
    // reads it (e.g. JD demands proof of builds but there is no Projects
    // section). Separate from content gaps.
    structuralGaps: { type: "array", items: { type: "string" } },
    tradeoffs: { type: "array", items: { type: "string" } },
  },
  required: [
    "role",
    "jdThesis",
    "companyRead",
    "fitGrade",
    "gradeReasoning",
    "leadHook",
    "fitPoints",
    "gaps",
    "keywordsToSurface",
    "keywordsMissing",
    "structuralGaps",
    "tradeoffs",
  ],
  additionalProperties: false,
};

const DOCS_SCHEMA = {
  type: "object",
  properties: {
    tailoredResume: { type: "string" },
    coverLetter: { type: "string" },
  },
  required: ["tailoredResume", "coverLetter"],
  additionalProperties: false,
};

// Primary path is structured outputs (clean JSON). The fallback handles a model
// response that wrapped the JSON in prose or code fences.
function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    let t = text.trim().replace(/```json/gi, "").replace(/```/g, "").trim();
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
    return JSON.parse(t); // re-throws if still invalid; handled by the caller
  }
}

function buildReportPrompt(resume, jd, context) {
  return `Assess this candidate against the job below. Extract the JD's required years, seniority, hard skills, and the keywords that appear 3+ times. Identify what the role values MOST (its central thesis) and what kind of company and culture it is. Read the resume. Produce a compact, honest, ATS-aware report whose job is to get this candidate past the resume screen, where most applications die before a human reads them.

Two ideas drive the most important fields:
- SURFACING (offensive keywords): find JD requirements the candidate GENUINELY satisfies but that are phrased differently, buried, or dropped from the resume. Re-surfacing them in the JD's language is the single highest-leverage way past an ATS, and it is honest because the evidence already exists. This is different from keywords the candidate cannot truthfully claim.
- STRUCTURE AND FRAMING: a qualified candidate still gets filtered when the resume leads with the wrong thing for this company, or omits a section the JD clearly demands (e.g. a Projects section for a role that says "show us what you have built"). Name those problems concretely.

Return ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{
  "role": "Role title and organization, one line",
  "jdThesis": "the one trait or behavior this role values most, in one sentence",
  "companyRead": "company type and culture (e.g. fast-moving creator/media, enterprise, regulated finance) and what to emphasize vs de-emphasize for it, one sentence",
  "fitGrade": <integer 1-10>,
  "gradeReasoning": "one honest sentence explaining the grade",
  "leadHook": "the candidate's single strongest piece of real evidence for this role, phrased to mirror jdThesis, to lead the resume with",
  "fitPoints": ["3 to 5 genuine, evidence-tied strengths"],
  "gaps": [{"gap": "a real gap named concretely", "strategy": "one-line cover-letter strategy for it"}],
  "keywordsToSurface": [{"term": "JD keyword/skill the candidate truly supports", "currentPhrasing": "how it appears in the resume now, or 'present in master resume but dropped/buried', or 'implied by <evidence> but not named'", "suggestedRephrase": "the exact resume line or skill entry to use so it matches the JD's wording, without fabrication"}],
  "keywordsMissing": ["JD keywords genuinely absent and not defensible from the resume; cannot be added without fabrication"],
  "structuralGaps": ["format or structure problems hurting the candidate at the screen stage: a missing section the JD demands (e.g. Projects/portfolio when it asks for proof of builds), the strongest match being buried instead of leading, off-culture framing, ATS-unsafe layout. Be specific and actionable."],
  "tradeoffs": ["honesty trade-offs or verb downgrades you made or would make"]
}

Rules: keywordsToSurface must only contain claims the resume already supports (no fabrication). keywordsMissing is for the genuinely-unsupported ones. If the JD emphasizes built work, public presence, or "show us what you've built" and the resume has no Projects section, that MUST appear in structuralGaps.

=== MASTER RESUME ===
${resume}

=== JOB DESCRIPTION ===
${jd}
${context ? `\n=== EXTRA CONTEXT ===\n${context}` : ""}

Return ONLY the JSON object.`;
}

function buildDocsPrompt(resume, jd, context, report) {
  const reportBlock = report
    ? `\n=== FIT REPORT (your own prior analysis; act on it) ===\n${JSON.stringify(report, null, 2)}\n`
    : "";

  return `Produce a tailored resume and a cover letter for this candidate and job. This document has one job: get past the resume screen and land with a human. Build directly on the FIT REPORT below if present, do not re-derive it.

RESUME REQUIREMENTS:
- Lead with the match. If a "leadHook" is given, the summary's first sentence mirrors the role's central thesis ("jdThesis") using that hook. Do not bury the strongest evidence.
- Frame for the company. Use "companyRead" to set voice and emphasis: foreground the experience this company cares about and de-emphasize (do not delete) off-culture jargon. A compliance-heavy framing reads wrong at a fast-moving product or media company, and vice versa.
- Surface keywords honestly. Apply every "keywordsToSurface" rephrase so the resume matches the JD's wording where the candidate genuinely qualifies. NEVER drop a skill or term from the master resume that maps to a JD requirement; preserve it.
- Include a clearly labeled SKILLS section that mirrors the JD's hard-skill terminology, listing only skills the candidate genuinely has.
- If "structuralGaps" calls for a Projects/portfolio section (common when the JD says "show us what you've built" or values public presence), include a "SELECTED PROJECTS" section built from any projects or links in the master resume and EXTRA CONTEXT. If no project details are available, include the section with a single bracketed line: "[Add 2 to 3 projects here with one-line impact and a link. The job asks you to show what you've built; this section is where you do it.]" so the candidate knows to fill it.
- Rewrite bullets to lead with strong honest verbs and quantified impact; drop filler. Keep the candidate's real metrics.
- ATS-safe formatting: plain text, standard uppercase section headers (SUMMARY, SKILLS, EXPERIENCE, SELECTED PROJECTS, EDUCATION), one item per line, no tables, no columns, no special characters. Real line breaks (\\n).

COVER LETTER REQUIREMENTS:
- Open with the application and the value proposition, leading with the match to "jdThesis" (no "I am excited to").
- Calibrate honesty to "companyRead": for competitive, fast-moving cultures do NOT spend a paragraph foregrounding what you lack; address a real gap briefly and reframe it, or convert it into an honest first-90-day plan. For conservative/regulated cultures, more explicit gap-disclosure is fine. Lead with strength either way.
- Close with dignity.

GLOBAL: No em dashes or en dashes. Use commas, parentheses, semicolons, or "to" for ranges. Never fabricate experience, titles, numbers, or skills.

SELF-CHECK before returning: re-read both documents as a skeptical recruiter at THIS company doing a 6-second skim. Does the first third prove the candidate fits THIS role, in THIS company's language? Is every JD-relevant skill the candidate has actually present? Revise once, then return.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "tailoredResume": "full plain-text resume, use real line breaks (\\n) between lines and sections",
  "coverLetter": "full plain-text cover letter, use real line breaks (\\n)"
}
${reportBlock}
=== MASTER RESUME ===
${resume}

=== JOB DESCRIPTION ===
${jd}
${context ? `\n=== EXTRA CONTEXT ===\n${context}` : ""}

Return ONLY the JSON object.`;
}

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Server is not configured: ANTHROPIC_API_KEY is missing." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { mode, resume, jobDescription } = body ?? {};
  const context = typeof body?.context === "string" ? body.context : "";
  // Optional: the report from the prior "report" call, so the docs rewrite can
  // act on its analysis (lead hook, culture read, keywords to surface) instead
  // of re-deriving everything from scratch.
  const report =
    body?.report && typeof body.report === "object" ? body.report : null;

  if (mode !== "report" && mode !== "docs") {
    return Response.json(
      { error: 'Field "mode" must be either "report" or "docs".' },
      { status: 400 }
    );
  }
  if (typeof resume !== "string" || resume.trim() === "") {
    return Response.json({ error: 'Field "resume" is required.' }, { status: 400 });
  }
  if (typeof jobDescription !== "string" || jobDescription.trim() === "") {
    return Response.json({ error: 'Field "jobDescription" is required.' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const schema = mode === "report" ? REPORT_SCHEMA : DOCS_SCHEMA;
  const prompt =
    mode === "report"
      ? buildReportPrompt(resume, jobDescription, context)
      : buildDocsPrompt(resume, jobDescription, context, report);
  // The docs rewrite is the high-stakes deliverable; give it more room to
  // reason than the report diagnostic.
  const effort = mode === "docs" ? "high" : "medium";

  // Stream the model call. The model phase can run long (adaptive thinking
  // plus a full resume/cover-letter rewrite), so rather than holding one
  // silent buffered response that a proxy or browser may idle-timeout, we
  // deliver the result over an NDJSON stream and keep the connection warm
  // with a heartbeat. Each line is one JSON message:
  //   {"type":"progress"}                  zero or more keepalive pings
  //   {"type":"result","mode","result"}    success (terminal)
  //   {"type":"error","error"}             model-phase failure (terminal)
  // Request validation above still returns plain JSON with a proper status
  // code, because those failures happen before the stream starts.
  const encoder = new TextEncoder();

  const responseStream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      // A ping every 10s keeps proxies and the browser from dropping an
      // otherwise-idle connection while the model thinks.
      const heartbeat = setInterval(() => send({ type: "progress" }), 10000);

      try {
        const modelStream = client.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: PIPELINE_RULES,
          output_config: {
            effort,
            format: { type: "json_schema", schema },
          },
          messages: [{ role: "user", content: prompt }],
        });

        const message = await modelStream.finalMessage();
        const textBlock = message.content.find((block) => block.type === "text");
        if (!textBlock) {
          send({ type: "error", error: "The model returned no text content." });
        } else {
          let result;
          try {
            result = parseModelJson(textBlock.text);
          } catch {
            send({ type: "error", error: "The model returned malformed JSON." });
            return;
          }
          send({ type: "result", mode, result });
        }
      } catch (err) {
        const errorMessage =
          err?.error?.error?.message || err?.message || "Request to the model failed.";
        send({ type: "error", error: errorMessage });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
