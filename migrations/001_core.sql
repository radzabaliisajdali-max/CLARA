CREATE TABLE users (
 id uuid PRIMARY KEY, login text NOT NULL UNIQUE, name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('owner','operator')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE products (id uuid PRIMARY KEY, article text NOT NULL UNIQUE, name text NOT NULL, material text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE variants (
 id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES products(id), color text NOT NULL, size text NOT NULL,
 gtin text NOT NULL UNIQUE CHECK(gtin ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
 cost numeric(14,2) CHECK(cost >= 0), UNIQUE(product_id,color,size)
);
CREATE TABLE balances (
 variant_id uuid PRIMARY KEY REFERENCES variants(id), physical integer NOT NULL DEFAULT 0,
 reserved integer NOT NULL DEFAULT 0, transit integer NOT NULL DEFAULT 0, wb integer NOT NULL DEFAULT 0, defect integer NOT NULL DEFAULT 0,
 CHECK(physical >= 0 AND reserved >= 0 AND reserved <= physical AND transit >= 0 AND wb >= 0 AND defect >= 0)
);
CREATE TABLE documents (
 id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 kind text NOT NULL CHECK(kind IN ('receipt','adjustment','reserve','release','reversal')),
 reason text NOT NULL DEFAULT '', reference text NOT NULL DEFAULT '',
 reverses_id uuid UNIQUE REFERENCES documents(id), user_id uuid NOT NULL REFERENCES users(id),
 source text NOT NULL DEFAULT 'CLARA', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE movements (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id),
 variant_id uuid NOT NULL REFERENCES variants(id), physical integer NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0,
 transit integer NOT NULL DEFAULT 0, wb integer NOT NULL DEFAULT 0, defect integer NOT NULL DEFAULT 0,
 UNIQUE(document_id,variant_id), CHECK(physical <> 0 OR reserved <> 0 OR transit <> 0 OR wb <> 0 OR defect <> 0)
);
CREATE INDEX movements_variant ON movements(variant_id);
CREATE TABLE audit_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL,
 entity_id text NOT NULL, old_value jsonb, new_value jsonb, reason text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'CLARA', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency (
 user_id uuid NOT NULL REFERENCES users(id), key text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE FUNCTION prevent_history_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'History is immutable; create a compensating document'; END; $$;
CREATE TRIGGER immutable_movements BEFORE UPDATE OR DELETE ON movements FOR EACH ROW EXECUTE FUNCTION prevent_history_edit();
CREATE TRIGGER immutable_documents BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION prevent_history_edit();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION prevent_history_edit();
