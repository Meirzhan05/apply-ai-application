export const isDemo = () =>
  process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";
