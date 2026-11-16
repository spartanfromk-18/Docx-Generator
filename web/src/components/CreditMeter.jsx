/** Credit balance meter — available (balance − reserved) with a reserved indicator. */
export function CreditMeter({ balance = 0, reserved = 0, compact = false }) {
  const available = Math.max(0, Math.round((balance - reserved) * 100) / 100);
  const pct = balance > 0 ? Math.min(100, Math.round((available / balance) * 100)) : 0;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  if (compact) {
    return (
      <span className="credit-meter-compact" title={`Balance ${fmt(balance)} · reserved ${fmt(reserved)}`}>
        <span aria-hidden="true">◆</span> {fmt(available)}
      </span>
    );
  }
  return (
    <div className="credit-meter" role="meter" aria-valuemin={0} aria-valuemax={balance} aria-valuenow={available} aria-label="Credits available">
      <div className="credit-meter-head">
        <span className="credit-meter-label">Credits</span>
        <span className="credit-meter-value">
          {fmt(available)}
          <span className="credit-meter-sub"> / {fmt(balance)}</span>
        </span>
      </div>
      <div className="credit-meter-track">
        <div className="credit-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {reserved > 0 ? <div className="credit-meter-reserved">{fmt(reserved)} reserved by running jobs</div> : null}
    </div>
  );
}
