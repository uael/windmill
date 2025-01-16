-- Add down migration script here
DROP VIEW v2_queue;
DROP FUNCTION v2_queue_instead_of_update() CASCADE;
DROP FUNCTION v2_queue_instead_of_delete() CASCADE;
