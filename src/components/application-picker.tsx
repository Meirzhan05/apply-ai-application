import { applicationStages, type ApplicationStage } from "@/lib/application-stage";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function ApplicationPicker({ options, selected, blocked, onSelect }: {
  options: Array<{ id: string; label: string; stage: ApplicationStage }>; selected: string; blocked: boolean; onSelect: (id: string) => void;
}) {
  const index = options.findIndex(option => option.id === selected);
  if (!options.length) return null;
  return <div className="application-picker">
    <p className="application-position">Application {index + 1} of {options.length}</p>
    <div className="application-picker-controls">
        <button type="button" aria-label="Previous application" disabled={blocked || index <= 0} onClick={() => onSelect(options[index - 1].id)}><ChevronLeft size={18} /></button>
        <label className="sr-only" htmlFor="application-choice">Choose application</label>
        <select id="application-choice" value={selected} disabled={blocked} onChange={event => onSelect(event.target.value)}>
          {applicationStages.filter(stage => options.some(option => option.stage === stage)).map(stage => <optgroup key={stage} label={stage}>{options.filter(option => option.stage === stage).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup>)}
        </select>
        <button type="button" aria-label="Next application" disabled={blocked || index >= options.length - 1} onClick={() => onSelect(options[index + 1].id)}><ChevronRight size={18} /></button>
    </div>
  </div>;
}
