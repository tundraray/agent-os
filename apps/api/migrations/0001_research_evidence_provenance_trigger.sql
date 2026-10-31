-- Custom SQL migration file, put your code below! --
-- Provenance of evidence is immutable (design-runtime.md, Data Model): any UPDATE that changes it is rejected.
CREATE FUNCTION "app"."research_evidence_provenance_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provenance" IS DISTINCT FROM OLD."provenance" THEN
    RAISE EXCEPTION 'provenance of evidence % is immutable', OLD."evidence_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "research_evidence_provenance_immutable"
BEFORE UPDATE OF "provenance" ON "app"."research_evidence"
FOR EACH ROW EXECUTE FUNCTION "app"."research_evidence_provenance_immutable"();
