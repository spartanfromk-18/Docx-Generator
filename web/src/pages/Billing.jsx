import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import { Button } from "../components/Button.jsx";
import { Badge } from "../components/Badge.jsx";
import { CreditMeter } from "../components/CreditMeter.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";

/** Billing: credit meter, ledger history, plan upgrades, mock checkout. */
export function Billing() {
  const { refreshCredits } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  const billing = useQuery({ queryKey: ["billing"], queryFn: () => api.get("/v1/billing/credits") });

  const checkout = useMutation({
    mutationFn: (payload) => api.post("/v1/billing/checkout", payload),
    onSuccess: (res) => {
      toast.success(`Payment complete — +${res.credits_added} credits${res.new_plan ? ` · now on ${res.new_plan}` : ""}`);
      qc.invalidateQueries({ queryKey: ["billing"] });
      refreshCredits();
    },
    onError: (err) => toast.error(err.message),
  });

  if (billing.isLoading) {
    return (
      <div className="page">
        <SkeletonCard />
        <div style={{ height: 16 }} />
        <SkeletonCard />
      </div>
    );
  }

  const data = billing.data;
  const plans = data?.plans ?? [];
  const ledger = data?.ledger ?? [];

  return (
    <div className="page">
      <h1>Billing & credits</h1>
      <p className="muted">Credits are reserved when runs start and settled per completed stage. This demo uses a mock Stripe — no real charges.</p>

      <div className="col gap-16" style={{ marginTop: "var(--space-5)" }}>
        <div className="card" style={{ maxWidth: 420 }}>
          <CreditMeter balance={data?.balance ?? 0} reserved={data?.reserved ?? 0} />
          {data?.subscription ? (
            <p className="muted" style={{ fontSize: 13, marginTop: "var(--space-3)", marginBottom: 0 }}>
              Plan <strong>{data.subscription.plan}</strong> · status <Badge tone={data.subscription.status === "active" ? "success" : "warning"}>{data.subscription.status}</Badge>
              {data.subscription.current_period_end ? ` · renews ${new Date(data.subscription.current_period_end).toLocaleDateString()}` : ""}
            </p>
          ) : null}
        </div>

        <section>
          <h2 style={{ fontSize: 18 }}>Upgrade plan</h2>
          <div className="plans-grid">
            {plans
              .filter((p) => p.id !== "free" && p.id !== "enterprise")
              .map((plan) => (
                <div key={plan.id} className="card plan-card">
                  <h3 style={{ margin: 0 }}>{plan.label}</h3>
                  <div className="plan-price">
                    ${plan.priceUsd}
                    <span> /month</span>
                  </div>
                  <ul className="plan-features">
                    <li>{plan.monthlyCredits} credits / month</li>
                    <li>{plan.concurrentRuns} concurrent runs</li>
                    <li>{plan.id === "pro" ? "Reference Mode crawling" : "Team workspaces + SSO"}</li>
                  </ul>
                  <Button
                    loading={checkout.isPending && checkout.variables?.plan === plan.id}
                    onClick={() => checkout.mutate({ kind: "plan", plan: plan.id })}
                  >
                    Switch to {plan.label}
                  </Button>
                </div>
              ))}
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 18 }}>Credit packs</h2>
          <div className="packs-row">
            {(data?.packs ?? [{ credits: 30, priceUsd: 10 }]).map((pack) => (
              <div key={pack.credits} className="pack-chip">
                <div style={{ fontWeight: 700, fontSize: 18 }}>{pack.credits} credits</div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>${pack.priceUsd ?? pack.price_usd}</div>
                <Button
                  size="sm"
                  loading={checkout.isPending && checkout.variables?.credits === pack.credits}
                  onClick={() => checkout.mutate({ kind: "pack", credits: pack.credits })}
                >
                  Buy
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 18 }}>Ledger history</h2>
          {ledger.length === 0 ? (
            <div className="empty-state">No transactions yet — run your first generation.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Stage</th>
                    <th>Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.created_at).toLocaleString()}</td>
                      <td>
                        <Badge tone={entry.entry_type === "grant" || entry.entry_type === "purchase" ? "success" : entry.entry_type === "settle" ? "info" : "neutral"}>
                          {entry.entry_type}
                        </Badge>
                      </td>
                      <td className="mono">{Number(entry.amount).toFixed(2)}</td>
                      <td className="muted" style={{ fontSize: 13 }}>{entry.stage ?? entry.run_id?.slice(0, 8) ?? "—"}</td>
                      <td className="mono">{Number(entry.balance_after).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
