// Clock used for policy decisions (quiet hours, business hours). Tests pin it
// with the TEST_FIXED_NOW binding (ISO 8601, set only by vitest.config.ts —
// production configs never define it) so time-dependent flows are
// deterministic. Record timestamps still use Date.now().

export function engineNow(env: Env): number {
  const fixed = (env as { TEST_FIXED_NOW?: string }).TEST_FIXED_NOW;
  return fixed ? Date.parse(fixed) : Date.now();
}
