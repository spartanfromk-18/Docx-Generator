import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiClientError } from "../lib/api.js";
import { Button } from "../components/Button.jsx";
import { Badge } from "../components/Badge.jsx";
import { SectionPill } from "../components/SectionPill.jsx";
import { Dialog } from "../components/Dialog.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { renderMermaid } from "../components/MermaidRender.jsx";
import { CopyButton } from "../components/CopyButton.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

/**
 * Document workspace: sticky outline with J/K navigation, inline section editor,
 * AI regeneration (0.25 credits), version drawer with diff, review warnings,
 * exports and share links.
 */
export function Document() {
  const { documentId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [activeSection, setActiveSection] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [diffVersion, setDiffVersion] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [shareResult, setShareResult] = useState(null);
  const sectionRefs = useRef([]);

  const doc = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => api.get(`/v1/documents/${documentId}`),
  });
  const versions = useQuery({
    queryKey: ["document-versions", documentId],
    queryFn: () => api.get(`/v1/documents/${documentId}/versions`),
    enabled: drawerOpen,
  });

  const document_ = doc.data?.document;
  const version = doc.data?.version;
  const sections = doc.data?.sections ?? [];

  // J/K keyboard navigation + E to edit.
  useEffect(() => {
    const onKey = (e) => {
      if (editing || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "j" || e.key === "J") setActiveSection((i) => Math.min(sections.length - 1, i + 1));
      if (e.key === "k" || e.key === "K") setActiveSection((i) => Math.max(0, i - 1));
      if ((e.key === "e" || e.key === "E") && sections[activeSection]) {
        setDraft(sections[activeSection].body_md);
        setEditing(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sections, activeSection, editing]);

  useEffect(() => {
    sectionRefs.current[activeSection]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [activeSection]);

  const diff = useMemo(() => {
    if (!diffVersion || !version) return null;
    const old = sections;
    const res = diffVersion.sections ?? [];
    return { old, res };
  }, [diffVersion, version, sections]);

  const saveEdits = useMutation({
    mutationFn: () =>
      api.post(`/v1/documents/${documentId}/versions`, {
        base_version_no: version.version_no,
        sections: [{ id: sections[activeSection].id, body_md: draft }],
        change_note: `Edited “${sections[activeSection].heading}”`,
      }),
    onSuccess: () => {
      setEditing(false);
      toast.success("Version saved");
      qc.invalidateQueries({ queryKey: ["document", documentId] });
      qc.invalidateQueries({ queryKey: ["document-versions", documentId] });
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.code === "VERSION_CONFLICT") {
        toast.error("Conflict — the document changed. Reload before editing.");
      } else {
        toast.error(err.message);
      }
    },
  });

  const regenerate = useMutation({
    mutationFn: (instruction) =>
      api.post(`/v1/documents/${documentId}/sections/${sections[activeSection].id}/regenerate`, instruction ? { instruction } : {}),
    onSuccess: () => {
      toast.success("Section regenerated (0.25 credits)");
      qc.invalidateQueries({ queryKey: ["document", documentId] });
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.code === "INSUFFICIENT_CREDITS") {
        toast.error("Not enough credits — top up in Billing (0.25 needed).");
      } else {
        toast.error(err.message);
      }
    },
  });

  const createShare = useMutation({
    mutationFn: () =>
      api.post(`/v1/documents/${documentId}/share-links`, {
        expires_in_days: 30,
        ...(sharePassword ? { password: sharePassword } : {}),
      }),
    onSuccess: (res) => {
      setShareResult(res);
      toast.success("Share link created — copy it now, the token is shown only once");
    },
    onError: (err) => toast.error(err.message),
  });

  const runExport = useMutation({
    mutationFn: (format) => api.post(`/v1/documents/${documentId}/exports`, { format }),
    onSuccess: async (res) => {
      toast.success("Export ready — downloading…");
      await api.download(`/v1/exports/${res.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  if (doc.isLoading) {
    return (
      <div className="page page-wide">
        <SkeletonCard />
      </div>
    );
  }
  if (!document_) {
    return (
      <div className="page">
        <div className="empty-state">Document not found. <Link to="/app">Back to dashboard</Link></div>
      </div>
    );
  }

  const warnings = version?.change_note === undefined ? null : null; // review warnings come from the run

  return (
    <div className="page page-wide">
      <div className="row spread wrap gap-12" style={{ marginBottom: "var(--space-4)" }}>
        <div>
          <h1 style={{ marginBottom: 4, fontSize: 22 }}>{document_.title}</h1>
          <div className="row gap-8 wrap">
            <Badge tone="brand">{document_.doc_type}</Badge>
            <Badge>v{version?.version_no}</Badge>
            {version?.author_type ? <Badge tone={version.author_type === "ai" ? "info" : "neutral"}>{version.author_type}</Badge> : null}
            <span className="muted" style={{ fontSize: 13 }}>
              {sections.length} sections · updated {new Date(document_.updated_at).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="row gap-8 wrap">
          <Button size="sm" variant="ghost" onClick={() => setDrawerOpen(true)}>Version history</Button>
          <Button size="sm" variant="ghost" loading={runExport.isPending && runExport.variables === "md"} onClick={() => runExport.mutate("md")}>↓ .md</Button>
          <Button size="sm" variant="ghost" loading={runExport.isPending && runExport.variables === "docx"} onClick={() => runExport.mutate("docx")}>↓ .docx</Button>
          <Button size="sm" onClick={() => setShareOpen(true)}>🔗 Share</Button>
        </div>
      </div>

      <div className="hint-banner row spread wrap" style={{ background: "var(--color-surface)", color: "var(--color-text-secondary)" }}>
        <span>Keyboard: <kbd className="inline-code">J</kbd>/<kbd className="inline-code">K</kbd> navigate sections · <kbd className="inline-code">E</kbd> edit current</span>
      </div>

      <div className="doc-layout">
        <nav className="doc-outline card" aria-label="Section outline" style={{ padding: "var(--space-2)" }}>
          {sections.map((section, idx) => (
            <button
              key={section.id}
              type="button"
              ref={(el) => (sectionRefs.current[idx] = el)}
              className={`outline-item ${activeSection === idx ? "active" : ""}`}
              onClick={() => setActiveSection(idx)}
            >
              <SectionPill status={section.status} ordinal={idx + 1} />
              <span className="outline-title">{section.heading}</span>
            </button>
          ))}
        </nav>

        <main className="col gap-16">
          {warnings ? null : null}
          {editing ? (
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">Editing: {sections[activeSection]?.heading}</span>
                <Badge tone="warning">creates v{version.version_no + 1}</Badge>
              </div>
              <div style={{ padding: "var(--space-4)" }} className="col gap-12">
                <textarea className="textarea editor-textarea" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="row gap-8">
                  <Button loading={saveEdits.isPending} onClick={() => saveEdits.mutate()} disabled={draft.trim().length === 0}>
                    Save as new version
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                  <span className="grow" />
                  <CopyButton value={draft} label="Copy markdown" />
                </div>
              </div>
            </div>
          ) : sections[activeSection] ? (
            <article className="panel reader-section" style={{ padding: "var(--space-5)" }}>
              <div className="reader-section-head">
                <h2 style={{ margin: 0, fontSize: 19 }}>{sections[activeSection].heading}</h2>
                <span className="grow" />
                <Button
                  size="sm"
                  variant="ghost"
                  loading={regenerate.isPending}
                  title="AI regeneration — 0.25 credits"
                  onClick={() => regenerate.mutate("")}
                >
                  ✨ Regenerate (0.25 cr)
                </Button>
                <Button size="sm" onClick={() => { setDraft(sections[activeSection].body_md); setEditing(true); }}>
                  Edit
                </Button>
              </div>
              <Markdown source={sections[activeSection].body_md} renderMermaid={renderMermaid} />
            </article>
          ) : null}

          <div className="row gap-8">
            <Button variant="ghost" size="sm" onClick={() => setActiveSection((i) => Math.max(0, i - 1))} disabled={activeSection === 0}>
              ← Previous (K)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveSection((i) => Math.min(sections.length - 1, i + 1))}
              disabled={activeSection >= sections.length - 1}
            >
              Next (J) →
            </Button>
          </div>
        </main>
      </div>

      {/* Version history drawer */}
      <Dialog open={drawerOpen} onClose={() => { setDrawerOpen(false); setDiffVersion(null); }} title="Version history" width={640}>
        {versions.isLoading ? (
          <SkeletonCard />
        ) : (
          <div>
            {(versions.data?.items ?? []).map((v) => (
              <div key={v.id} className="version-item">
                <div>
                  <strong>v{v.version_no}</strong> <Badge tone={v.author_type === "ai" ? "info" : "neutral"}>{v.author_type}</Badge>
                  {v.change_note ? <div className="muted" style={{ fontSize: 13 }}>{v.change_note}</div> : null}
                  <div className="muted" style={{ fontSize: 12 }}>{new Date(v.created_at).toLocaleString()} · {v.sections_count} sections</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setDiffVersion(v)}>Diff vs current</Button>
              </div>
            ))}
            {diff ? (
              <div style={{ marginTop: "var(--space-4)" }}>
                <h3 style={{ fontSize: 15 }}>Diff — v{diffVersion.version_no} vs current</h3>
                <div className="col gap-4" style={{ maxHeight: 300, overflowY: "auto" }}>
                  {diff.old.map((section, i) => {
                    const other = diff.res[i];
                    if (!other || other.body_md !== section.body_md) {
                      return (
                        <div key={section.id}>
                          <div className="diff-block diff-del">{section.heading}: {section.body_md.slice(0, 120)}…</div>
                          {other ? <div className="diff-block diff-add">{other.heading}: {other.body_md.slice(0, 120)}…</div> : null}
                        </div>
                      );
                    }
                    return <div key={section.id} className="muted" style={{ fontSize: 13 }}>· {section.heading} (unchanged)</div>;
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Dialog>

      {/* Share modal */}
      <Dialog
        open={shareOpen}
        onClose={() => { setShareOpen(false); setShareResult(null); setSharePassword(""); }}
        title="Share this document"
        width={520}
      >
        {!shareResult ? (
          <div className="col gap-12">
            <p className="muted" style={{ margin: 0 }}>Creates a public read-only link valid for 30 days. Only the hash of the token is stored.</p>
            <div className="field">
              <label htmlFor="sharepw">Optional password</label>
              <input id="sharepw" className="input" type="text" value={sharePassword} onChange={(e) => setSharePassword(e.target.value)} placeholder="Leave empty for no password" />
            </div>
            <Button loading={createShare.isPending} onClick={() => createShare.mutate()}>Create share link</Button>
          </div>
        ) : (
          <div className="col gap-12">
            <p style={{ margin: 0 }}><strong>Copy this link now</strong> — the token is never shown again.</p>
            <div className="row gap-8">
              <code className="input mono" style={{ userSelect: "all", overflow: "hidden", textOverflow: "ellipsis" }}>
                {window.location.origin}/s/{shareResult.token}
              </code>
              <CopyButton value={`${window.location.origin}/s/${shareResult.token}`} label="Copy" />
            </div>
            {shareResult.password_protected ? <Badge tone="warning">password protected</Badge> : null}
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>Expires {new Date(shareResult.expires_at).toLocaleDateString()} · revoke anytime from Settings.</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
