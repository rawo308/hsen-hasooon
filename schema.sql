-- STAR inventory manager schema.
-- Each collection lives in its own table; nothing is stored as a JSON blob.
-- Money is NUMERIC(12, 2), ids are the application-generated TEXT ids.

CREATE TABLE IF NOT EXISTS store_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  store_name TEXT NOT NULL DEFAULT '',
  store_phone TEXT NOT NULL DEFAULT '',
  store_address TEXT NOT NULL DEFAULT '',
  store_email TEXT NOT NULL DEFAULT '',
  receipt_footer TEXT NOT NULL DEFAULT '',
  country_of_origin TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO store_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products DROP COLUMN IF EXISTS category;
ALTER TABLE products DROP COLUMN IF EXISTS cost_price;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- balance / total_purchased / total_paid used to be stored here and drifted from
-- the sales they summarise. They are derived on read now (see customer_totals).
ALTER TABLE customers DROP COLUMN IF EXISTS balance;
ALTER TABLE customers DROP COLUMN IF EXISTS total_purchased;
ALTER TABLE customers DROP COLUMN IF EXISTS total_paid;

-- A 'sale' moves stock out and may create debt; a 'return' moves stock back in
-- and is standalone: it never touches a customer's totals or balance.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'sale' CHECK (type IN ('sale', 'return')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  -- Both NULL on returns, which have no tender.
  payment_method TEXT CHECK (payment_method IN ('cash', 'debt')),
  payment_type TEXT CHECK (payment_type IN ('cash', 'partial', 'debt')),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100)
);

-- amount_paid / debt_amount / status were stored columns duplicating the payment
-- ledger. They are derived from debt_transactions now (see sale_payments).
ALTER TABLE sales DROP COLUMN IF EXISTS amount_paid;
ALTER TABLE sales DROP COLUMN IF EXISTS debt_amount;
ALTER TABLE sales DROP COLUMN IF EXISTS status;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'sale';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_type TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE sales ALTER COLUMN payment_method DROP NOT NULL;

CREATE TABLE IF NOT EXISTS sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  -- NULL once the product leaves the catalogue; product_name keeps the receipt
  -- readable.
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL
);

-- Left over from the removed product-variants feature; it is the last reference
-- keeping product_variants alive.
ALTER TABLE sale_items DROP COLUMN IF EXISTS variant_id;

-- The customer ledger: 'sale' entries record credit extended, 'payment' entries
-- record money received against a specific invoice.
CREATE TABLE IF NOT EXISTS debt_transactions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id TEXT REFERENCES sales(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sale', 'payment')),
  amount NUMERIC(12, 2) NOT NULL,
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales (created_at);
CREATE INDEX IF NOT EXISTS sales_customer_idx ON sales (customer_id);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS sale_items_product_idx ON sale_items (product_id);
CREATE INDEX IF NOT EXISTS debt_transactions_customer_idx ON debt_transactions (customer_id);
CREATE INDEX IF NOT EXISTS debt_transactions_sale_idx ON debt_transactions (sale_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (expense_date);

-- What a credit invoice has actually been paid, straight from the ledger.
CREATE OR REPLACE VIEW sale_payments AS
SELECT s.id AS sale_id,
       LEAST(s.total_amount, GREATEST(COALESCE(SUM(d.amount) FILTER (WHERE d.type = 'payment'), 0), 0))::NUMERIC(12, 2) AS paid
FROM sales s
LEFT JOIN debt_transactions d ON d.sale_id = s.id
GROUP BY s.id, s.total_amount;

-- Per-customer money figures. Returns are excluded on purpose: a return is a
-- standalone record that never moves a customer's totals or balance.
CREATE OR REPLACE VIEW customer_totals AS
SELECT c.id AS customer_id,
       COALESCE(SUM(s.total_amount), 0)::NUMERIC(12, 2) AS total_purchased,
       COALESCE(SUM(CASE WHEN s.payment_method = 'cash' THEN s.total_amount
                         ELSE COALESCE(p.paid, 0) END), 0)::NUMERIC(12, 2) AS total_paid,
       COALESCE(SUM(CASE WHEN s.payment_method = 'debt'
                         THEN GREATEST(s.total_amount - COALESCE(p.paid, 0), 0)
                         ELSE 0 END), 0)::NUMERIC(12, 2) AS balance
FROM customers c
LEFT JOIN sales s ON s.customer_id = c.id AND s.type = 'sale'
LEFT JOIN sale_payments p ON p.sale_id = s.id
GROUP BY c.id;

-- Left over from the removed product-variants feature, now unreferenced.
DROP TABLE IF EXISTS product_variants;

-- The JSON blob the tables above replaced. It never held data on this
-- installation, so it is dropped outright rather than migrated.
DROP TABLE IF EXISTS app_state;
