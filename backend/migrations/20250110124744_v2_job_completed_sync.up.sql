-- Add up migration script here

-- On every insert to `v2_job_completed`, insert to `v2_job` as well
-- This trigger will be removed once all server(s)/worker(s) are updated to use `v2_*` tables
CREATE OR REPLACE FUNCTION v2_job_completed_before_insert()
RETURNS TRIGGER AS $$
BEGIN
    NEW.completed_at := now();
    NEW.status := CASE
        WHEN NEW.__is_skipped THEN 'skipped'::job_status
        WHEN NEW.__canceled THEN 'canceled'::job_status
        WHEN NEW.__success THEN 'success'::job_status
        ELSE 'failure'::job_status
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER v2_job_completed_before_insert_trigger
BEFORE INSERT ON v2_job_completed
FOR EACH ROW
WHEN (pg_trigger_depth() < 1) -- Prevent infinite loop v1 <-> v2
EXECUTE FUNCTION v2_job_completed_before_insert();
