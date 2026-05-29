# How to Run the Payment System

## One-time setup (2 minutes)

### 1. Add your Stripe secret key
Open `backend/.env` and replace `sk_test_REPLACE_WITH_YOUR_SECRET_KEY` with your real secret key from:
https://dashboard.stripe.com/acct_1TcJq8Gt8Nz8gmMQ/apikeys

### 2. Set your rental amount
Also in `backend/.env`, set `RENTAL_AMOUNT_CENTS` (e.g. `50000` = AUD $500.00)

### 3. Install dependencies
Open Terminal, navigate to the backend folder, and run:
```
cd "Refrigerated Transport Rental/backend"
npm install
```

## Start the server
```
npm start
```

Then open your browser to:
**http://localhost:3001/payment-form.html**

---
## What happens on payment
1. Customer fills the form and clicks Pay
2. Stripe tokenises card details (card never touches your server)
3. Backend creates a Stripe Customer (with ABN, licence stored as metadata)
4. Backend creates and confirms a PaymentIntent for the rental amount
5. Payment appears in your Stripe dashboard instantly

## Test cards (test mode only)
| Card | Result |
|------|--------|
| 4242 4242 4242 4242 | Success |
| 4000 0000 0000 9995 | Declined |
| Any future expiry + any CVC |
