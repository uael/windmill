-- Add up migration script here
DROP VIEW v2_completed_job;
DROP FUNCTION v2_completed_job_instead_of_update() CASCADE;
DROP FUNCTION v2_completed_job_instead_of_delete() CASCADE;
