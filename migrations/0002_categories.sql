-- Budget categories on every transaction (Grocery, Eat Out, Rent…).
-- Income, budgets and savings balances live in the kv table as 'year:<YYYY>'.
ALTER TABLE txns ADD COLUMN cat TEXT NOT NULL DEFAULT '';
CREATE INDEX txns_cat ON txns(cat);
