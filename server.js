require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors({
  origin: [
    'https://coldtransportrentals.com',
    'https://www.coldtransportrentals.com',
    'https://coldtransportrentals.com.au',
    'https://www.coldtransportrentals.com.au',
    'http://localhost:3001',
  ]
}));
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname, '..')));

// ─── Helper: find existing customer by email, or create new ───────────────────
async function findOrCreateCustomer({ company_name, email, address_line1, city, postcode, state, country, abn, licence_number, licence_state }) {
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];

  return stripe.customers.create({
    name: company_name,
    email,
    address: { line1: address_line1, city, postal_code: postcode, state, country: country || 'AU' },
    metadata: { abn, licence_number, licence_state },
  });
}

// ─── 1. Standard payment OR hold ─────────────────────────────────────────────
app.post('/api/create-payment', async (req, res) => {
  const { paymentMethodId, hold_only, rental_amount, hold_amount, ...customerData } = req.body;
  const { company_name, abn, licence_number, licence_state } = customerData;

  // Convert dollar amounts to cents; fall back to env var for legacy calls
  const rentalCents = rental_amount ? Math.round(parseFloat(rental_amount) * 100)
                                    : parseInt(process.env.RENTAL_AMOUNT_CENTS || '75000');
  const holdCents   = hold_amount   ? Math.round(parseFloat(hold_amount) * 100) : 0;

  try {
    const customer = await findOrCreateCustomer(customerData);
    const meta = { abn, licence_number, licence_state, company_name };

    const results = {};

    if (hold_only) {
      // Hold-only mode: authorise total (rental + hold) as a single hold
      const totalCents = rentalCents + holdCents;
      if (totalCents > 0) {
        const intent = await stripe.paymentIntents.create({
          amount: totalCents,
          currency: 'aud',
          customer: customer.id,
          payment_method: paymentMethodId,
          confirm: true,
          capture_method: 'manual',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: `Authorisation hold — ${company_name}`,
          metadata: { ...meta, rental_amount: rentalCents, hold_amount: holdCents },
        });
        if (intent.status !== 'requires_capture') {
          return res.json({ error: `Unexpected status: ${intent.status}` });
        }
        results.holdIntentId = intent.id;
        console.log(`✅ Hold placed: ${intent.id} | ${company_name} | AUD ${totalCents / 100}`);
      }
    } else {
      // Charge rental now, place security hold separately
      if (rentalCents > 0) {
        const rentalIntent = await stripe.paymentIntents.create({
          amount: rentalCents,
          currency: 'aud',
          customer: customer.id,
          payment_method: paymentMethodId,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: `Rental charge — ${company_name}`,
          metadata: meta,
        });
        if (rentalIntent.status !== 'succeeded') {
          return res.json({ error: `Payment failed: ${rentalIntent.status}` });
        }
        results.rentalIntentId = rentalIntent.id;
        console.log(`✅ Rental charged: ${rentalIntent.id} | ${company_name} | AUD ${rentalCents / 100}`);
      }

      if (holdCents > 0) {
        const holdIntent = await stripe.paymentIntents.create({
          amount: holdCents,
          currency: 'aud',
          customer: customer.id,
          payment_method: paymentMethodId,
          confirm: true,
          capture_method: 'manual',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: `Security deposit hold — ${company_name}`,
          metadata: meta,
        });
        if (holdIntent.status !== 'requires_capture') {
          return res.json({ error: `Hold failed: ${holdIntent.status}` });
        }
        results.holdIntentId = holdIntent.id;
        console.log(`✅ Hold placed: ${holdIntent.id} | ${company_name} | AUD ${holdCents / 100}`);
      }
    }

    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── 2. Charge a saved customer by email (repeat rental) ─────────────────────
// POST /api/charge-existing  { email, amount_cents (optional) }
app.post('/api/charge-existing', async (req, res) => {
  const { email, amount_cents, hold_only } = req.body;

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'No customer found with that email.' });

    const customer = customers.data[0];
    const paymentMethods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 });
    if (!paymentMethods.data.length) return res.status(404).json({ error: 'No saved card for this customer.' });

    const AMOUNT_CENTS = amount_cents || parseInt(process.env.RENTAL_AMOUNT_CENTS || '75000');
    const pm = paymentMethods.data[0];

    const intent = await stripe.paymentIntents.create({
      amount: AMOUNT_CENTS,
      currency: 'aud',
      customer: customer.id,
      payment_method: pm.id,
      confirm: true,
      off_session: true,
      capture_method: hold_only ? 'manual' : 'automatic',
      description: `Repeat rental — ${customer.name}`,
      metadata: { ...customer.metadata, company_name: customer.name },
    });

    console.log(`✅ Repeat charge: ${intent.id} | ${customer.name} | AUD ${AMOUNT_CENTS / 100}`);
    res.json({ success: true, paymentIntentId: intent.id, customer: customer.name });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── 3. Send invoice/payment link to customer via email ───────────────────────
// POST /api/send-invoice  { email, company_name, amount_cents, description }
app.post('/api/send-invoice', async (req, res) => {
  const { email, company_name, amount_cents, description } = req.body;

  try {
    // Find or create customer
    let customers = await stripe.customers.list({ email, limit: 1 });
    let customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({ name: company_name, email });
    }

    // Create invoice with a one-off line item
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: amount_cents || parseInt(process.env.RENTAL_AMOUNT_CENTS || '75000'),
      currency: 'aud',
      description: description || 'Refrigerated transport rental',
    });

    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: 7,
      auto_advance: true,
    });

    const finalised = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalised.id);

    console.log(`📧 Invoice sent: ${finalised.id} → ${email} | AUD ${(amount_cents || 75000) / 100}`);
    res.json({ success: true, invoiceId: finalised.id, invoiceUrl: finalised.hosted_invoice_url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Cold Transport Rentals payment server running`);
  console.log(`   Backend: http://localhost:${PORT}`);
  console.log(`   Form:    http://localhost:${PORT}/payment-form.html\n`);
  console.log(`   Endpoints:`);
  console.log(`   POST /api/create-payment   — new customer (charge or hold)`);
  console.log(`   POST /api/charge-existing  — repeat charge saved card`);
  console.log(`   POST /api/send-invoice     — email invoice to any customer\n`);
});
