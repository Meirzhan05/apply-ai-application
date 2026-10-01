export interface ResumeAuditClaim {
  claimId: string;
  factIds: string[];
}

export interface ResumeAuditOverride {
  claimId: string;
  outcome?: "supported" | "unsupported" | "uncertain" | "contradiction";
  reason?: string;
  evidenceFactIds?: string[];
  requiredInformation?: string | null;
}

export function resumeGroundingOutput(
  claims: ResumeAuditClaim[],
  overrides: ResumeAuditOverride[] = [],
  defaultReason = "The confirmed source fact supports this claim.",
) {
  const overrideByClaimId = new Map(overrides.map((override) => [override.claimId, override]));
  return {
    findings: claims.map((claim) => {
      const override = overrideByClaimId.get(claim.claimId);
      return {
        claimId: claim.claimId,
        outcome: override?.outcome ?? "supported",
        reason: override?.reason ?? defaultReason,
        evidenceFactIds: override?.evidenceFactIds ?? claim.factIds,
        requiredInformation: override?.requiredInformation ?? null,
      };
    }),
  };
}
