// Owner dashboard: token gating, XSS escaping of hostile caller/model text,
// transcript rendering. DASHBOARD_TOKEN is set in vitest.config.ts.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN = "test-dashboard-token";

async function authedFetch(path: string): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    headers: { cookie: `dash=${TOKEN}` },
  });
}

describe("owner dashboard", () => {
  it("requires the token: 401 without, 403 wrong, cookie redirect with", async () => {
    expect((await SELF.fetch("https://example.com/dashboard")).status).toBe(401);
    expect((await SELF.fetch("https://example.com/dashboard?token=wrong")).status).toBe(403);

    const signin = await SELF.fetch(`https://example.com/dashboard?token=${TOKEN}`, { redirect: "manual" });
    expect(signin.status).toBe(302);
    expect(signin.headers.get("set-cookie")).toContain("HttpOnly");

    const page = await authedFetch("/dashboard");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("renders leads and escapes hostile content", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO conversations (id, caller_phone, status, started_at, last_message_at) VALUES ('conv_xss', '+15554440001', 'qualified', ?, ?)"
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO leads (id, conversation_id, caller_phone, caller_name, service, urgency, location, summary, status, created_at)
       VALUES ('lead_xss', 'conv_xss', '+15554440001', '<script>alert(1)</script>', 'drain cleaning / clog', 'routine', 'North Park', 'summary with <img src=x onerror=alert(2)> payload', 'new', ?)`
    )
      .bind(now)
      .run();

    const html = await (await authedFetch("/dashboard")).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("drain cleaning / clog");
  });

  it("renders a conversation transcript with escaped messages", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO conversations (id, caller_phone, status, started_at, last_message_at) VALUES ('conv_t', '+15554440002', 'active', ?, ?)"
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, direction, body, channel, created_at) VALUES
       ('m1', 'conv_t', 'inbound', 'my sink is <b>broken</b>', 'simulator', ?),
       ('m2', 'conv_t', 'outbound', 'What is the address?', 'simulator', ?)`
    )
      .bind(now, now + 1)
      .run();

    const res = await authedFetch("/dashboard/c/conv_t");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("my sink is &lt;b&gt;broken&lt;/b&gt;");
    expect(html).toContain("What is the address?");
    expect(html).toContain("+15554440002");

    expect((await authedFetch("/dashboard/c/does-not-exist")).status).toBe(404);
  });
});
