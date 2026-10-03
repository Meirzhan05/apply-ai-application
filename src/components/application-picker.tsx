import { ChevronLeft, ChevronRight } from "lucide-react";

export function ApplicationPicker({ options, selected, blocked, onSelect }: {
  options: Array<{ id: string; label: string }>; selected: string; blocked: boolean; onSelect: (id: string) => void;
}) {
  const index = options.findIndex(option => option.id === selected);
  return <div className="application-picker">
    <div className="application-picker-heading">
      <span>Application {index + 1} of {options.length}</span>
      <div>
        <button type="button" aria-label="Previous application" disabled={blocked || index <= 0} onClick={() => onSelect(options[index - 1].id)}><ChevronLeft size={18} /></button>
        <button type="button" aria-label="Next application" disabled={blocked || index >= options.length - 1} onClick={() => onSelect(options[index + 1].id)}><ChevronRight size={18} /></button>
      </div>
    </div>
    <label htmlFor="application-choice">Choose application</label>
    <select id="application-choice" value={selected} disabled={blocked} onChange={event => onSelect(event.target.value)}>
      {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  </div>;
}
