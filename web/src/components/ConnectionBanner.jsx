/** Reconnect banner for the SSE stream — role="status" so SRs announce it once. */
export function ConnectionBanner({ reconnecting, connected }) {
  if (reconnecting) {
    return (
      <div className="conn-banner conn-warning" role="status">
        <span className="conn-dot conn-dot-warn" aria-hidden="true" />
        Live connection lost — reconnecting… events resume exactly where you left off.
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="conn-banner conn-muted" role="status">
        <span className="conn-dot" aria-hidden="true" />
        Live updates paused for this run.
      </div>
    );
  }
  return null;
}
