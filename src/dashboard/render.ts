// Read-only owner dashboard, rendered server-side from D1. No framework, no
// external assets, no client JS beyond a meta-refresh. Every dynamic value
// is HTML-escaped: lead summaries and message bodies are caller/model text
// and must be treated as hostile.

import type { VerticalConfig } from "../config/schema";

export interface DashLead {
  created_at: number;
  caller_name: string | null;
  caller_phone: string;
  service: string | null;
  urgency: string;
  location: string | null;
  summary: string;
  status: string;
}

export interface DashConversation {
  id: string;
  caller_phone: string;
  status: string;
  urgency: string | null;
  scenario_id: string | null;
  last_message_at: number;
  message_count: number;
}

export interface DashNotification {
  created_at: number;
  body: string;
}

export interface DashMessage {
  direction: string;
  body: string;
  created_at: number;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #101418; color: #e8eaed; font: 15px/1.5 system-ui, sans-serif; padding: 24px; max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa4af; margin: 28px 0 10px; }
  .sub { color: #9aa4af; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: #9aa4af; font-weight: 500; font-size: 12px; padding: 6px 10px; border-bottom: 1px solid #2a3138; }
  td { padding: 8px 10px; border-bottom: 1px solid #1c2228; vertical-align: top; }
  tr:hover td { background: #161c22; }
  a { color: #7cc7d0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .b-emergency { background: #4a1519; color: #ff9d9d; }
  .b-urgent { background: #4a3a12; color: #ffd48a; }
  .b-routine, .b-none { background: #1e2830; color: #9fb3c0; }
  .b-escalated { background: #4a1519; color: #ff9d9d; }
  .b-qualified { background: #14351f; color: #8fd8a5; }
  .b-active { background: #1e2830; color: #9fb3c0; }
  .b-opted_out { background: #2a2a2a; color: #8a8a8a; }
  .b-new, .b-notified { background: #10303a; color: #7cc7d0; }
  .empty { color: #616a73; padding: 14px 10px; font-size: 14px; }
  .mono { font-variant-numeric: tabular-nums; white-space: nowrap; color: #9aa4af; font-size: 13px; }
  .msg { max-width: 72%; padding: 8px 12px; border-radius: 12px; margin: 6px 0; font-size: 14px; }
  .msg-inbound { background: #1e2830; margin-right: auto; }
  .msg-outbound { background: #0f3a40; margin-left: auto; }
  .msg time { display: block; font-size: 11px; color: #8a97a3; margin-top: 3px; }
  .thread { display: flex; flex-direction: column; }
  .summary-cell { max-width: 340px; }
`;

function page(title: string, businessName: string, body: string, refresh: boolean): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? '<meta http-equiv="refresh" content="60">' : ""}
<title>${escapeHtml(title)} — ${escapeHtml(businessName)}</title>
<style>${CSS}</style>
</head><body>
${body}
</body></html>`;
}

function badge(value: string | null | undefined): string {
  const v = value ?? "none";
  return `<span class="badge b-${escapeHtml(v)}">${escapeHtml(v)}</span>`;
}

function when(ms: number, timezone: string): string {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
  return `<span class="mono">${escapeHtml(s)}</span>`;
}

export function renderDashboard(
  config: VerticalConfig,
  leads: DashLead[],
  conversations: DashConversation[],
  notifications: DashNotification[]
): string {
  const tz = config.business.hours.timezone;
  const escalated = conversations.filter((c) => c.status === "escalated");

  const leadRows =
    leads.length === 0
      ? `<tr><td colspan="6" class="empty">No leads yet.</td></tr>`
      : leads
          .map(
            (l) => `<tr>
  <td>${when(l.created_at, tz)}</td>
  <td>${escapeHtml(l.caller_name ?? "")}<br><span class="mono">${escapeHtml(l.caller_phone)}</span></td>
  <td>${escapeHtml(l.service ?? "")}</td>
  <td>${badge(l.urgency)}</td>
  <td class="summary-cell">${escapeHtml(l.summary)}${l.location ? `<br><span class="mono">${escapeHtml(l.location)}</span>` : ""}</td>
  <td>${badge(l.status)}</td>
</tr>`
          )
          .join("");

  const convRows =
    conversations.length === 0
      ? `<tr><td colspan="5" class="empty">No conversations yet.</td></tr>`
      : conversations
          .map(
            (c) => `<tr>
  <td>${when(c.last_message_at, tz)}</td>
  <td><a href="/dashboard/c/${escapeHtml(c.id)}">${escapeHtml(c.caller_phone)}</a></td>
  <td>${badge(c.status)}${c.scenario_id ? ` <span class="mono">${escapeHtml(c.scenario_id)}</span>` : ""}</td>
  <td>${badge(c.urgency)}</td>
  <td class="mono">${c.message_count}</td>
</tr>`
          )
          .join("");

  const notifRows =
    notifications.length === 0
      ? `<tr><td colspan="2" class="empty">No owner alerts yet.</td></tr>`
      : notifications
          .map((n) => `<tr><td>${when(n.created_at, tz)}</td><td>${escapeHtml(n.body)}</td></tr>`)
          .join("");

  const body = `
<h1>${escapeHtml(config.business.name)}</h1>
<div class="sub">${escapeHtml(config.business.trade)} · ${escapeHtml(config.business.serviceArea)} · ${leads.length} lead${leads.length === 1 ? "" : "s"} · ${escalated.length} escalated · auto-refreshes every minute</div>

<h2>Leads</h2>
<table>
<tr><th>When</th><th>Caller</th><th>Service</th><th>Urgency</th><th>Summary</th><th>Status</th></tr>
${leadRows}
</table>

<h2>Conversations</h2>
<table>
<tr><th>Last activity</th><th>Caller</th><th>Status</th><th>Urgency</th><th>Msgs</th></tr>
${convRows}
</table>

<h2>Owner alerts</h2>
<table>
<tr><th>When</th><th>Alert</th></tr>
${notifRows}
</table>`;

  return page("Dashboard", config.business.name, body, true);
}

export function renderTranscript(
  config: VerticalConfig,
  conversation: DashConversation,
  messages: DashMessage[]
): string {
  const tz = config.business.hours.timezone;
  const thread =
    messages.length === 0
      ? `<div class="empty">No messages.</div>`
      : messages
          .map(
            (m) => `<div class="msg msg-${m.direction === "inbound" ? "inbound" : "outbound"}">
${escapeHtml(m.body)}
<time>${m.direction === "inbound" ? "caller" : "agent"} · ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(m.created_at))}</time>
</div>`
          )
          .join("");

  const body = `
<div class="sub"><a href="/dashboard">← dashboard</a></div>
<h1>${escapeHtml(conversation.caller_phone)}</h1>
<div class="sub">${badge(conversation.status)} ${badge(conversation.urgency)}${conversation.scenario_id ? ` <span class="mono">${escapeHtml(conversation.scenario_id)}</span>` : ""}</div>
<div class="thread">${thread}</div>`;

  return page(`Conversation ${conversation.caller_phone}`, config.business.name, body, false);
}
