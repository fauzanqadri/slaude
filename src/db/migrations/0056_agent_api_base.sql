-- Agent host API (/agent/v1), base tables.
-- agent_idempotency: the first response to a create call, keyed by the client and
-- its Idempotency-Key, so a repeat returns it and a different body under the same
-- key is refused. Rows older than the retention window are purged.
CREATE TABLE IF NOT EXISTS agent_idempotency (
  tenant_id    TEXT    NOT NULL DEFAULT 'default',
  client       TEXT    NOT NULL,
  idem_key     TEXT    NOT NULL,
  route        TEXT    NOT NULL,
  request_hash TEXT    NOT NULL,
  status       INTEGER NOT NULL,
  response     TEXT    NOT NULL,
  resource_id  TEXT,
  created_at   BIGINT  NOT NULL,
  PRIMARY KEY (client, idem_key)
);
CREATE INDEX IF NOT EXISTS agent_idempotency_created_idx ON agent_idempotency (created_at);

-- agent_conversations: a persona, a channel and an optional thread, bound by a
-- client. A client sees only its own conversations.
CREATE TABLE IF NOT EXISTS agent_conversations (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  id         TEXT   PRIMARY KEY,
  client     TEXT   NOT NULL,
  persona    TEXT   NOT NULL,
  channel    TEXT   NOT NULL,
  thread_ts  TEXT,
  title      TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_conversations_client_idx ON agent_conversations (client, created_at);
