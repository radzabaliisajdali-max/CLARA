CREATE TABLE wb_snapshots (
 cache_key text PRIMARY KEY, payload jsonb NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(), user_id uuid NOT NULL REFERENCES users(id)
);
CREATE TABLE wb_request_limits (endpoint text PRIMARY KEY, next_at timestamptz NOT NULL);
