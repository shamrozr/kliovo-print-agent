import { describe, it, expect } from "vitest";
import {
  isKotSuppressed,
  ownAddonsOnStation,
  printsItemAtStation,
  readKotRouting,
  ridingModifiers,
  stationsOnLine,
} from "./kot-plan";

const line = (plan: unknown, extra: Record<string, unknown> = {}) => ({
  kot_routing: plan === null ? null : JSON.stringify(plan),
  ...extra,
});

describe("kot-plan — frozen per-line routing", () => {
  it("fans a two-station line out to both stations", () => {
    const it = line({ item: ["hot", "bar"], addons: [] });
    expect(stationsOnLine(it)).toEqual(["hot", "bar"]);
    expect(printsItemAtStation(it, "hot")).toBe(true);
    expect(printsItemAtStation(it, "bar")).toBe(true);
    expect(printsItemAtStation(it, "dessert")).toBe(false);
  });

  it("suppressed lines print nowhere — catch-all included", () => {
    const it = line({ item: [], addons: [], suppressed: true });
    expect(isKotSuppressed(it)).toBe(true);
    expect(printsItemAtStation(it, null)).toBe(false);
    expect(printsItemAtStation(it, "hot")).toBe(false);
  });

  it("an add-on cannot smuggle a suppressed item onto a slip", () => {
    const it = line({ item: [], addons: [{ name: "Extra Cheese", stations: ["pizza"] }], suppressed: true });
    expect(ownAddonsOnStation(it, "pizza")).toEqual([]);
  });

  it("an unrouted line lands on the catch-all, not on a station", () => {
    const it = line({ item: [], addons: [] });
    expect(printsItemAtStation(it, null)).toBe(true);
    expect(printsItemAtStation(it, "hot")).toBe(false);
  });

  it("an own-line add-on reaches its own station and leaves the parent's sub-list", () => {
    const it = line({ item: ["fryer"], addons: [{ name: "Extra Cheese", stations: ["pizza"] }] });
    expect(stationsOnLine(it)).toEqual(["fryer", "pizza"]);
    expect(ownAddonsOnStation(it, "pizza")).toEqual(["Extra Cheese"]);
    expect(ownAddonsOnStation(it, "fryer")).toEqual([]);
    // stripped everywhere, so it is never both a sub-line and a line of its own
    expect(ridingModifiers(it, [{ name: "Extra Cheese" }, { name: "No Onion" }])).toEqual([{ name: "No Onion" }]);
  });

  it("the catch-all slip carries no add-on lines", () => {
    const it = line({ item: [], addons: [{ name: "Extra Cheese", stations: ["pizza"] }] });
    expect(ownAddonsOnStation(it, null)).toEqual([]);
  });

  it("falls back to the legacy single station when no plan was frozen", () => {
    const it = line(null, { station_id: "hot" });
    expect(readKotRouting(it)).toEqual({ item: ["hot"], addons: [] });
    expect(stationsOnLine(it)).toEqual(["hot"]);
    expect(printsItemAtStation(it, "hot")).toBe(true);
  });

  it("prefers station_ids over the station_id mirror", () => {
    const it = line(null, { station_id: "hot", station_ids: JSON.stringify(["hot", "bar"]) });
    expect(stationsOnLine(it)).toEqual(["hot", "bar"]);
  });

  it("a corrupt plan degrades to the legacy read, never to no ticket", () => {
    const it = { kot_routing: "{not json", station_id: "hot" };
    expect(stationsOnLine(it)).toEqual(["hot"]);
    expect(isKotSuppressed(it)).toBe(false);
  });
});
