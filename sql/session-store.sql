CREATE TABLE IF NOT EXISTS np_sessions (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  principal text NOT NULL,
  state jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS np_sessions_expires_idx ON np_sessions(expires_at);
