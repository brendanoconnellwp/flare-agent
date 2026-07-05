// Wall-clock policy math in the business's own timezone (config-declared
// IANA zone): business hours (after-hours escalation expectations) and quiet
// hours (TCPA hygiene holds). Pure functions of (config, Date) so they are
// unit-testable; DST transitions can skew results by at most an hour, which
// is acceptable for both policies.

import type { VerticalConfig } from "../config/schema";

type Hours = VerticalConfig["business"]["hours"];
type QuietHours = VerticalConfig["policies"]["quietHours"];

const WEEKDAY: Record<string, keyof Hours["days"]> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

function localParts(timezone: string, at: Date): { weekday: string; hhmm: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return { weekday: get("weekday"), hhmm: `${get("hour")}:${get("minute")}`, minutes: hour * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinBusinessHours(hours: Hours, at: Date): boolean {
  const { weekday, hhmm } = localParts(hours.timezone, at);
  const day = WEEKDAY[weekday];
  const window = day ? hours.days[day] : null;
  if (!window) return false;

  // "HH:MM" strings compare correctly lexicographically.
  return hhmm >= window.open && hhmm < window.close;
}

// Quiet hours: the window (local wall clock) during which non-emergency
// outbound is held. Overnight windows (start > end, e.g. 21:00–08:00) wrap
// midnight; equal start/end means no quiet hours.
export function inQuietHours(quiet: QuietHours, timezone: string, at: Date): boolean {
  const t = localParts(timezone, at).minutes;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

// Milliseconds from `at` until the quiet window ends (local wall clock).
// Only meaningful while inQuietHours(...) is true.
export function msUntilQuietHoursEnd(quiet: QuietHours, timezone: string, at: Date): number {
  const t = localParts(timezone, at).minutes;
  const end = toMinutes(quiet.end);
  const minutesLeft = end > t ? end - t : 24 * 60 - t + end;
  return minutesLeft * 60_000;
}
