"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      let isFirestorePermissionError = false;
      let errorMessage = this.state.error?.message || "An unexpected error occurred.";
      
      try {
        if (errorMessage.includes("FirestoreErrorInfo") || errorMessage.includes("Missing or insufficient permissions")) {
          isFirestorePermissionError = true;
          const parsedError = JSON.parse(errorMessage);
          errorMessage = parsedError.error || errorMessage;
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-stone-50 p-6">
          <div className="bg-white border border-stone-200 rounded-2xl p-8 max-w-md w-full shadow-sm text-center">
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6 text-red-600" />
            </div>
            <h2 className="text-lg font-semibold text-stone-800 mb-2">Something went wrong</h2>
            <p className="text-sm text-stone-600 mb-6">
              {isFirestorePermissionError 
                ? "You do not have permission to access this data. Please check your account or contact support."
                : errorMessage}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
