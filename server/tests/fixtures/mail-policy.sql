CREATE ROLE robin_mta;
CREATE ROLE robin_mailbox;
CREATE ROLE robin_admin;
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(320) UNIQUE NOT NULL,
  password TEXT NOT NULL
);
CREATE TABLE aliases (
  id SERIAL PRIMARY KEY,
  source VARCHAR(320) NOT NULL,
  destination VARCHAR(320) NOT NULL
);
INSERT INTO users (email, password) VALUES
  ('owner@example.test', 'synthetic-not-an-authentication-hash'),
  ('shared@example.test', 'synthetic-not-an-authentication-hash');
INSERT INTO aliases (source, destination) VALUES
  ('team@example.test', 'owner@example.test'),
  ('team@example.test', 'shared@example.test');
