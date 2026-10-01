// Use the confirmed date only. A year by itself cannot establish a season.
export function graduationSeasonOption(date: string, options: string[]): string | undefined {
  const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  const season = date.match(/\b(winter|spring|summer|fall|autumn)\s+(20\d{2})\b/i);
  let expected: string | undefined;
  if (season) expected = `${season[1].toLowerCase() === 'autumn' ? 'Fall' : season[1]} ${season[2]}`;
  else {
    const month = date.match(/\b(january|february|march|april|may|june|july|august|september|october|november)\s+(20\d{2})\b/i);
    if (month) {
      const term = /january|february/i.test(month[1]) ? 'Winter' : /march|april|may/i.test(month[1]) ? 'Spring' : /june|july|august/i.test(month[1]) ? 'Summer' : 'Fall';
      expected = `${term} ${month[2]}`;
    }
  }
  if (!expected) return undefined;
  const matches = options.filter(option => normalize(option) === normalize(expected!));
  return matches.length === 1 ? matches[0] : undefined;
}
