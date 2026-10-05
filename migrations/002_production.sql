ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK (kind IN ('receipt','adjustment','reserve','release','reversal','production'));
CREATE TABLE production_plans (
 id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 variant_id uuid NOT NULL REFERENCES variants(id), quantity integer NOT NULL CHECK(quantity>0),
 due_date date NOT NULL, comment text NOT NULL DEFAULT '', user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE production_cuts (
 id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE, plan_id uuid NOT NULL REFERENCES production_plans(id),
 quantity integer NOT NULL CHECK(quantity>0), cut_date date NOT NULL, fabric_kg numeric(14,3) NOT NULL CHECK(fabric_kg>0),
 reason text NOT NULL DEFAULT '', responsible text NOT NULL, comment text NOT NULL DEFAULT '',
 user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE production_workers (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE production_events (
 id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE, cut_id uuid NOT NULL REFERENCES production_cuts(id),
 from_stage text NOT NULL CHECK(from_stage IN ('cut','sewing','qc','packing')),
 to_stage text NOT NULL CHECK(to_stage IN ('sewing','qc','packing','ready','defect')),
 quantity integer NOT NULL CHECK(quantity>0), worker_id uuid REFERENCES production_workers(id),
 operation_date date NOT NULL, reason text NOT NULL DEFAULT '', document_id uuid UNIQUE REFERENCES documents(id),
 reverses_id uuid UNIQUE REFERENCES production_events(id), user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((from_stage='cut' AND to_stage='sewing') OR (from_stage='sewing' AND to_stage='qc') OR (from_stage='qc' AND to_stage IN ('packing','defect')) OR (from_stage='packing' AND to_stage='ready')),
 CHECK ((from_stage IN ('cut','sewing')) = (worker_id IS NOT NULL))
);
CREATE INDEX production_cuts_plan ON production_cuts(plan_id);
CREATE INDEX production_events_cut ON production_events(cut_id);
CREATE TRIGGER immutable_plans BEFORE UPDATE OR DELETE ON production_plans FOR EACH ROW EXECUTE FUNCTION prevent_history_edit();
CREATE TRIGGER immutable_cuts BEFORE UPDATE OR DELETE ON production_cuts FOR EACH ROW EXECUTE FUNCTION prevent_history_edit();
CREATE TRIGGER immutable_production_events BEFORE UPDATE OR DELETE ON production_events FOR EACH ROW EXECUTE FUNCTION prevent_history_edit();
