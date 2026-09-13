# Inventory Management System — Functional Requirements and Application Structure

## 1. Goal

Build a practical inventory and sales management system for a small business that supports:

- Product inventory tracking
- Point-of-sale sales
- Customer records
- Customer debt/credit tracking
- Payment history and debt reconciliation
- Sales history and receipt generation
- Simple dashboard reporting

This document focuses on the functional requirements and the application structure. It intentionally avoids making database design decisions until the business flows are fully specified.

---

## 2. Core business domains

The system is built around these main business entities:

### Customer
A person or entity that may:

- purchase products in cash
- purchase products on credit/debt
- make partial or full payments toward their balance

Customer data includes:

- full name
- phone number
- current outstanding balance
- total purchased amount
- total paid amount
- purchase history
- debt history
- payment history

### Product
A sellable item in inventory.

Product data includes:

- product name
- product photo
- current stock quantity
- selling price
- optional description/category

### Sale
A completed commercial transaction.

A sale captures:

- date and time
- selected customer if applicable
- list of products sold
- quantity per product
- actual price used for each product in that sale
- discount or special price if any
- payment method
- total amount
- amount paid
- debt created or balance affected

### Sale line item
A single product within a sale.

This stores:

- product reference
- quantity
- unit price used in this specific sale
- subtotal
- discount if relevant

### Debt transaction / payment record
A ledger-style record that tracks balance movement over time.

This includes:

- customer reference
- sale reference when debt is created
- payment reference when debt is reduced
- amount
- direction: increase or decrease
- date and time
- notes if needed

### Receipt
A printable record of a sale.

Receipts must preserve the actual transaction details at the time of sale, regardless of later product or customer edits.

---

## 3. Functional requirements

## 3.1 Customers

### Customer profile
The system must support:

- creating a new customer
- editing a customer profile
- viewing a customer profile
- searching by name or phone number
- viewing current debt
- viewing purchase history
- viewing payment history
- viewing debt transaction history

### Customer financial tracking
Each customer must keep track of:

- total amount purchased
- total amount paid
- current outstanding debt/balance

The system should preserve transaction history rather than simply overwrite balances.

### Debt operations
The system must support:

- recording a payment against a customer balance
- viewing all debt-generating sales
- viewing all payments received
- seeing remaining balance after each payment
- seeing whether a customer is currently in debt or cleared

### Customer creation during sales
The user should be able to:

- choose an existing customer during a sale
- search for a customer while creating a sale
- create a new customer directly on the sales screen without leaving the POS flow

### Business rule
If a sale is made on debt/credit, a customer must be selected or created for that sale.

---

## 3.2 Products / Inventory

### Product management
The system must support:

- adding a new product
- editing an existing product
- viewing product details
- uploading a product photo
- searching products
- showing current stock quantity
- showing selling price
- optional category or description

### Stock tracking
The system must track:

- stock available now
- stock movement due to sales
- low-stock and out-of-stock states

### Price handling
The product must store:

- normal selling price

The normal selling price is the default price for general sales, but it is not required to be used in every sale.

### Important rule
If a salesperson changes the price for a specific sale, the system must only affect that sale. It must not permanently overwrite the product’s usual selling price.

---

## 3.3 Sales / POS

### POS workflow
The sales page should allow the user to:

1. search for a product
2. select a product
3. choose quantity
4. view the product’s default selling price
5. override the unit price for this specific sale
6. add multiple product rows to the same sale
7. view item subtotal per line
8. view total sale amount
9. select a customer
10. choose payment method

### Payment methods
The system must support at least:

- cash / paid
- debt / credit

### Cash sales
If a sale is paid in cash:

- the sale is marked as paid
- no customer debt is created
- stock is deducted
- the sale is recorded as a historical transaction

### Debt sales
If a sale is on debt:

- the customer is required
- the sale amount is added to that customer’s outstanding balance
- the debt is linked to the sale
- the customer balance changes only through historical transaction records

### Historical price integrity
Each sale must remember:

- product identity
- quantity sold
- actual sale price used
- discount or special price
- customer involved
- payment status
- amount paid
- debt created, if any
- date and time

This prevents a later product price change from changing the historical price of previous sales.

---

## 4. Deploying STAR

### Current architecture

STAR currently has:

- a static frontend in `index.html`, `styles.css`, and `app.js`
- an Express API in `server.js`
- PostgreSQL storage on Aiven
- database schema and migrations in `schema.sql`

The frontend must never receive the Aiven database URL. Keep database credentials in server-side environment variables only.

### Important Vercel note

The current `server.js` is a long-running Express server intended for local use or a traditional Node host. Vercel runs backend code as serverless functions, so the current Express process should not be deployed to Vercel unchanged.

Use one of these deployment options:

1. Deploy the frontend to Vercel and deploy the Express API to a Node host such as Render, Railway, or Fly.io. Set the frontend API URL to the deployed API URL.
2. Add a Vercel serverless adapter for the Express routes before deploying the full application to Vercel. The adapter must export the Express app instead of calling `app.listen()` inside the Vercel function.

### Aiven environment variables

In the host running the API, configure:

```env
DATABASE_URL=postgres://avnadmin:YOUR_PASSWORD@YOUR_AIVEN_HOST:YOUR_PORT/defaultdb?sslmode=require
DB_SSL=true
PORT=3000
```

Never commit `.env`. It is excluded by `.gitignore`. Use `.env.example` as the safe template.

### Vercel frontend deployment

To deploy the static frontend:

1. Push the project to a Git repository. Confirm `.env` is not tracked.
2. Open [Vercel](https://vercel.com/) and select **Add New Project**.
3. Import the repository.
4. Set the project root to the folder containing `index.html`.
5. Use these settings:

	- Framework preset: **Other**
	- Build command: leave empty
	- Output directory: `.`
	- Install command: leave empty for a frontend-only deployment

6. Deploy the project.

The static UI can load from Vercel, but its API requests must point to a deployed API server. The current `app.js` uses same-origin `/api` requests when loaded over HTTP, so a separate API host requires an API base URL configuration before production deployment.

### Local verification before deployment

Install dependencies and run the API locally:

```powershell
npm install
npm start
```

Open:

```text
http://localhost:3000
```

Check the API connection:

```text
http://localhost:3000/api/health
```

A successful response looks like:

```json
{"ok":true,"database":"connected"}
```

The API automatically creates the tables from `schema.sql` when it starts. Confirm that Aiven contains these tables:

- `store_settings`
- `products`
- `customers`
- `sales`
- `sale_items`
- `debt_transactions`
- `expenses`

### Production checklist

- Add `DATABASE_URL` only to the API host's environment variables.
- Set `DB_SSL=true` for Aiven PostgreSQL.
- Do not expose `.env` through Vercel or the frontend bundle.
- Confirm `/api/health` reports `database: connected`.
- Test creating a product, completing a sale, recording a payment, and printing an invoice.
- Confirm the Aiven tables contain the new records.

---

## 3.4 Customer selection during sale

During a sale, the user must be able to:

- search existing customers
- select an existing customer
- create a new customer directly without leaving the sale screen

### Rules
- For debt sales, customer selection is required.
- For cash sales, customer selection may be optional depending on business needs.

---

## 3.5 Stock management

When a sale is completed:

- inventory should be deducted automatically
- sale data must preserve exact items and exact sale prices
- historical records must remain unchanged even if product data is edited later

### Example
If a product sells at $10 today and is later changed to $12, the earlier sale still must show $10 in the sale record and in any receipt.

---

## 3.6 Receipts

Every completed sale must generate a receipt.

The receipt should contain, at minimum:

- business/store information
- receipt or invoice number
- date and time
- customer name
- customer phone number if applicable
- purchased products
- quantity per product
- actual price paid per item
- special discount or negotiated price if used
- total amount
- amount paid
- remaining debt if applicable
- payment method

The final visual style can be designed later, but the data model and structure must support it.

---

## 3.7 Debt management

A dedicated debt section must allow the user to:

- view all customers with outstanding balances
- see each customer’s debt amount
- open a customer profile from this view
- review sales that generated debt
- record debt payments
- view payment history
- see remaining debt after each payment

### Example
- Customer buys $50 on debt
- balance becomes $50
- customer pays $20 later
- balance becomes $30

The system should preserve the full transaction history, not just the current balance value.

---

## 3.8 Sales history

The Sales History screen must support:

- viewing previous sales
- searching by customer
- filtering by date
- filtering by payment method
- opening a sale and seeing full details
- viewing or reprinting the receipt
- seeing whether a sale was paid or placed on debt

---

## 3.9 Dashboard

A simple dashboard should show basic business overview metrics such as:

- total sales
- number of sales
- current inventory value if enabled
- low-stock products
- total outstanding customer debt
- recent sales
- other simple stats useful to a small business

The dashboard should stay intentionally simple for now.

---

## 4. Business rules and invariants

These are the key rules the application must enforce:

1. Every sale is a historical transaction and must preserve the exact product, quantity, and price used at the time of sale.
2. Product selling price changes must not affect previous sales.
3. Customer information changes must not corrupt historical sales or debt entries.
4. Debt is created only when a sale is recorded as credit/debt.
5. A payment decreases debt and must be stored as a separate, auditable transaction.
6. A sale should retain its payment status, customer, and debt state even if the customer or product is modified later.
7. Cash sales and debt sales must be clearly distinguishable in the records.
8. Receipts must be generated from sale snapshot data, not from current product prices.

---

## 5. Proposed application structure

The application should be organized around feature modules and reusable UI components.

### Main pages / screens

- Dashboard
- Sales / POS
- Sales History
- Products / Inventory
- Customers
- Debts
- Settings

### Feature modules

#### Dashboard module
- summary panels
- recent sales list
- low-stock list
- debt overview

#### Sales / POS module
- product search
- selected products list
- quantity controls
- price override controls
- customer search and creation
- payment mode selection
- final submit and receipt generation

#### Sales History module
- list of sales
- filters
- sale detail view
- receipt preview/reprint

#### Products module
- product list
- product form
- stock management
- image upload
- stock status indicators

#### Customers module
- customer list
- customer detail profile
- debt summary
- payment form
- purchase/debt history

#### Debts module
- outstanding debt list
- customer debt detail
- payment recording
- debt history timeline

#### Shared UI components
- search inputs
- data tables
- modals
- forms
- status badges
- confirmation dialogs
- receipt preview component

---

## 6. Current implementation state

### Application

The current STAR application is a browser-based inventory and sales system with:

- STAR-branded dashboard
- Sales / POS workflow
- Product and stock management
- Customer records
- Debt and payment tracking
- Sales history
- Printable invoices and receipts
- STAR business contact information on invoices
- Aiven PostgreSQL persistence through the Express API
- No browser `localStorage` business-data cache

Run it locally with:

```powershell
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

### Aiven PostgreSQL

The live database is hosted on Aiven PostgreSQL. The connection URL is stored only in the local/server `.env` file and must not be committed or exposed to the browser.

The current public tables are:

| Table | Purpose |
| --- | --- |
| `store_settings` | Store name, address, phone, email, invoice footer, and origin label |
| `products` | Product catalog, prices, descriptions, and stock |
| `customers` | Customer profiles |
| `sales` | The transaction ledger: sales, returns, purchases, write-offs and stock corrections |
| `sale_items` | Historical products, quantities, and actual sale prices |
| `debt_transactions` | Credit extended, customer payments, and the credits a return writes off |
| `expenses` | Recorded expenses |

Two read-only views sit on top of them:

| View | Purpose |
| --- | --- |
| `sale_payments` | What each credit invoice has actually been paid, summed from `debt_transactions` |
| `customer_totals` | Per-customer purchased / paid / outstanding balance, derived from the sales and the ledger |

### Data flow

The frontend reads everything once through `GET /api/state` when it loads, then writes through one endpoint per resource. Each write returns only the records it touched, and the browser patches those into the state it already holds.

Nothing is stored as a JSON blob. Money figures that used to be stored columns -- a customer's balance, an invoice's paid amount and status -- are derived on read from the views above, so they cannot drift from the transactions they summarise.

### Transaction types

Every movement of stock is a row in `sales` with its lines in `sale_items`:

| Type | Stock | Money | Where it is recorded |
| --- | --- | --- | --- |
| `sale` | out | in, now or as debt | Ventes / Caisse, mode Vente |
| `return` | in | back to the customer | Ventes / Caisse, mode Retour |
| `purchase` | in | out, at the price paid | Achats |
| `waste` | out | none; valued at selling price | Ventes / Caisse, mode Perte |
| `adjustment` | in | none | Produits, « Ajouter des unités » |

Prices come from the catalogue for every type except `purchase`, where the price
the buyer types is what the shop actually paid and nothing else knows it.

A return settles its money against the customer's outstanding invoices first,
oldest first, and only the remainder leaves the till as cash. Those credits are
written as ordinary payment rows carrying `return_sale_id`, so the debt views need
no special case for them and deleting the return takes its credits with it.

### Database-backed store settings

The current database settings are:

- Store: H.H Fruit
- Address: Libreville, Gabon
- Phone: `+241 07 00 00 00`
- Email: `contact@stargabon.ga`
- Invoice footer: `Merci pour votre confiance !`
- Origin label: `Made in Gabon`

### API routes

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Everything the app renders, in one round trip on load |
| `GET/PUT /api/settings` | Read and update the store settings |
| `GET/POST /api/products`, `PUT/DELETE /api/products/:id` | Product catalogue |
| `POST /api/products/:id/stock` | Add units to a product's stock, recording an `adjustment` transaction |
| `GET/POST /api/customers`, `PUT/DELETE /api/customers/:id` | Customer profiles |
| `GET/POST /api/sales`, `DELETE /api/sales/:id` | Every transaction type; `DELETE` reverses whatever it did to stock and to the ledger |
| `POST /api/sales/:id/payments` | Record money received against a credit invoice |
| `GET/POST /api/expenses`, `PUT/DELETE /api/expenses/:id` | Expenses |

Prices, totals and stock are computed on the server inside a transaction, so the
browser cannot set a selling price or oversell a product. The single exception is
a purchase, where the price the buyer types is the cost the shop paid.

### Rapports

The Rapports page reports one day (the default) or a date range across every
transaction type plus expenses, with a category filter and a PDF export. It is
computed in the browser from the state `/api/state` already ships, the same way
the dashboard, the sales history and the expenses page filter. That holds for a
few thousand transactions; past that it wants a server-side aggregate.

The export builds a printable sheet carrying the store letterhead and the selected
period, then opens the browser's print dialogue -- "Enregistrer au format PDF"
there is the export. No PDF library is involved, and the invoice prints by exactly
the same route.

---

## 6. Main user flows

### Flow A: create a sale

1. Open Sales / POS.
2. Search and select product.
3. Set quantity.
4. Review default price and optionally override for this sale.
5. Add additional products if needed.
6. Choose customer if required.
7. Select payment method.
8. Confirm sale.
9. System updates stock.
10. System creates sale record.
11. System creates debt record if required.
12. System produces receipt.

### Flow B: create a customer from sales

1. Open sales screen.
2. Choose customer input.
3. Select “new customer.”
4. Fill name and phone fields.
5. Save customer.
6. Continue with the sale.

### Flow C: record debt payment

1. Open Debts or customer profile.
2. Select customer.
3. Review debt and history.
4. Enter amount received.
5. Save payment.
6. System updates balance and debt ledger.
7. System updates customer payment history.

### Flow D: view sales history

1. Open Sales History.
2. Apply filters by customer, date, or payment method.
3. Select a sale.
4. View details and receipt.
5. Reprint or export if supported.

---

## 7. Data concepts to track later in the database design

Although the database schema is not being designed yet, the application will eventually need to store these conceptual groups of data:

- customers
- products
- product images
- sale records
- sale line items
- customer balances and debt ledger
- payment records
- receipts
- sales filters / historical reporting metadata
- settings and store profile

The most important design principle is this:

Historical sales and debt records must be immutable in intent, even if customer or product information is edited later.

---

## 8. Recommended implementation approach for the next phase

Once the functional requirements are approved, the next phase should be:

1. define the app pages and routes
2. define domain entities and business rules
3. design the user interaction flow for POS and debt entry
4. decide the data persistence model
5. implement the first working MVP with core flows

This document provides the functional foundation for the MVP without locking the team into a database technology or schema.

---

## 9. Summary

This system should feel like a practical small-business tool:

- easy to use on the sales floor
- transparent for customer debt tracking
- trustworthy for historical sales records
- flexible enough to support discounts, negotiated prices, and credit sales without damaging the integrity of past records

The central rule is simple: every sale must preserve the reality of what happened at the moment it was made.
