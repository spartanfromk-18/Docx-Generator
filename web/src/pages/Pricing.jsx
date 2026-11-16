import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import { useToast } from "../components/Toast.jsx";
import { Button } from "../components/Button.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";

/** Plan comparison (PRD FR-9) + credit-pack breakdown + mock checkout. */
export function Pricing() {
  const { isAuthed, refreshCredits } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const billing = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.get("/v1/billing/credits"),
    enabled: isAuthed,
  });

  const checkout = useMutation({
    mutationFn: (payload) => api.post("/v1/billing/checkout", payload),
    onSuccess: (res) => {
      toast.success(`Checkout complete — +${res.credits_added} credits${res.new_plan ? ` · plan: ${res.new_plan}` : ""}`);
      qc.invalidateQueries({ queryKey: ["billing"] });
      refreshCredits();
    },
    onError: (err) => toast.error(err.message),
  });

  const plans = billing.data?.plans ?? [];
  const packs = billing.data?.packs ?? [
    { credits: 25, priceUsd: 19 },
    { credits: 100, priceUsd: 69 },
    { credits: 500, priceUsd: 299 },
  ];

  return (
    <div className="page page-narrow" style={{ maxWidth: 1100 }}>
      <h1>Simple, credit-based pricing</h1>
      <p className="muted">
        Every plan includes the full pipeline. Credits pay for generation: Idea Mode is <strong>4 credits</strong> per run,
        Reference Mode <strong>10 credits</strong>, and a single-section regeneration is <strong>0.25 credits</strong>.
      </p>

      {!billing.isLoading && plans.length === 0 ? (
        <div className="plans-grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <div className="plans-grid" style={{ marginTop: "var(--space-6)" }}>
          {plans.map((plan) => {
            const featured = plan.id === "pro";
            const featureLines = Array.isArray(plan.features)
              ? plan.features
              : [
                  (plan.monthlyCredits ?? plan.includedCredits ?? 0) + " credits / month",
                  (plan.concurrentRuns ?? plan.rateLimit ?? "—") +
                    (typeof plan.concurrentRuns === "number" ? " concurrent runs" : ""),
                ];
            return (
              <div key={plan.id} className={`card plan-card ${featured ? "featured" : ""}`}>
                {featured ? <span className="badge badge-brand plan-flag">Most popular</span> : null}
                <h3 style={{ marginBottom: 4 }}>{plan.label ?? plan.name ?? plan.id}</h3>
                <div className="plan-price">
                  {plan.priceUsd === 0 && plan.id === "enterprise" ? "Custom" : `$${plan.priceUsd}`}
                  {plan.id !== "enterprise" && <span> /month</span>}
                </div>
                <ul className="plan-features">
                  {featureLines.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <div className="grow" />
                {isAuthed ? (
                  plan.id === "enterprise" ? (
                    <Button variant="ghost" disabled title="Contact sales in production">Contact sales</Button>
                  ) : (
                    <Button
                      loading={checkout.isPending && checkout.variables?.plan === plan.id}
                      onClick={() => checkout.mutate({ kind: "plan", plan: plan.id })}
                    >
                      {plan.id === "free" ? "Current baseline" : `Switch to ${plan.label ?? plan.id}`}
                    </Button>
                  )
                ) : (
                  <Link to="/login" className="btn btn-primary">Start free</Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2>Top-up credit packs</h2>
        <p className="muted">One-time purchases that never expire. Perfect for bursty discovery sprints.</p>
        <div className="packs-row">
          {packs.map((pack) => (
            <div key={pack.credits} className="pack-chip">
              <div style={{ fontWeight: 700, fontSize: 18 }}>{pack.credits} credits</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>${pack.priceUsd ?? pack.price_usd} one-time</div>
              {isAuthed ? (
                <Button
                  size="sm"
                  loading={checkout.isPending && checkout.variables?.credits === pack.credits}
                  onClick={() => checkout.mutate({ kind: "pack", credits: pack.credits })}
                >
                  Buy pack
                </Button>
              ) : (
                <Link to="/login" className="btn btn-sm">Log in to buy</Link>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: "var(--space-8)" }}>
        <h3>How credits settle</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          Credits are reserved up-front when a run starts and settled per completed stage. Cancel mid-run and the unused
          reservation is released automatically — you only pay for what was produced.
        </p>
      </section>
    </div>
  );
}
