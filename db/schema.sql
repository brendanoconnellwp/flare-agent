-- db/schema.sql — single-tenant per deployment (one business per Worker/D1)

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,            -- ulid
  caller_phone  TEXT NOT NULL,               -- E.164
  status        TEXT NOT NULL DEFAULT 'active',
                -- active | qualified | escalated | opted_out | abandoned | closed
  urgency       TEXT,                        -- emergency | urgent | routine | unknown
  scenario_id   TEXT,                        -- matched emergency scenario, if any
  started_at    INTEGER NOT NULL,            -- unix ms
  last_message_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(caller_phone);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,          -- ulid
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  direction       TEXT NOT NULL,             -- inbound | outbound | system
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,             -- twilio | simulator
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS leads (
  id              TEXT PRIMARY KEY,          -- ulid
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  caller_phone    TEXT NOT NULL,
  caller_name     TEXT,
  service         TEXT,                      -- matched from config services taxonomy
  urgency         TEXT NOT NULL,             -- emergency | urgent | routine
  location        TEXT,
  summary         TEXT NOT NULL,             -- agent-written 1-2 sentence summary
  status          TEXT NOT NULL DEFAULT 'new',
                  -- new | notified | contacted | booked | lost
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at);

-- Opt-outs are compliance data: persisted forever, checked before every outbound.
CREATE TABLE IF NOT EXISTS opt_outs (
  phone      TEXT PRIMARY KEY,               -- E.164
  created_at INTEGER NOT NULL
);

-- Outbound owner notifications (escalation alerts, lead alerts, failure
-- pings): the audit trail of every time we tried to reach the owner.
-- Written at notify time; M4 adds the Twilio delivery on top.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,               -- ulid
  to_phone   TEXT NOT NULL,                  -- E.164
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Raw inbound webhook payloads: production fixtures for local replay.
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,               -- ulid
  source     TEXT NOT NULL,                  -- {twilio|simulator}_{sms|voice_status} | simulator_missed_call
  payload    TEXT NOT NULL,                  -- raw JSON
  created_at INTEGER NOT NULL
);
