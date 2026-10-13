-- Demonstrates error reporting: two broken statements, everything else still renders.
CREATE SCHEMA app;

CREATE TABLE app.users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE
);

-- Typo: "TABEL"
CREATE TABEL app.teams (
    id uuid PRIMARY KEY
);

CREATE TABLE app.memberships (
    user_id uuid NOT NULL REFERENCES app.users (id),
    team_id uuid NOT NULL REFERENCES app.teams (id),   -- teams is missing: drawn as an external table
    role text NOT NULL DEFAULT 'member',
    PRIMARY KEY (user_id, team_id)
);

-- Missing comma between columns
CREATE TABLE app.invites (
    id uuid PRIMARY KEY
    email text NOT NULL
);

ALTER TABLE app.memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('member', 'admin'));
