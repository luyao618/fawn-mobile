import { Component, type ErrorInfo, type PropsWithChildren } from "react";

import { BootstrapError } from "../ui/BootstrapError";

type State = { failed: boolean };

export class AppErrorBoundary extends Component<PropsWithChildren, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Slice 1 intentionally keeps render failures local and performs no upload.
  }

  private retry = () => this.setState({ failed: false });

  render() {
    if (this.state.failed) return <BootstrapError action={{ label: "重试显示页面", onPress: this.retry }} />;
    return this.props.children;
  }
}
