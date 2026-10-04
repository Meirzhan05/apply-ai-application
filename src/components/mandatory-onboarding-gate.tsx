"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

type GateState = "loading" | "allowed" | "blocked" | "error";

/**
 * Protects secondary authenticated pages while the server-side action policy
 * remains the authoritative guard for work that can spend money or prepare an
 * application. The demo flag comes from the server, never from Profile.demo.
 */
export function MandatoryOnboardingGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<GateState>("loading");

  useEffect(() => {
    let active = true;
    fetch("/api/state", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Workspace unavailable.");
        if (!active) return;
        if (body.demoMode !== true && body.onboarding?.complete !== true) {
          setState("blocked");
          router.replace(`/onboarding?returnTo=${encodeURIComponent(pathname)}`);
          return;
        }
        setState("allowed");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [pathname, router]);

  if (state !== "allowed") return null;
  return children;
}
