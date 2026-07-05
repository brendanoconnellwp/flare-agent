// {placeholder} interpolation for config-authored templates (firstMessage,
// ownerTemplate). Unknown placeholders are left intact so a config typo shows
// up in output instead of vanishing silently.

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}
