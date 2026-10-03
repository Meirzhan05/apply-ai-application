"use client";

import { useEffect, useState } from "react";
import type { ApplicationPacket, LatexResumeArtifact, Profile, ResumeArtifact, ResumeDraftDiagnostics, VerifiedFact } from "@/lib/types";

type SourceArtifact = Exclude<ResumeArtifact, LatexResumeArtifact>;
type SourceDocument = NonNullable<Profile["resumeSourceDocument"]>;
type Freshness = "checking" | "current" | "stale" | "unavailable";
type FreshnessState = { key: string; value: Freshness; reasons: string[] };

function isSourceArtifact(artifact: ResumeArtifact | undefined): artifact is SourceArtifact {
  return Boolean(artifact && artifact.format !== "latex" && "baseline" in artifact && "layoutValidation" in artifact);
}

function outcomeLabel(outcome: ResumeDraftDiagnostics["findings"][number]["outcome"]): string {
  switch (outcome) {
    case "supported": return "Supported";
    case "unsupported": return "Needs evidence";
    case "uncertain": return "Evidence is uncertain";
    case "contradiction": return "Conflicts with confirmed facts";
  }
}

function freshnessMessage(freshness: Freshness, reasons: string[] = []): string {
  switch (freshness) {
    case "checking": return "Checking whether this saved résumé matches the current source, facts, settings, and job…";
    case "current": return "This saved version matches the current résumé inputs and passed its layout and grounding checks.";
    case "stale": return `This saved version is from an earlier set of résumé inputs${reasons.length ? ` (${reasons.map(staleReasonLabel).join(", ")})` : ""}. Rebuild it from the current source and confirmed facts before comparing previews.`;
    case "unavailable": return "The saved comparison could not be verified. Preview links are disabled until the current version can be checked.";
  }
}

function staleReasonLabel(reason: string): string {
  switch (reason) {
    case "source": return "source changed";
    case "representation": return "source representation changed";
    case "profile": return "profile changed";
    case "facts": return "confirmed facts changed";
    case "settings": return "résumé settings changed";
    case "job": return "job details changed";
    default: return reason.replaceAll("_", " ");
  }
}

function pageCountLabel(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

export function hasSourcePreservingResume(packet: ApplicationPacket): boolean {
  const artifact = packet.resumeArtifact;
  return Boolean(packet.resumeSourcePlan && artifact && artifact.format !== "latex" && "baseline" in artifact && "layoutValidation" in artifact);
}

function sourceFormatName(format: string): string {
  return format.toUpperCase();
}

function producerLabel(artifact: SourceArtifact): string {
  const metadata = artifact as SourceArtifact & { renderer?: string; rendererVersion?: string; parser?: string; parserVersion?: string };
  if (metadata.rendererVersion && metadata.renderer) return `${metadata.renderer} · ${metadata.rendererVersion}`;
  if (metadata.parserVersion && metadata.parser) return `${metadata.parser} · ${metadata.parserVersion}`;
  if (metadata.parser) return metadata.parser;
  return "Source layout adapter";
}

export function ResumeSourceSupportNotice({ source }: { source: SourceDocument }) {
  const format = sourceFormatName(source.format);
  const pageCount = source.layout.pageCount;
  const columns = source.layout.columns;
  const fonts = "fontFamilies" in source.layout ? source.layout.fontFamilies : undefined;
  if (source.support.status === "blocked") {
    return <p className="muted" role="status">{format} layout is unsupported: {source.support.reason}</p>;
  }
  const details = [
    `${source.anchors.length} stable text anchors`,
    ...(pageCount ? [pageCountLabel(pageCount)] : []),
    ...(columns ? [`${columns} ${columns === 1 ? "column" : "columns"}`] : []),
    ...(fonts?.length ? [fonts.join(", ")] : []),
  ];
  return <p className="muted" role="status">{format} source captured with {details.join(" · ")}. Up to eight pages and two text columns per page are supported; DOCX page count is verified after rendering. Layout is checked before a tailored file is saved.</p>;
}

function anchorLabel(source: SourceDocument | undefined, anchorId: string): string | undefined {
  const anchor = source?.anchors.find((item) => item.id === anchorId);
  if (!anchor) return undefined;
  return [anchor.sectionHeading, anchor.entryHeading].filter(Boolean).join(" · ");
}

export function ResumeComparison({
  applicationId,
  profile,
  packet,
  diagnostics,
  latestError,
  onReviewProfile,
  jobFingerprint,
  onRebuildResume,
  rebuildDisabled = false,
}: {
  applicationId: string;
  profile: Profile;
  packet: ApplicationPacket;
  diagnostics?: ResumeDraftDiagnostics;
  latestError?: string;
  onReviewProfile?: () => void;
  jobFingerprint?: string;
  onRebuildResume?: () => void;
  rebuildDisabled?: boolean;
}) {
  const artifact = packet.resumeArtifact;
  const plan = packet.resumeSourcePlan;
  const source = profile.resumeSourceDocument;
  const fileBase = `/api/applications/${applicationId}/files`;
  const statusUrl = `${fileBase}/resume-comparison-status`;
  const requestKey = JSON.stringify([
    applicationId,
    artifact && "inputHash" in artifact ? artifact.inputHash : null,
    source?.format,
    source?.sourceHash,
    source?.version,
    profile.resumeSource?.sha256,
    profile.facts.map(({ id, text, verified, sourceAnchorId }) => [id, text, verified, sourceAnchorId]),
    profile.name,
    profile.email,
    profile.phone,
    profile.school,
    profile.graduationYear,
    profile.skills,
    profile.automationSettings,
    jobFingerprint,
  ]);
  const [freshnessState, setFreshnessState] = useState<FreshnessState>({ key: "", value: "checking", reasons: [] });
  const hasComparison = Boolean(plan && isSourceArtifact(artifact));

  useEffect(() => {
    if (!hasComparison) return;
    let active = true;
    fetch(statusUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("The saved comparison could not be verified.");
        return await response.json() as { stale?: boolean; staleReasons?: string[] };
      })
      .then((result) => {
        if (active) setFreshnessState({ key: requestKey, value: result.stale ? "stale" : "current", reasons: result.staleReasons ?? [] });
      })
      .catch(() => { if (active) setFreshnessState({ key: requestKey, value: "unavailable", reasons: [] }); });
    return () => { active = false; };
  }, [hasComparison, requestKey, statusUrl]);

  if (!plan || !isSourceArtifact(artifact)) {
    return <p className="muted">This packet has no validated source-preserving résumé comparison.</p>;
  }

  const freshness = freshnessState.key === requestKey ? freshnessState.value : "checking";
  const freshnessReasons = freshnessState.key === requestKey ? freshnessState.reasons : [];
  return <ResumeComparisonView applicationId={applicationId} profile={profile} artifact={artifact} plan={plan}
    diagnostics={diagnostics} latestError={latestError} onReviewProfile={onReviewProfile} onRebuildResume={onRebuildResume}
    rebuildDisabled={rebuildDisabled} freshness={freshness} freshnessReasons={freshnessReasons} />;
}

export function ResumeComparisonView({
  applicationId,
  profile,
  artifact,
  plan,
  diagnostics,
  latestError,
  onReviewProfile,
  onRebuildResume,
  rebuildDisabled,
  freshness,
  freshnessReasons = [],
}: {
  applicationId: string;
  profile: Profile;
  artifact: SourceArtifact;
  plan: NonNullable<ApplicationPacket["resumeSourcePlan"]>;
  diagnostics?: ResumeDraftDiagnostics;
  latestError?: string;
  onReviewProfile?: () => void;
  onRebuildResume?: () => void;
  rebuildDisabled?: boolean;
  freshness: Freshness;
  freshnessReasons?: string[];
}) {
  const source = profile.resumeSourceDocument;
  const sourceMatchesSaved = Boolean(source && source.format === plan.format && source.sourceHash === plan.sourceHash && source.version === plan.representationVersion);
  const factsById = new Map<string, VerifiedFact>(profile.facts.map((fact) => [fact.id, fact]));
  const fileBase = `/api/applications/${applicationId}/files`;
  const originalFormat = sourceFormatName(plan.format);
  const currentOriginalName = profile.resumeFileName;
  const currentOriginalMime = profile.resumeSource?.mimeType;
  const canDownloadOriginal = Boolean(source && source.format === plan.format && source.sourceHash === plan.sourceHash && source.version === plan.representationVersion &&
    currentOriginalName && currentOriginalMime && profile.resumeSource?.sha256 === plan.sourceHash);
  const canPreview = freshness === "current";
  const failingDiagnostics = diagnostics && diagnostics.outcome !== "grounded" ? diagnostics : undefined;
  const changedWording = plan.edits;
  const layout = sourceMatchesSaved ? source?.layout : undefined;
  const columns = layout && "columns" in layout ? layout.columns : undefined;
  const fonts = layout && "fontFamilies" in layout ? layout.fontFamilies : undefined;
  const visualDifference = "visualOutsideEditDifference" in artifact.layoutValidation ? artifact.layoutValidation.visualOutsideEditDifference : undefined;
  const validation = artifact.layoutValidation.outcome === "passed";

  return (
    <div className="resume-comparison">
      <p className={`resume-comparison-state ${freshness}`} role="status">{freshnessMessage(freshness, freshnessReasons)}</p>
      {failingDiagnostics && (
        <section className="resume-comparison-diagnostics" aria-label="Latest résumé preparation result">
          <h4>{failingDiagnostics.outcome === "needs_information" ? "Résumé needs more information" : "Résumé preparation could not be completed"}</h4>
          {failingDiagnostics.outcome === "technical_failure" && <p>{latestError || "The latest résumé preparation failed before it produced a new validated file."}</p>}
          {failingDiagnostics.findings.length > 0 && <ul>
            {failingDiagnostics.findings.map((finding) => (
              <li key={`${finding.claimId}:${finding.outcome}`}>
                <strong>{outcomeLabel(finding.outcome)}</strong>
                {anchorLabel(sourceMatchesSaved ? source : undefined, finding.claimId) && <span className="resume-change-context"> · {anchorLabel(sourceMatchesSaved ? source : undefined, finding.claimId)}</span>}
                <p className="resume-change-text">{finding.affectedText}</p>
                <p>{finding.reason}</p>
                {finding.requiredInformation && <p><strong>Needed:</strong> {finding.requiredInformation}</p>}
                {finding.evidenceFactIds.length > 0 && <details>
                  <summary>Confirmed facts checked</summary>
                  <ul>{finding.evidenceFactIds.map((factId) => <li key={factId}>{factsById.get(factId)?.text ?? "This fact is no longer in the current profile."}</li>)}</ul>
                </details>}
              </li>
            ))}
          </ul>}
          {failingDiagnostics.requiredInformation.length > 0 && <ul aria-label="Information needed">
            {failingDiagnostics.requiredInformation.map((item) => <li key={item}>{item}</li>)}
          </ul>}
          {failingDiagnostics.outcome === "needs_information" && onReviewProfile && <button className="text-button" type="button" onClick={onReviewProfile}>Review profile facts</button>}
          {failingDiagnostics.outcome === "technical_failure" && onRebuildResume && <button className="text-button" type="button" disabled={rebuildDisabled} onClick={onRebuildResume}>Retry résumé build</button>}
        </section>
      )}
      {source?.support.status === "blocked" && <p className="resume-comparison-diagnostics" role="alert">Current source layout is unsupported: {source.support.reason}{onReviewProfile && <> <button className="text-button" type="button" onClick={onReviewProfile}>Upload a supported résumé</button></>}</p>}
      {!sourceMatchesSaved && <p className="muted">The original source has changed since this version was prepared. Saved edits are not mapped onto the changed source.</p>}

      {canPreview ? <div className="resume-comparison-previews">
        <section className="resume-comparison-pane">
          <div className="resume-comparison-pane-heading">
            <div>
              <h4>Original résumé layout preview</h4>
              <p className="muted">Saved PDF preview from the uploaded {originalFormat} source{canDownloadOriginal && currentOriginalName ? ` · ${currentOriginalName}` : ""}.</p>
            </div>
            {canDownloadOriginal && <a className="text-button" href={`${fileBase}/resume-original?download=1`}>Download original {currentOriginalMime === "application/pdf" ? "PDF" : "DOCX"} ↓</a>}
          </div>
          <iframe className="resume-comparison-pdf" src={`${fileBase}/resume-original-preview#view=FitH`} title="Original résumé layout preview" />
          {!canDownloadOriginal && <p className="muted">The uploaded file is unavailable for download from this saved version.</p>}
        </section>
        <section className="resume-comparison-pane">
          <div className="resume-comparison-pane-heading">
            <div>
              <h4>Tailored résumé preview</h4>
              <p className="muted">The saved PDF used for this application packet.</p>
            </div>
            <a className="text-button" href={`${fileBase}/resume-tailored-preview?download=1`}>Download saved tailored PDF ↓</a>
          </div>
          <iframe className="resume-comparison-pdf" src={`${fileBase}/resume-tailored-preview#view=FitH`} title="Tailored résumé preview" />
        </section>
      </div> : <section className="resume-comparison-preview-disabled" aria-label="Résumé previews unavailable">
        <h4>{freshness === "stale" ? "Rebuild to compare current previews" : freshness === "checking" ? "Verifying saved previews" : "Preview verification unavailable"}</h4>
        <p>{freshness === "stale" ? "The saved PDFs are private and integrity-checked, but their source, facts, settings, or job may no longer match this application. Rebuild the résumé to refresh both previews." : freshness === "checking" ? "The original and tailored PDF previews will appear after the saved files are checked against the current application." : "The comparison check failed, so the saved preview files are hidden. Try again after refreshing the application."}</p>
        {freshness !== "checking" && onRebuildResume && <button className="text-button" type="button" disabled={rebuildDisabled} onClick={onRebuildResume}>Rebuild résumé</button>}
        {onReviewProfile && <button className="text-button" type="button" onClick={onReviewProfile}>Review résumé source and profile</button>}
      </section>}

      <details className="resume-comparison-changes" open={changedWording.length > 0}>
        <summary>Changed wording ({changedWording.length})</summary>
        {!sourceMatchesSaved ? <p className="muted">The original wording map is stale because its source file changed.</p> : changedWording.length === 0 ? <p className="muted">No wording changed in the saved version.</p> : (
          <ol>
            {changedWording.map((edit) => {
              const anchor = source?.anchors.find((item) => item.id === edit.anchorId);
              return <li key={edit.anchorId} data-anchor-id={edit.anchorId}>
                <strong>{anchorLabel(source, edit.anchorId) || "Résumé section"}</strong>
                {anchor && <p><span className="resume-change-label">Original wording</span>{anchor.text}</p>}
                <p><span className="resume-change-label">Tailored wording</span>{edit.text}</p>
                <details>
                  <summary>Confirmed profile facts ({edit.factIds.length})</summary>
                  <ul>{edit.factIds.map((factId) => <li key={factId}>{factsById.get(factId)?.text ?? "This fact is no longer in the current profile."}{factsById.get(factId)?.verified ? <small> · Confirmed profile fact</small> : <small> · No longer confirmed</small>}</li>)}</ul>
                </details>
              </li>;
            })}
          </ol>
        )}
      </details>

      <details className="resume-comparison-validation">
        <summary>Source and layout checks</summary>
        <dl>
          <div><dt>Source format</dt><dd>{originalFormat}</dd></div>
          <div><dt>Source representation</dt><dd>Version {plan.representationVersion} · SHA-256 {plan.sourceHash}</dd></div>
          <div><dt>Validated output</dt><dd>{pageCountLabel(artifact.pageCount)} · {validation ? "Layout check passed" : "Layout check unavailable"}</dd></div>
          <div><dt>Renderer or parser</dt><dd>{producerLabel(artifact)}</dd></div>
          {sourceMatchesSaved && layout?.pageCount && <div><dt>Original page count</dt><dd>{pageCountLabel(layout.pageCount)}</dd></div>}
          {columns !== undefined && <div><dt>Columns</dt><dd>{columns}</dd></div>}
          {fonts && fonts.length > 0 && <div><dt>Fonts</dt><dd>{fonts.join(", ")}</dd></div>}
          {visualDifference !== undefined && <div><dt>Visual change outside edited regions</dt><dd>{(visualDifference * 100).toFixed(3)}%</dd></div>}
          <div><dt>Grounding</dt><dd>{plan.grounding.findings.every((finding) => finding.outcome === "supported") ? "All saved claims passed the evidence check" : "The saved plan has unresolved evidence findings"}</dd></div>
        </dl>
      </details>
    </div>
  );
}
