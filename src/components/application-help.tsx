"use client";

import { useState } from "react";

const topics = [
  { title: "Review and approve materials", text: "Check the resume claims and their source facts, inspect the PDF layout, then review screening answers. The task links take you to anything unfinished. Approving materials permits the agent to fill the employer form. You review that form separately before authorizing submission." },
  { title: "Edit or confirm an essay", text: "AI essays use confirmed profile facts or truthful general wording. Use Edit wording to make a revision, save it, and confirm the exact wording. The original draft and its source facts remain available. Changing an essay requires fresh confirmation." },
  { title: "Answer personal or consent questions", text: "Enter these answers yourself. The agent does not infer work authorization, sponsorship, identity, or consent. Save your answers before confirming essays or approving materials. These application answers do not become reusable resume facts." },
  { title: "Correct a resume claim", text: "Open its source facts and choose Correct or unconfirm. This updates your reusable profile. Confirm only accurate facts, save, then rebuild the application materials from the updated facts. Review the new resume and essays before approving." },
  { title: "Continue an expired browser session", text: "Your saved materials remain available when a browser session ends. Review them for a new session and approve another form fill. Restarting does not submit the application. If submission has an uncertain result, check the saved result before trying anything again." },
  { title: "Approve and submit the final form", text: "Inspect the actual employer fields, attachments, and destination. Approve for submission records permission for that exact form; it does not submit yet. Submit application once performs the submission. Changed forms need a new review. Cancel application stops an attempt that has not been submitted." },
  { title: "Move between applications", text: "Search by employer or role, or choose Needs your review to focus on unfinished work. Outside a text field or dialog, press / to search, j for the next application, k for the previous one, or ? to open this help. Save, discard, or stay when leaving an edit; saved answers stay with their application." },
];

export function ApplicationHelp() {
  const [search, setSearch] = useState("");
  const matches = topics.filter(topic => `${topic.title} ${topic.text}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <details className="application-help" id="applications-help">
    <summary>Review help and shortcuts</summary>
    <div className="application-help-content">
      <label htmlFor="application-help-search">Find help for a task</label>
      <input id="application-help-search" type="search" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="Try sources, consent, or submission" />
      <p role="status">{matches.length} {matches.length === 1 ? "topic" : "topics"}</p>
      {matches.length ? matches.map(topic => <details key={topic.title}><summary>{topic.title}</summary><p>{topic.text}</p></details>) : <p>No matching topic. <button className="text-button" type="button" onClick={() => setSearch("")}>Show all help</button></p>}
    </div>
  </details>;
}
