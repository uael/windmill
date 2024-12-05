-- Add up migration script here
DELETE FROM flow_version_lite;
DELETE FROM flow_node;

DROP INDEX IF EXISTS flow_node_hash;

ALTER TABLE flow_node DROP COLUMN hash;
ALTER TABLE flow_node ADD COLUMN hash CHAR(64) NOT NULL UNIQUE; -- sha256 of `workspace_id`, `path`, `lock`, `code`, `flow`.