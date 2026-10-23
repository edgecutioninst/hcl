-- Monotonic IDs for uploaded applications/documents (fixed width so string order = upload order).
CREATE SEQUENCE IF NOT EXISTS application_seq START 1;
CREATE SEQUENCE IF NOT EXISTS document_seq START 1;
