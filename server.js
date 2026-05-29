require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors({
  origin: [
    'https://coldtransportrentals.com.au',
    'https://www.coldtransportrentals.com.au',
    'http://localhost:3001',
  ]
}));
app.use(express.json());

const path = require('path');
app.use(express.static(__dirname));

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
  const { paymentMethodId, hold_only, ...customerData } = req.body;
  const { company_name, abn, licence_number, licence_state } = customerData;

  try {
    const customer = await findOrCreateCustomer(customerData);
    const AMOUNT_CENTS = parseInt(process.env.RENTAL_AMOUNT_CENTS || '75000');

    const intentParams = {
      amount: AMOUNT_CENTS,
      currency: 'aud',
      customer: customer.id,
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      description: `Refrigerated transport rental — ${company_name}`,
      metadata: { abn, licence_number, licence_state, company_name },
    };

    if (hold_only) {
      intentParams.capture_method = 'manual';
    }

    const intent = await stripe.paymentIntents.create(intentParams);
    const okStatus = hold_only ? 'requires_capture' : 'succeeded';

    if (intent.status === okStatus) {
      const label = hold_only ? 'Hold placed' : 'Payment succeeded';
      console.log(`✅ ${label}: ${intent.id} | ${company_name} | AUD ${AMOUNT_CENTS / 100}`);
      res.json({ success: true, paymentIntentId: intent.id, status: intent.status });
    } else {
      res.json({ error: `Unexpected status: ${intent.status}` });
    }
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── 2. Charge a saved customer by email (repeat rental) ─────────────────────
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
app.post('/api/send-invoice', async (req, res) => {
  const { email, company_name, amount_cents, description } = req.body;

  try {
    let customers = await stripe.customers.list({ email, limit: 1 });
    let customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({ name: company_name, email });
    }

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
  console.log(`   Port: ${PORT}`);
  console.log(`   Endpoints: /api/create-payment | /api/charge-existing | /api/send-invoice\n`);
});
