// Keep deduplication aligned with the daily schedule's calendar, including
// delayed deliveries or retries that cross midnight in UTC.
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

export const digestDay = (date: Date): string => formatter.format(date);
