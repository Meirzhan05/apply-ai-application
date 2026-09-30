import { describe, expect, it } from "vitest";
import { locationFit, type LocationFit } from "@/lib/location-fit";

describe("conservative required-location comparison", () => {
  const cases: Array<[string, string[], LocationFit]> = [
    ["New York, NY", ["NYC"], "compatible"],
    ["NYC", ["New York City"], "compatible"],
    ["New York, New York, USA", ["N.Y.C."], "compatible"],
    ["San Francisco, California, United States", ["SF"], "compatible"],
    ["San Francisco, CA", ["California"], "compatible"],
    ["Portland, OR", ["OR"], "compatible"],
    ["Washington, DC", ["Washington D.C."], "compatible"],
    ["Boston, MA", ["New York"], "conflict"],
    ["Los Angeles, CA", ["SF"], "conflict"],
    ["New York, NY; San Francisco, CA", ["SF"], "compatible"],
    ["New York, NY; Boston, MA", ["SF"], "conflict"],
    ["Boston, MA; Unknown", ["SF"], "unknown"],
    ["Boston, MA", ["SF", "San Francisco Bay Area"], "unknown"],
    ["California", ["SF"], "unknown"],
    ["New York", ["NYC"], "unknown"],
    ["New York metro area", ["NYC"], "unknown"],
    ["Location not listed", ["NYC"], "unknown"],
    ["Cambridge", ["NYC"], "unknown"],
    ["Toronto, Canada", ["NYC"], "unknown"],
    ["NYC, CA", ["NYC"], "unknown"],
    ["New York, NY", ["York"], "unknown"],
    ["Los Angeles, CA", ["LA"], "unknown"],
  ];
  it.each(cases)("%s against %j is %s", (location, preferences, expected) => {
    expect(locationFit(location, preferences)).toBe(expected);
  });
});
