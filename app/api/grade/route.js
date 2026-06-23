import Anthropic from "@anthropic-ai/sdk";

// Run on the Node.js runtime (the Anthropic SDK is not edge-compatible).
export const runtime = "nodejs";
// Allow longer model calls than the default serverless timeout on Vercel.
export const maxDuration = 60;

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
    fitGrade: { type: "integer" },
    gradeReasoning: { type: "string" },
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
    keywordsMissing: { type: "array", items: { type: "string" } },
    tradeoffs: { type: "array", items: { type: "string" } },
  },
  required: [
    "role",
    "fitGrade",
    "gradeReasoning",
    "fitPoints",
    "gaps",
    "keywordsMissing",
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
  return `Assess this candidate against the job below. Extract the JD's required years, seniority, hard skills, and the keywords that appear 3+ times. Read the resume. Produce a compact, honest report.

Return ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{
  "role": "Role title and organization, one line",
  "fitGrade": <integer 1-10>,
  "gradeReasoning": "one honest sentence explaining the grade",
  "fitPoints": ["3 to 5 genuine, evidence-tied strengths"],
  "gaps": [{"gap": "a real gap named concretely", "strategy": "one-line cover-letter strategy for it"}],
  "keywordsMissing": ["JD keywords absent from the resume that cannot be added without fabrication"],
  "tradeoffs": ["honesty trade-offs or verb downgrades you made or would make"]
}

=== MASTER RESUME ===
${resume}

=== JOB DESCRIPTION ===
${jd}
${context ? `\n=== EXTRA CONTEXT ===\n${context}` : ""}

Return ONLY the JSON object.`;
}

function buildDocsPrompt(resume, jd, context) {
  return `Produce a tailored resume and a cover letter for this candidate and job. Select the most relevant content from the master resume, rewrite bullets to lead with strong honest verbs and quantified impact, drop filler, and land JD keywords only where truthful. The cover letter opens with the application and value proposition (no "I am excited to"), names any real gap directly and reframes it, converts unfixable gaps into an honest first-90-day plan, and closes with dignity. No em dashes or en dashes. Use "to" for date ranges.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "tailoredResume": "full plain-text resume, use real line breaks (\\n) between lines and sections",
  "coverLetter": "full plain-text cover letter, use real line breaks (\\n)"
}

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
      : buildDocsPrompt(resume, jobDescription, context);

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: PIPELINE_RULES,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema },
      },
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    if (!textBlock) {
      return Response.json(
        { error: "The model returned no text content." },
        { status: 502 }
      );
    }

    let result;
    try {
      result = parseModelJson(textBlock.text);
    } catch {
      return Response.json(
        { error: "The model returned malformed JSON." },
        { status: 502 }
      );
    }

    return Response.json({ mode, result });
  } catch (err) {
    const status = typeof err?.status === "number" ? err.status : 500;
    const errorMessage =
      err?.error?.error?.message || err?.message || "Request to the model failed.";
    return Response.json({ error: errorMessage }, { status });
  }
}
