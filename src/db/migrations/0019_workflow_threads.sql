-- Ticket workflows (factory framework): one run per thread, its starter and the
-- participants who may approve its stages. The lifecycle itself lives in Temporal.
CREATE TABLE IF NOT EXISTS workflow_threads (
  tenant_id       TEXT   NOT NULL DEFAULT 'default',
  channel_id      TEXT   NOT NULL,
  thread_ts       TEXT   NOT NULL,
  session_id      TEXT   NOT NULL,
  run_id          TEXT   NOT NULL,
  pipeline        TEXT   NOT NULL,
  ticket_ref      TEXT,
  starter_user_id TEXT   NOT NULL,
  stage           TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  status          TEXT   NOT NULL DEFAULT 'running',
  last_request_id TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_threads_run ON workflow_threads (run_id);

CREATE TABLE IF NOT EXISTS workflow_participants (
  tenant_id  TEXT   NOT NULL DEFAULT 'default',
  channel_id TEXT   NOT NULL,
  thread_ts  TEXT   NOT NULL,
  user_id    TEXT   NOT NULL,
  added_by   TEXT   NOT NULL,
  added_at   BIGINT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts, user_id)
);
