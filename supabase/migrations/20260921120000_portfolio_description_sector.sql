-- A one-line description and a sector for each portfolio company, so the
-- Portfolio page can say what a company does rather than only its name and
-- stage. Both are plain nullable text; nothing reads them as required, and
-- application code that predates this migration keeps working against it.

alter table portfolio_companies
  add column if not exists description text,
  add column if not exists sector text;
