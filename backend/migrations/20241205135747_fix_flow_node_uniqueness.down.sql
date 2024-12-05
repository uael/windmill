-- Add down migration script here
DELETE FROM flow_version_lite;
DELETE FROM flow_node;

CREATE INDEX flow_node_hash ON flow_node(hash);

ALTER TABLE flow_node DROP COLUMN hash;
ALTER TABLE flow_node ADD COLUMN hash BIGINT NOT NULL;
