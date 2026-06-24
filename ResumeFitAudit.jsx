"use client";

import { useState, useRef } from "react";

// ============================================================
// Resume Fit Audit
// Paste or upload a resume + a job description. The grader runs
// server-side via /api/grade, so the Claude API key stays on the
// server and never reaches the browser: an honesty report first
// (calibrated grade, real gaps), then tailored resume + cover
// letter on demand.
// Aesthetic: editorial audit report. Bone paper, ink, rust accent.
// ============================================================

const PALETTE = {
  paper: "#f3eee2",
  paperDeep: "#ece5d4",
  ink: "#1d1b16",
  inkSoft: "#4a463b",
  faint: "#8a8474",
  rust: "#a8431c",
  rustSoft: "#c4663d",
  green: "#3c6248",
  ochre: "#8a6312",
  line: "#cbc3ad",
};

// Calls the server route, which holds the API key and runs the grading
// pipeline (PIPELINE_RULES + the report/docs prompt builders). Returns the
// parsed result object, or throws with a readable message.
async function gradeViaApi(mode, { resume, jd, context, report }) {
  const res = await fetch("/api/grade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // report is sent only for docs mode, so the rewrite builds on the report's
    // analysis instead of re-deriving it. Undefined for report mode (omitted).
    body: JSON.stringify({ mode, resume, jobDescription: jd, context, report }),
  });

  // Request-validation failures come back as a non-2xx JSON response (no
  // stream). Read them the old way.
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      data?.error || `Request failed (${res.status}). Try again in a moment.`
    );
  }

  // Success is an NDJSON stream: zero or more {type:"progress"} keepalives,
  // then exactly one terminal {type:"result"} or {type:"error"} line.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "error") throw new Error(msg.error || "Something went wrong. Try again.");
      if (msg.type === "result") result = msg.result;
      // type === "progress": just a keepalive, keep reading.
    }
  }

  if (result === undefined) {
    throw new Error("The response ended unexpectedly. Try again.");
  }
  return result;
}

function gradeTone(g) {
  if (g >= 7) return { label: "Strong fit", color: PALETTE.green };
  if (g >= 4) return { label: "Honest, uneven fit", color: PALETTE.ochre };
  return { label: "Stretch", color: PALETTE.rust };
}

export default function ResumeFitAudit() {
  const [resume, setResume] = useState("");
  const [jd, setJd] = useState("");
  const [context, setContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [fileName, setFileName] = useState("");

  const [reportLoading, setReportLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  const [docsLoading, setDocsLoading] = useState(false);
  const [docs, setDocs] = useState(null);
  const [docTab, setDocTab] = useState("resume");
  const [copied, setCopied] = useState("");

  const fileRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      if (file.name.toLowerCase().endsWith(".docx")) {
        // Load the browser build only in the browser, on demand.
        const mammoth = (await import("mammoth/mammoth.browser")).default;
        const buf = await file.arrayBuffer();
        const out = await mammoth.extractRawText({ arrayBuffer: buf });
        setResume(out.value.trim());
      } else {
        const txt = await file.text();
        setResume(txt.trim());
      }
      setFileName(file.name);
    } catch {
      setError("Could not read that file. Paste the text instead, or try a .docx or .txt.");
    }
  }

  async function runReport() {
    setError("");
    if (resume.trim().length < 80) return setError("Add your resume first (paste it or upload a .docx).");
    if (jd.trim().length < 80) return setError("Paste the job description.");
    setReport(null);
    setDocs(null);
    setReportLoading(true);
    try {
      const result = await gradeViaApi("report", { resume, jd, context });
      setReport(result);
    } catch (err) {
      setError(err.message || "Something went wrong reading the result. Try again.");
    } finally {
      setReportLoading(false);
    }
  }

  async function runDocs() {
    setError("");
    setDocsLoading(true);
    try {
      const result = await gradeViaApi("docs", { resume, jd, context, report });
      setDocs(result);
      setDocTab("resume");
    } catch (err) {
      setError(err.message || "Could not generate the documents. Try again.");
    } finally {
      setDocsLoading(false);
    }
  }

  function copy(which, text) {
    navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(""), 1400);
  }

  const tone = report ? gradeTone(report.fitGrade) : null;

  return (
    <div style={{ minHeight: "100vh", background: PALETTE.paper, color: PALETTE.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=JetBrains+Mono:wght@400;500;700&display=swap');
        .rfa * { box-sizing: border-box; }
        .rfa { font-family: 'Newsreader', Georgia, serif; line-height: 1.5; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .disp { font-family: 'Fraunces', Georgia, serif; }
        .label { font-family:'JetBrains Mono',monospace; font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:${PALETTE.faint}; }
        .ta { width:100%; background:${PALETTE.paperDeep}; border:1px solid ${PALETTE.line}; border-radius:2px; padding:13px 14px;
              font-family:'JetBrains Mono',monospace; font-size:12.5px; line-height:1.55; color:${PALETTE.ink}; resize:vertical; outline:none; }
        .ta:focus { border-color:${PALETTE.rust}; box-shadow:0 0 0 2px rgba(168,67,28,.12); }
        .btn { font-family:'JetBrains Mono',monospace; font-size:12px; letter-spacing:.08em; text-transform:uppercase;
               border:1px solid ${PALETTE.ink}; background:${PALETTE.ink}; color:${PALETTE.paper}; padding:12px 22px;
               border-radius:2px; cursor:pointer; transition:transform .12s ease, opacity .2s; }
        .btn:hover:not(:disabled){ transform:translateY(-1px); }
        .btn:disabled{ opacity:.45; cursor:default; }
        .btn-ghost{ background:transparent; color:${PALETTE.ink}; }
        .chip { font-family:'JetBrains Mono',monospace; font-size:11px; padding:4px 9px; border:1px solid ${PALETTE.line};
                border-radius:2px; background:${PALETTE.paperDeep}; color:${PALETTE.inkSoft}; }
        .reveal { animation: rise .5s cubic-bezier(.2,.7,.3,1) both; }
        @keyframes rise { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
        .rule { height:1px; background:${PALETTE.line}; border:0; }
        .dots { display:inline-block; }
        .dots:after { content:''; animation: dots 1.4s steps(4,end) infinite; }
        @keyframes dots { 0%{content:''} 25%{content:'.'} 50%{content:'..'} 75%{content:'...'} 100%{content:''} }
      `}</style>

      <div className="rfa" style={{ maxWidth: 980, margin: "0 auto", padding: "34px 22px 80px" }}>

        {/* Masthead */}
        <header style={{ borderBottom: `2px solid ${PALETTE.ink}`, paddingBottom: 14, marginBottom: 26 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
            <h1 className="disp" style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: "-.02em", lineHeight: 1 }}>
              Resume Fit <span style={{ color: PALETTE.rust, fontStyle: "italic", fontWeight: 600 }}>Audit</span>
            </h1>
            <div className="label" style={{ textAlign: "right" }}>
              Calibrated, not encouraging<br />
              <span style={{ color: PALETTE.inkSoft }}>most honest fits land 4 to 7</span>
            </div>
          </div>
        </header>

        {/* Inputs */}
        <section style={{ display: "grid", gridTemplateColumns: "1fr", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 18 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span className="label">01 / Your resume</span>
                <span>
                  <input ref={fileRef} type="file" accept=".docx,.txt,.md" onChange={handleFile} style={{ display: "none" }} />
                  <button className="label" onClick={() => fileRef.current?.click()}
                    style={{ background: "none", border: "none", cursor: "pointer", color: PALETTE.rust, padding: 0 }}>
                    {fileName ? `↻ ${fileName.slice(0, 18)}` : "↑ upload .docx / .txt"}
                  </button>
                </span>
              </div>
              <textarea className="ta" rows={11} value={resume}
                onChange={(e) => { setResume(e.target.value); setFileName(""); }}
                placeholder="Paste your full resume here, or upload a .docx above. The more complete, the more honest the read." />
              <div className="label" style={{ marginTop: 4 }}>{resume.length.toLocaleString()} chars</div>
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>02 / Job description</div>
              <textarea className="ta" rows={11} value={jd} onChange={(e) => setJd(e.target.value)}
                placeholder="Paste the full job posting here." />
              <div className="label" style={{ marginTop: 4 }}>{jd.length.toLocaleString()} chars</div>
            </div>
          </div>

          <div>
            <button className="label" onClick={() => setShowContext((s) => !s)}
              style={{ background: "none", border: "none", cursor: "pointer", color: PALETTE.inkSoft, padding: 0 }}>
              {showContext ? "− hide" : "+ add"} optional context (projects + links, referral, relocation, achievements not in resume)
            </button>
            {showContext && (
              <textarea className="ta" rows={3} value={context} onChange={(e) => setContext(e.target.value)}
                style={{ marginTop: 6 }} placeholder="Projects with links (e.g. Resume Fit Audit, github.com/you/x) / referral / open to relocating / shipped X last month. Links here feed the Projects section when the job asks to see what you've built." />
            )}
          </div>

          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={runReport} disabled={reportLoading}>
              {reportLoading ? <span className="dots">Auditing</span> : "Run the audit"}
            </button>
            {error && <span className="mono" style={{ color: PALETTE.rust, fontSize: 12.5 }}>{error}</span>}
          </div>
        </section>

        {/* Report */}
        {report && (
          <section className="reveal" style={{ marginTop: 34 }}>
            <hr className="rule" />
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "flex-start", padding: "26px 0" }}>
              <div style={{ minWidth: 132 }}>
                <div className="label" style={{ marginBottom: 4 }}>Fit grade</div>
                <div className="disp" style={{ fontSize: 76, lineHeight: 1, fontWeight: 700, color: tone.color }}>
                  {report.fitGrade}<span style={{ fontSize: 26, color: PALETTE.faint }}>/10</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: tone.color, marginTop: 4, textTransform: "uppercase", letterSpacing: ".1em" }}>
                  {tone.label}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="label" style={{ marginBottom: 6 }}>{report.role}</div>
                <p className="disp" style={{ margin: 0, fontSize: 21, lineHeight: 1.35, fontWeight: 400 }}>
                  {report.gradeReasoning}
                </p>
              </div>
            </div>

            {(report.jdThesis || report.leadHook || report.companyRead) && (
              <>
                <hr className="rule" />
                <div style={{ paddingTop: 22, display: "grid", gap: 16 }}>
                  <div className="label" style={{ color: PALETTE.ink }}>How to win this one</div>
                  {report.jdThesis && (
                    <div>
                      <span className="label" style={{ color: PALETTE.faint }}>What the role values most</span>
                      <p className="disp" style={{ margin: "3px 0 0", fontSize: 17, lineHeight: 1.4 }}>{report.jdThesis}</p>
                    </div>
                  )}
                  {report.leadHook && (
                    <div>
                      <span className="label" style={{ color: PALETTE.faint }}>Lead with this</span>
                      <p style={{ margin: "3px 0 0", fontSize: 15.5, lineHeight: 1.45, color: PALETTE.green, fontWeight: 500 }}>{report.leadHook}</p>
                    </div>
                  )}
                  {report.companyRead && (
                    <div>
                      <span className="label" style={{ color: PALETTE.faint }}>Company read</span>
                      <p style={{ margin: "3px 0 0", fontSize: 15, lineHeight: 1.45, color: PALETTE.inkSoft }}>{report.companyRead}</p>
                    </div>
                  )}
                </div>
              </>
            )}

            <hr className="rule" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 30, paddingTop: 22 }}>
              <Block title="Where it lands" accent={PALETTE.green}>
                {(report.fitPoints || []).map((p, i) => (
                  <li key={i} style={liStyle(PALETTE.green)}>{p}</li>
                ))}
              </Block>
              <Block title="Real gaps" accent={PALETTE.ochre}>
                {(report.gaps || []).map((g, i) => (
                  <li key={i} style={liStyle(PALETTE.ochre)}>
                    <span style={{ fontWeight: 500 }}>{typeof g === "string" ? g : g.gap}</span>
                    {g.strategy && <span style={{ display: "block", color: PALETTE.inkSoft, fontSize: 14, marginTop: 2 }}>→ {g.strategy}</span>}
                  </li>
                ))}
              </Block>
            </div>

            {report.keywordsToSurface?.length > 0 && (
              <div style={{ paddingTop: 22 }}>
                <div className="label" style={{ marginBottom: 4, color: PALETTE.green }}>Keywords to surface (you already qualify)</div>
                <p className="mono" style={{ fontSize: 11, color: PALETTE.faint, margin: "0 0 12px" }}>
                  Re-word these so the resume matches the posting's language. Honest: the evidence is already in your resume.
                </p>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {report.keywordsToSurface.map((k, i) => (
                    <li key={i} style={{ padding: "10px 0", borderTop: i ? `1px solid ${PALETTE.line}` : "none" }}>
                      <span className="chip" style={{ borderColor: PALETTE.green, color: PALETTE.green }}>{k.term}</span>
                      <div style={{ fontSize: 15, lineHeight: 1.45, color: "#2a2720", marginTop: 6 }}>{k.suggestedRephrase}</div>
                      {k.currentPhrasing && (
                        <div className="mono" style={{ fontSize: 11, color: PALETTE.faint, marginTop: 3 }}>now: {k.currentPhrasing}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.structuralGaps?.length > 0 && (
              <div style={{ paddingTop: 22 }}>
                <Block title="Fix before you apply" accent={PALETTE.rust}>
                  {report.structuralGaps.map((s, i) => <li key={i} style={liStyle(PALETTE.rust)}>{s}</li>)}
                </Block>
              </div>
            )}

            {(report.tradeoffs?.length > 0 || report.keywordsMissing?.length > 0) && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 30, paddingTop: 8 }}>
                {report.tradeoffs?.length > 0 && (
                  <Block title="Honesty trade-offs" accent={PALETTE.rust}>
                    {report.tradeoffs.map((t, i) => <li key={i} style={liStyle(PALETTE.rust)}>{t}</li>)}
                  </Block>
                )}
                {report.keywordsMissing?.length > 0 && (
                  <div>
                    <div className="label" style={{ marginBottom: 10, color: PALETTE.ink }}>Keywords you cannot honestly claim</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {report.keywordsMissing.map((k, i) => <span key={i} className="chip">{k}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Documents */}
            <div style={{ marginTop: 34 }}>
              <hr className="rule" />
              {!docs && (
                <div style={{ paddingTop: 22 }}>
                  <button className="btn btn-ghost" onClick={runDocs} disabled={docsLoading}>
                    {docsLoading ? <span className="dots">Drafting documents</span> : "Generate tailored resume + cover letter"}
                  </button>
                  <p className="mono" style={{ fontSize: 11.5, color: PALETTE.faint, marginTop: 10 }}>
                    Read the caveats above first. The documents emphasize honestly; they never add what the resume cannot support.
                  </p>
                </div>
              )}

              {docs && (
                <div className="reveal" style={{ paddingTop: 22 }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                    {["resume", "cover"].map((t) => (
                      <button key={t} onClick={() => setDocTab(t)} className="label"
                        style={{
                          padding: "7px 13px", cursor: "pointer", borderRadius: 2,
                          border: `1px solid ${docTab === t ? PALETTE.ink : PALETTE.line}`,
                          background: docTab === t ? PALETTE.ink : "transparent",
                          color: docTab === t ? PALETTE.paper : PALETTE.inkSoft,
                        }}>
                        {t === "resume" ? "Tailored resume" : "Cover letter"}
                      </button>
                    ))}
                    <button className="label" onClick={() => copy(docTab, docTab === "resume" ? docs.tailoredResume : docs.coverLetter)}
                      style={{ marginLeft: "auto", padding: "7px 13px", cursor: "pointer", border: `1px solid ${PALETTE.line}`, borderRadius: 2, background: "transparent", color: PALETTE.rust }}>
                      {copied === docTab ? "✓ copied" : "copy"}
                    </button>
                  </div>
                  <pre style={{
                    whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, lineHeight: 1.65,
                    background: PALETTE.paperDeep, border: `1px solid ${PALETTE.line}`, borderRadius: 2,
                    padding: "20px 22px", margin: 0, color: PALETTE.ink, maxHeight: 520, overflow: "auto",
                  }}>
                    {docTab === "resume" ? docs.tailoredResume : docs.coverLetter}
                  </pre>
                  <button className="label" onClick={runDocs} disabled={docsLoading}
                    style={{ background: "none", border: "none", cursor: "pointer", color: PALETTE.faint, marginTop: 10, padding: 0 }}>
                    {docsLoading ? "regenerating..." : "↻ regenerate"}
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        <footer className="mono" style={{ marginTop: 50, fontSize: 10.5, color: PALETTE.faint, textAlign: "center" }}>
          Runs on the Claude API. Nothing is stored. Grades are advisory; the human makes the call.
        </footer>
      </div>
    </div>
  );
}

function Block({ title, accent, children }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 10, color: accent, letterSpacing: ".14em" }}>{title}</div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul>
    </div>
  );
}

function liStyle(accent) {
  return {
    fontFamily: "'Newsreader', serif", fontSize: 15.5, lineHeight: 1.45, color: "#2a2720",
    padding: "0 0 12px 15px", borderLeft: `2px solid ${accent}`, marginBottom: 10, marginLeft: 1,
  };
}
