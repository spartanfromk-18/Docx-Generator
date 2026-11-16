import { useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, ApiClientError } from "../lib/api.js";
import { Button } from "../components/Button.jsx";
import { Badge } from "../components/Badge.jsx";
import { useToast } from "../components/Toast.jsx";

/**
 * New project flow: ModeChooser (Idea vs Reference URL) → IdeaComposer / URL attach →
 * six-step GuidedWizard intake → cost preview → create + launch run.
 */

const WIZARD_STEPS = [
  { key: "audience", label: "Audience", placeholder: "Who is this for? e.g. warehouse ops teams of 5–50", hint: "Shapes personas and tone." },
  { key: "core_problem", label: "Core problem", placeholder: "What painful workflow does this remove?", hint: "One or two sentences is plenty." },
  { key: "must_have_features", label: "Must-have features", placeholder: "Comma-separated list, e.g. channel sync, forecasting, alerts", hint: "Drives FR generation." },
  { key: "scale_goal", label: "Scale goal", placeholder: "e.g. 10k DAU, 5k SKUs per tenant", hint: "Anchors NFRs and capacity math." },
  { key: "stack_preference", label: "Stack preference", placeholder: "e.g. Fastify + PostgreSQL + React", hint: "Informs the TRD." },
  { key: "compliance_needs", label: "Compliance needs", placeholder: "e.g. SOC 2, GDPR, PCI SAQ-A", hint: "Appears in security sections." },
];

const IDEA_STEPS = ["Compose", "Wizard 1–2", "Wizard 3–4", "Wizard 5–6", "Review"];
const REF_STEPS = ["Attach URL", "Wizard 1–3", "Wizard 4–6", "Confirm"];

const COSTS = {
  idea: { INTAKE_VALIDATE: 0.1, PRD: 0.8, TRD: 0.8, UX: 0.8, SCHEMA: 0.9, SCHEMA_VALIDATE: 0, REVIEW: 0.4, FINALIZE: 0.2 },
  reference: { INTAKE_VALIDATE: 0.1, CRAWL_FAST: 4.0, EXTRACT: 2.0, PRD: 0.8, TRD: 0.8, UX: 0.8, SCHEMA: 0.9, SCHEMA_VALIDATE: 0, REVIEW: 0.4, FINALIZE: 0.2 },
};

function totalFor(mode) {
  return Object.values(COSTS[mode]).reduce((s, n) => s + n, 0);
}

export function NewProject() {
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState(null); // 'idea' | 'reference'
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [url, setUrl] = useState("");
  const [attest, setAttest] = useState(false);
  const [intake, setIntake] = useState({});
  const [step, setStep] = useState(0);
  const [projectId, setProjectId] = useState(null);
  const [sourceId, setSourceId] = useState(null);

  const steps = mode === "reference" ? REF_STEPS : IDEA_STEPS;
  const costRows = useMemo(() => (mode ? Object.entries(COSTS[mode]) : []), [mode]);

  const createProject = useMutation({
    mutationFn: async () => {
      const project = await api.post("/v1/projects", {
        name: name.trim() || "Untitled project",
        idea_text: mode === "idea" ? idea.trim() : undefined,
        description: mode === "idea" ? idea.trim().slice(0, 140) : `Reference rebuild of ${url}`,
      });
      setProjectId(project.id);
      if (mode === "reference") {
        const source = await api.post(`/v1/projects/${project.id}/sources`, {
          url: url.trim(),
          attestation: true,
          respect_robots: true,
          max_pages: 25,
        });
        setSourceId(source.id);
        return { project, source };
      }
      return { project, source: null };
    },
    onError: (err) => toast.error(err.message),
  });

  const launchRun = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new ApiClientError(0, "NO_PROJECT", "Create the project first.");
      if (mode === "reference") {
        await api.post(`/v1/sources/${sourceId}/confirm`, {});
      }
      return api.post(`/v1/projects/${projectId}/runs`, {
        mode,
        ...(mode === "idea" ? { idea: idea.trim() } : { source_id: sourceId }),
        documents: ["PRD", "TRD", "UIUX", "SCHEMA"],
        intake,
      });
    },
    onSuccess: (run) => {
      toast.success("Run started — opening live monitor");
      navigate(`/app/runs/${run.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const wizardIdx = WIZARD_STEPS.map((s) => s.key);
  const visibleWizard = (from, to) => WIZARD_STEPS.slice(from, to);

  return (
    <div className="page page-narrow">
      <h1>New project</h1>
      <p className="muted">Pick a mode, compose the idea (or point at an existing product), then review the credit cost before anything runs.</p>

      {!mode ? (
        <div className="col gap-16" style={{ marginTop: "var(--space-6)" }}>
          <button type="button" className="card card-hover mode-card" onClick={() => setMode("idea")}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>💡 Idea Mode</h3>
              <Badge tone="brand">4 credits</Badge>
            </div>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              Start from a paragraph. Generates PRD, TRD, UI/UX and Schema with guided intake.
            </p>
          </button>
          <button type="button" className="card card-hover mode-card" onClick={() => setMode("reference")}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>🔗 Reference URL Mode</h3>
              <Badge tone="info">10 credits · Pro</Badge>
            </div>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              Crawl an existing product (robots.txt respected, SSRF-guarded) and extract design tokens, IA and components into the spec.
            </p>
          </button>
        </div>
      ) : (
        <>
          <div className="wizard-steps" role="list">
            {steps.map((label, idx) => (
              <span key={label} role="listitem" className={`wizard-step ${idx === step ? "active" : idx < step ? "done" : ""}`}>
                <span className="wizard-step-num">{idx < step ? "✓" : idx + 1}</span>
                {label}
              </span>
            ))}
          </div>

          {step === 0 && mode === "idea" && (
            <div className="col gap-16">
              <div className="field">
                <label htmlFor="pname">Project name</label>
                <input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Atlas Commerce Replatform" />
              </div>
              <div className="field">
                <label htmlFor="idea">Your idea</label>
                <textarea
                  id="idea"
                  className="textarea"
                  rows={7}
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="Describe the product in a paragraph — who it serves, the core workflow it fixes, and anything that makes it distinctive…"
                />
                <span className="field-hint">{idea.trim().length} characters (min 40 for good output; secrets are auto-redacted)</span>
              </div>
              <div className="row spread">
                <Button variant="ghost" onClick={() => setMode(null)}>← Change mode</Button>
                <Button disabled={idea.trim().length < 40} onClick={() => setStep(1)}>Continue to intake →</Button>
              </div>
            </div>
          )}

          {step === 0 && mode === "reference" && (
            <div className="col gap-16">
              <div className="field">
                <label htmlFor="rname">Project name</label>
                <input id="rname" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Storefront Rebuild" />
              </div>
              <div className="field">
                <label htmlFor="rurl">Product URL</label>
                <input id="rurl" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
                <span className="field-hint">Homepage plus depth-2 pages, max 25. Private/internal hosts are blocked.</span>
              </div>
              <label className="row gap-8" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
                I confirm I have the right to crawl this URL and will respect its terms.
              </label>
              <div className="row spread">
                <Button variant="ghost" onClick={() => setMode(null)}>← Change mode</Button>
                <Button
                  disabled={!/^https?:\/\/.+/.test(url) || !attest || createProject.isPending}
                  loading={createProject.isPending}
                  onClick={() =>
                    createProject.mutate(undefined, {
                      onSuccess: () => setStep(1),
                    })
                  }
                >
                  Attach URL & preview crawl
                </Button>
              </div>
            </div>
          )}

          {mode === "idea" && step >= 1 && step <= 3 && (
            <div className="col gap-16">
              {visibleWizard((step - 1) * 2, step * 2 + 2 > 6 ? 6 : step * 2 + 2).length === 0
                ? WIZARD_STEPS.slice((step - 1) * 2, step * 2).map((s) => (
                    <div className="field" key={s.key}>
                      <label htmlFor={`f-${s.key}`}>{s.label}</label>
                      <input
                        id={`f-${s.key}`}
                        className="input"
                        value={intake[s.key] ?? ""}
                        onChange={(e) => setIntake((prev) => ({ ...prev, [s.key]: e.target.value }))}
                        placeholder={s.placeholder}
                      />
                      <span className="field-hint">{s.hint} — optional, skippable.</span>
                    </div>
                  ))
                : WIZARD_STEPS.slice((step - 1) * 2, step * 2).map((s) => (
                    <div className="field" key={s.key}>
                      <label htmlFor={`f-${s.key}`}>{s.label}</label>
                      <input
                        id={`f-${s.key}`}
                        className="input"
                        value={intake[s.key] ?? ""}
                        onChange={(e) => setIntake((prev) => ({ ...prev, [s.key]: e.target.value }))}
                        placeholder={s.placeholder}
                      />
                      <span className="field-hint">{s.hint} — optional, skippable.</span>
                    </div>
                  ))}
              <div className="row spread">
                <Button variant="ghost" onClick={() => setStep(step - 1)}>← Back</Button>
                <Button onClick={() => setStep(step + 1)}>{step === 3 ? "Review cost →" : "Continue →"}</Button>
              </div>
            </div>
          )}

          {mode === "reference" && step === 1 && (
            <div className="col gap-16">
              <div className="hint-banner">
                Crawl requested (202). The preview extraction runs with the crawl — continue composing intake while it works.
              </div>
              {visibleWizard(0, 3).map((s) => (
                <div className="field" key={s.key}>
                  <label htmlFor={`f-${s.key}`}>{s.label}</label>
                  <input
                    id={`f-${s.key}`}
                    className="input"
                    value={intake[s.key] ?? ""}
                    onChange={(e) => setIntake((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    placeholder={s.placeholder}
                  />
                </div>
              ))}
              <div className="row spread">
                <Button variant="ghost" onClick={() => setStep(0)}>← Back</Button>
                <Button onClick={() => setStep(2)}>Continue →</Button>
              </div>
            </div>
          )}

          {mode === "reference" && step === 2 && (
            <div className="col gap-16">
              {visibleWizard(3, 6).map((s) => (
                <div className="field" key={s.key}>
                  <label htmlFor={`f-${s.key}`}>{s.label}</label>
                  <input
                    id={`f-${s.key}`}
                    className="input"
                    value={intake[s.key] ?? ""}
                    onChange={(e) => setIntake((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    placeholder={s.placeholder}
                  />
                </div>
              ))}
              <div className="row spread">
                <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
                <Button onClick={() => setStep(3)}>Review cost →</Button>
              </div>
            </div>
          )}

          {(mode === "idea" && step === 4) || (mode === "reference" && step === 3) ? (
            <div className="col gap-16">
              <div className="cost-preview" role="table" aria-label="Cost breakdown">
                <h3 style={{ marginTop: 0 }}>Cost preview</h3>
                {costRows.map(([stage, cost]) => (
                  <div className="cost-row" key={stage} role="row">
                    <span className="mono" style={{ fontSize: 13 }}>{stage.replace(/_/g, " ").toLowerCase()}</span>
                    <span>{cost === 0 ? "included" : `${cost.toFixed(2)} cr`}</span>
                  </div>
                ))}
                <div className="cost-row total" role="row">
                  <span>Total</span>
                  <span>{totalFor(mode).toFixed(2)} credits</span>
                </div>
              </div>
              <p className="muted" style={{ fontSize: 14, margin: 0 }}>
                Credits are reserved now and settled per completed stage. Cancelling releases unused reservation.
              </p>
              <div className="row spread">
                <Button variant="ghost" onClick={() => setStep(step - 1)}>← Back</Button>
                <Button
                  size="lg"
                  loading={launchRun.isPending}
                  disabled={!projectId && createProject.isPending}
                  onClick={() => launchRun.mutate()}
                >
                  🚀 Start run ({totalFor(mode).toFixed(2)} credits)
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {createProject.isPending || launchRun.isPending ? (
        <p className="muted" style={{ fontSize: 13 }}>
          {createProject.isPending ? "Creating project…" : "Launching run…"} You can keep this tab open — the run continues server-side.
        </p>
      ) : null}

      <p className="muted" style={{ fontSize: 13, marginTop: "var(--space-8)" }}>
        Changed your mind? <Link to="/app">Back to dashboard</Link>
      </p>
    </div>
  );
}
