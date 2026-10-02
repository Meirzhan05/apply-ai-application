/** Server-side operator allowlist shared by owner, cost, usage, and pilot routes. */
export function isConfiguredOperator(userId: string): boolean {
  return (process.env.USAGE_OPERATOR_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}
