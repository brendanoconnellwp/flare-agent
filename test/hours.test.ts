// Pure wall-clock policy math. Dates are fixed UTC instants; assertions are
// about their wall-clock time in America/Los_Angeles (PDT, UTC-7 in July).

import { describe, expect, it } from "vitest";
import { inQuietHours, isWithinBusinessHours, msUntilQuietHoursEnd } from "../src/engine/hours";
import plumbing from "../verticals/plumbing.json";

const TZ = "America/Los_Angeles";
const QUIET = { start: "21:00", end: "08:00" }; // overnight window
const HOURS = plumbing.business.hours as Parameters<typeof isWithinBusinessHours>[0];

describe("quiet hours (overnight window 21:00–08:00)", () => {
  it("is quiet late at night", () => {
    // 2026-07-01T05:30:00Z = Jun 30, 22:30 PDT
    expect(inQuietHours(QUIET, TZ, new Date("2026-07-01T05:30:00Z"))).toBe(true);
  });

  it("is quiet in the early morning", () => {
    // 2026-07-01T14:00:00Z = 07:00 PDT
    expect(inQuietHours(QUIET, TZ, new Date("2026-07-01T14:00:00Z"))).toBe(true);
  });

  it("is not quiet at midday", () => {
    // 2026-07-01T19:00:00Z = 12:00 PDT (the pinned test clock)
    expect(inQuietHours(QUIET, TZ, new Date("2026-07-01T19:00:00Z"))).toBe(false);
  });

  it("is not quiet at the window edges' open side", () => {
    // 15:00:00Z = 08:00 PDT — the window ends AT end (exclusive)
    expect(inQuietHours(QUIET, TZ, new Date("2026-07-01T15:00:00Z"))).toBe(false);
    // 04:00:00Z = 21:00 PDT — the window starts AT start (inclusive)
    expect(inQuietHours(QUIET, TZ, new Date("2026-07-02T04:00:00Z"))).toBe(true);
  });

  it("a zero-length window means no quiet hours", () => {
    expect(inQuietHours({ start: "00:00", end: "00:00" }, TZ, new Date("2026-07-01T09:00:00Z"))).toBe(false);
  });

  it("computes time remaining until the window ends, across midnight", () => {
    // 22:30 PDT → 08:00 PDT next day = 9.5 hours
    expect(msUntilQuietHoursEnd(QUIET, TZ, new Date("2026-07-01T05:30:00Z"))).toBe(9.5 * 60 * 60_000);
    // 07:00 PDT → 08:00 PDT = 1 hour
    expect(msUntilQuietHoursEnd(QUIET, TZ, new Date("2026-07-01T14:00:00Z"))).toBe(60 * 60_000);
  });
});

describe("business hours", () => {
  it("open on a weekday midday", () => {
    // Wed 2026-07-01, 12:00 PDT — plumbing config: Wed 07:00–18:00
    expect(isWithinBusinessHours(HOURS, new Date("2026-07-01T19:00:00Z"))).toBe(true);
  });

  it("closed late evening", () => {
    // Wed 2026-07-01, 20:00 PDT
    expect(isWithinBusinessHours(HOURS, new Date("2026-07-02T03:00:00Z"))).toBe(false);
  });

  it("closed on sundays (null day)", () => {
    // Sun 2026-07-05, 12:00 PDT
    expect(isWithinBusinessHours(HOURS, new Date("2026-07-05T19:00:00Z"))).toBe(false);
  });
});
