-- Where a portfolio company is based and who invested alongside the fund, so
-- the Portfolio page can show them. Plain nullable text like description and
-- sector; application code that predates this migration keeps working.

alter table portfolio_companies
  add column if not exists geography text,
  add column if not exists co_investors text;
