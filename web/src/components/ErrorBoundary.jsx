import { Component } from "react";

/** Per-route error boundary with a recover action. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <h2>Something went wrong</h2>
          <p className="muted">{String(this.state.error?.message ?? this.state.error)}</p>
          <div className="row gap-8">
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => (window.location.href = "/app")}>
              Back to dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
