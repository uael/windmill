-- Add down migration script here
DROP TABLE IF EXISTS app_version_lite;
DROP TABLE IF EXISTS app_script;
DROP INDEX IF EXISTS app_script_hash;
