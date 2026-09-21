-- How the fund came to the deal (VC network, LP network, founder network,
-- inbound, outbound). Plain nullable text like the other descriptive columns;
-- application code that predates this migration keeps working.

alter table portfolio_companies
  add column if not exists deal_source text;
