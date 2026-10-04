// Residence questions must never reuse preferred job destinations or office choices.
export function savedLocationAnswerKey(question: string): string | undefined {
  const label = question.toLowerCase().trim().replace(/\s+/g, " ");
  if (/^(?:are you |would you be )?(?:willing|open) to relocat(?:e|ion)\??$/.test(label)) return "willingToRelocate";
  if (/availability|available.*start|start.*date|earliest.*start/.test(label)) return "availability";
  if (/^(?:current |residence |residential )city\??$|^city (?:of residence|where you (?:currently )?live)\??$/.test(label)) return "currentCity";
  if (/^(?:current |residence |residential )(?:state|region|state or region|state\/province)\??$|^(?:state|region|state or region) of residence\??$/.test(label)) return "currentRegion";
  if (/^(?:current |residence |residential )country\??$|^country (?:of residence|where you (?:currently )?live)\??$/.test(label)) return "currentCountry";
  if (/^(?:current |residential )location\??$|^where do you (?:currently )?live\??$/.test(label)) return "currentLocation";
  return undefined;
}
