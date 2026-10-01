"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Monitor, MousePointer2 } from "lucide-react";
import type { Application } from "@/lib/types";

export function LiveBrowser({ application }: { application: Application }) {
  const [control, setControl] = useState(false);
  const history = useRef<HTMLOListElement>(null);
  const latestAction = application.browserActions?.at(-1)?.at;
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [latestAction]);
  const verifying = application.status === "awaiting_verification";
  const active = ["filling", "needs_user_action", "final_review", "approved_to_submit", "submitting", "awaiting_verification"].includes(application.status);
  if (!active || !application.browserLiveUrl) return null;
  const mayControl = ["needs_user_action", "final_review", "awaiting_verification"].includes(application.status);
  const interactive = mayControl && control;
  const labels: Record<string, string> = {
    filling: "Agent is filling the form", needs_user_action: "Waiting for your input",
    final_review: "Ready for your review", approved_to_submit: "Waiting for submission",
    submitting: "Submitting and checking confirmation",
    awaiting_verification: "Complete employer verification",
  };
  return (
    <section className="live-browser" aria-label="Agent browser">
      <header className="live-browser-header">
        <div><Monitor size={20} /><h3>Agent browser</h3></div>
        <span role="status">{labels[application.status]}</span>
      </header>
      <div className="live-browser-toolbar">
        <p>{verifying ? "Complete the CAPTCHA, then check the result above. Do not click Submit again." : interactive ? "You have control. When finished, refresh the form for review." : "Watch the agent’s actions here. Submission requires your final approval."}</p>
        <div className="action-row">
          {mayControl && <button type="button" className="outline-action" aria-pressed={interactive} onClick={() => setControl(!control)}>
            <MousePointer2 size={16} />{interactive ? "Return to watch mode" : "Take control"}
          </button>}
          <a className="text-button" href={application.browserLiveUrl} target="_blank" rel="noreferrer">Open browser window <ExternalLink size={15} /></a>
        </div>
      </div>
      <div className={`live-browser-screen ${interactive ? "interactive" : "watch-only"}`} inert={!interactive}>
        <iframe key={application.browserSessionId} src={application.browserLiveUrl}
          title="Live agent browser" tabIndex={interactive ? 0 : -1} allow="autoplay; clipboard-read; clipboard-write"
          referrerPolicy="no-referrer" />
      </div>
      <details className="browser-actions" open>
        <summary>Agent actions</summary>
        {application.browserActions?.length ? <ol ref={history} aria-label="Agent action history">
          {application.browserActions.map((action, index) => <li key={`${action.at}-${index}`}>
            <time dateTime={action.at}>{new Date(action.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <span>{action.label}</span>
          </li>)}
        </ol> : <p>Connecting to the application form…</p>}
      </details>
    </section>
  );
}
