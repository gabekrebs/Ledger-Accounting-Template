-- Make historical loan fields optional (original_principal, rate, term, first_payment_date).
-- These fields were required before; now principal paydown is computed directly from
-- the GL (initial balance vs. current balance), so you only need to enter current
-- rate + remaining term for the forward-looking amortization schedule.
--
-- Existing rows with data keep working; new simplified loans leave these null.

ALTER TABLE bk_loans
  ALTER COLUMN original_principal_cents DROP NOT NULL,
  ALTER COLUMN annual_rate_bps         DROP NOT NULL,
  ALTER COLUMN term_months             DROP NOT NULL,
  ALTER COLUMN first_payment_date      DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS remaining_term_months integer,    -- remaining months as of rate_as_of_date
  ADD COLUMN IF NOT EXISTS rate_as_of_date       date;      -- when rate/term snapshot was taken
