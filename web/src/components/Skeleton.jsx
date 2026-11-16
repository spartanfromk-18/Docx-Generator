export function Skeleton({ width = "100%", height = 14, radius = 6, style, ...rest }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" {...rest} />;
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <Skeleton width="38%" height={18} />
      <Skeleton width="86%" />
      <Skeleton width="72%" />
      <Skeleton width="80%" />
    </div>
  );
}
