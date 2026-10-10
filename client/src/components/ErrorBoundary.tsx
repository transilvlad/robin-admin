import { Component, type ErrorInfo, type ReactNode } from 'react';
import { recoverChunkLoad } from '../utils/chunkRecovery';
import { reportClientError } from '../utils/errorReporting';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (recoverChunkLoad(error)) return;
    console.error('Uncaught application error', error, info.componentStack);
    reportClientError(error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-robin-gray-900 p-6">
          <section className="card max-w-lg p-8 text-center" role="alert">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              Reload the page to restore the administration interface.
            </p>
            <button className="btn mt-6" type="button" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
