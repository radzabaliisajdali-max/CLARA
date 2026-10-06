CREATE TABLE wb_connection (
 id integer PRIMARY KEY CHECK (id=1),
 encrypted_token text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 user_id uuid NOT NULL REFERENCES users(id)
);

