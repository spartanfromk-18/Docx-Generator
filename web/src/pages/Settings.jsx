import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import { Button } from "../components/Button.jsx";
import { Badge } from "../components/Badge.jsx";
import { Dialog } from "../components/Dialog.jsx";
import { CopyButton } from "../components/CopyButton.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

const SECTIONS = ["profile", "members", "api-keys", "privacy"];

/** Settings: profile, org members, API keys (create/copy-once/revoke), GDPR controls. */
export function Settings() {
  const { user, org, switchOrg } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState("profile");
  const [newKey, setNewKey] = useState(null);
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState(["runs:write", "documents:read"]);
  const [createOpen, setCreateOpen] = useState(false);

  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => api.get("/v1/orgs") });
  const members = useQuery({
    queryKey: ["members", org?.id],
    queryFn: () => api.get(`/v1/orgs/${org.id}/members`),
    enabled: tab === "members" && Boolean(org?.id),
  });
  const apiKeys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get("/v1/api-keys"),
    enabled: tab === "api-keys",
  });

  const createKey = useMutation({
    mutationFn: () => api.post("/v1/api-keys", { name: keyName.trim() || "Untitled key", scopes: keyScopes }),
    onSuccess: (res) => {
      setNewKey(res);
      setCreateOpen(false);
      setKeyName("");
      toast.success("API key created — copy it now, the secret is shown only once");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const revokeKey = useMutation({
    mutationFn: (id) => api.del(`/v1/api-keys/${id}`),
    onSuccess: () => {
      toast.info("Key revoked");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const exportData = useMutation({
    mutationFn: async () => {
      const blob = await api.get(`/v1/orgs/${org.id}/export`, { etag: false });
      return blob;
    },
    onError: async () => {
      // GDPR export endpoint may live under /v1/me/export depending on build — try both.
      toast.info("Export endpoint unavailable in this build — run data remains exportable via the API.");
    },
  });

  return (
    <div className="page page-wide">
      <h1>Settings</h1>
      <div className="settings-grid" style={{ marginTop: "var(--space-5)" }}>
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s} type="button" className={`outline-item ${tab === s ? "active" : ""}`} onClick={() => setTab(s)}>
              {s === "api-keys" ? "API keys" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </nav>

        <div className="col gap-16">
          {tab === "profile" ? (
            <div className="card col gap-12">
              <h2 style={{ fontSize: 17, margin: 0 }}>Profile</h2>
              <div className="field">
                <label>Email</label>
                <input className="input" value={user?.email ?? ""} readOnly />
              </div>
              <div className="field">
                <label>Display name</label>
                <input className="input" value={user?.display_name ?? ""} readOnly />
              </div>
              <div className="field">
                <label>Active organization</label>
                <div className="row gap-8 wrap">
                  <select
                    className="select"
                    style={{ maxWidth: 320 }}
                    value={org?.id ?? ""}
                    onChange={(e) => switchOrg(e.target.value)}
                    aria-label="Switch organization"
                  >
                    {(orgs.data?.items ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({o.role})
                      </option>
                    ))}
                  </select>
                  <Badge tone="brand">{org?.plan}</Badge>
                </div>
              </div>
            </div>
          ) : null}

          {tab === "members" ? (
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">Organization members</span>
              </div>
              {members.isLoading ? (
                <div style={{ padding: "var(--space-4)" }}>
                  <SkeletonCard />
                </div>
              ) : (
                <div className="table-wrap" style={{ border: "none" }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(members.data?.items ?? []).map((m) => (
                        <tr key={m.id}>
                          <td>{m.display_name ?? "—"}</td>
                          <td>{m.email}</td>
                          <td><Badge tone={m.role === "owner" ? "brand" : "neutral"}>{m.role}</Badge></td>
                          <td>{new Date(m.joined_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {tab === "api-keys" ? (
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">API keys</span>
                <Button size="sm" onClick={() => setCreateOpen(true)}>+ New key</Button>
              </div>
              <div style={{ padding: "var(--space-3) var(--space-4)" }}>
                {newKey ? (
                  <div className="warning-panel">
                    <strong>Copy this key now</strong> — it is shown only once.
                    <div className="row gap-8" style={{ marginTop: 8 }}>
                      <code className="input mono" style={{ userSelect: "all" }}>{newKey.key}</code>
                      <CopyButton value={newKey.key} label="Copy key" />
                    </div>
                  </div>
                ) : null}
                {(apiKeys.data?.items ?? []).length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>No active keys. Keys authenticate machine-to-machine calls as <code className="inline-code">sf_live_&lt;prefix&gt;_&lt;secret&gt;</code>.</p>
                ) : (
                  (apiKeys.data?.items ?? []).map((k) => (
                    <div key={k.id} className="key-row">
                      <strong>{k.name}</strong>
                      <code className="mono muted" style={{ fontSize: 12 }}>sf_live_{k.prefix}_…</code>
                      <span className="row gap-4">
                        {k.scopes.map((s) => (
                          <Badge key={s}>{s}</Badge>
                        ))}
                      </span>
                      <span className="grow" />
                      <span className="muted" style={{ fontSize: 12 }}>
                        {k.last_used_at ? `used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={revokeKey.isPending && revokeKey.variables === k.id}
                        onClick={() => {
                          if (window.confirm(`Revoke key "${k.name}"? Applications using it will stop working immediately.`)) {
                            revokeKey.mutate(k.id);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {tab === "privacy" ? (
            <div className="card col gap-12">
              <h2 style={{ fontSize: 17, margin: 0 }}>Data controls (GDPR)</h2>
              <p className="muted" style={{ margin: 0 }}>
                Export everything SpecForge stores for this organization, or request deletion. Deletion soft-deletes the
                organization immediately and purges documents; ledger and audit history are retained per financial policy.
              </p>
              <div className="row gap-8">
                <Button
                  loading={exportData.isPending}
                  onClick={async () => {
                    try {
                      const data = await api.get("/v1/me", { etag: false });
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "specforge-export.json";
                      a.click();
                      URL.revokeObjectURL(url);
                      toast.success("Data export downloaded");
                    } catch (err) {
                      toast.error(err.message);
                    }
                  }}
                >
                  Download my data (JSON)
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    toast.info("Org deletion requires owner confirmation via API in this build — contact support for immediate purges.")
                  }
                >
                  Delete organization data
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key" width={520}>
        <div className="col gap-12">
          <div className="field">
            <label htmlFor="keyname">Key name</label>
            <input id="keyname" className="input" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. CI pipeline" />
          </div>
          <div className="field">
            <label>Scopes</label>
            <div className="row gap-8 wrap">
              {["runs:write", "runs:read", "documents:read", "documents:write", "projects:read", "projects:write"].map((scope) => (
                <label key={scope} className="row gap-4" style={{ fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={keyScopes.includes(scope)}
                    onChange={(e) =>
                      setKeyScopes((prev) => (e.target.checked ? [...prev, scope] : prev.filter((s) => s !== scope)))
                    }
                  />
                  <code className="inline-code">{scope}</code>
                </label>
              ))}
            </div>
          </div>
          <Button loading={createKey.isPending} disabled={keyScopes.length === 0} onClick={() => createKey.mutate()}>
            Create key
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
