-- /sandbox: threads whose shell and file tools run on the sandbox MCP server
-- (SLAUDE_SANDBOX_MCP_URL). A row means on; /sandbox off deletes it.
CREATE TABLE IF NOT EXISTS sandbox_threads (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  channel_id TEXT   NOT NULL,
  thread_ts  TEXT   NOT NULL,
  created_by TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
