import type { FactualDeclaration, OnboardingQuestionnaire } from "@/lib/types";

export function ImmigrationQuestionnaireFields({ questionnaire, onChange }: {
  questionnaire: OnboardingQuestionnaire;
  onChange: (questionnaire: OnboardingQuestionnaire) => void;
}) {
  const patch = (values: Partial<OnboardingQuestionnaire>) => onChange({ ...questionnaire, ...values });
  return <>
    <label>
      US Immigration Status
      <select id="setup-immigrationStatus" value={questionnaire.immigrationStatus ?? ""} onChange={event => {
        const immigrationStatus = event.target.value as OnboardingQuestionnaire["immigrationStatus"];
        onChange({ ...questionnaire, immigrationStatus, visaType: immigrationStatus === "visa-holder" ? questionnaire.visaType : undefined, immigrationStatusDetails: immigrationStatus === "other" ? questionnaire.immigrationStatusDetails : undefined });
      }}>
        <option value="" disabled>Choose a status</option>
        <option value="us-citizen">US citizen</option>
        <option value="permanent-resident">Permanent resident</option>
        <option value="visa-holder">Visa holder</option>
        <option value="other">Another status</option>
      </select>
    </label>
    {questionnaire.immigrationStatus === "visa-holder" && <label>
      Visa Type
      <input id="setup-visaType" required maxLength={200} value={questionnaire.visaType ?? ""} onChange={event => patch({ visaType: event.target.value })} />
    </label>}
    {questionnaire.immigrationStatus === "other" && <label>
      US Immigration Status details
      <input id="setup-immigrationStatusDetails" required maxLength={500} value={questionnaire.immigrationStatusDetails ?? ""} onChange={event => patch({ immigrationStatusDetails: event.target.value })} />
    </label>}
    {([
      ["workAuthorization", "Are you currently authorized to work in the United States?"],
      ["sponsorshipNow", "Do you need employer sponsorship now?"],
      ["sponsorshipFuture", "Will you need employer sponsorship in the future?"],
    ] as const).map(([key, label]) => <label key={key}>
      {label}
      <select id={`setup-${key}`} value={questionnaire[key] ?? ""} onChange={event => patch({ [key]: event.target.value as FactualDeclaration })}>
        <option value="" disabled>Choose an answer</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
        <option value="unknown">I am not sure yet</option>
      </select>
    </label>)}
  </>;
}
