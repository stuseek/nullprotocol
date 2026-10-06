// An invoice total: the model reads the lines and the terms, the code does the arithmetic.
// Run: node examples/flows/invoice.mjs
import { ai } from './model.mjs';

const invoice = `INVOICE INV-1
USB-C cable 2m — qty 12 at $7.49 each
Laptop stand — qty 3 at $34.90 each
Wireless mouse — qty 5 at $18.25 each
Volume discount: 10% off the subtotal
Sales tax: 8.5% applied after the discount`;

// Two narrow reads are more reliable on a small model than one wide one.
const lines = await ai.extract(invoice, {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description:
        'Only the product lines that have a quantity and a unit price. Not the discount or tax lines.',
      items: {
        type: 'object',
        required: ['name', 'quantity', 'unitPrice'],
        properties: {
          name: {
            type: 'string',
            description: 'The full product name as printed, including any numbers in it'
          },
          quantity: { type: 'number', description: 'The number after "qty"' },
          unitPrice: { type: 'number', description: 'The price after "at"' }
        }
      }
    }
  }
});
const terms = await ai.extract(invoice, {
  type: 'object',
  required: ['discountPercent', 'taxPercent'],
  properties: {
    discountPercent: {
      type: 'number',
      description:
        'The number before the % sign on the discount line, for example 10 for "10% off". 0 when there is no discount line.'
    },
    taxPercent: {
      type: 'number',
      description: 'The number before the % sign on the sales tax line, for example 8.5 for "8.5%".'
    }
  }
});
if (!lines.success || !terms.success) throw new Error(lines.error || terms.error);

const cents = n => Math.round(n * 100) / 100;
const subtotal = cents(
  lines.data.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
);
const total = cents(
  subtotal * (1 - terms.data.discountPercent / 100) * (1 + terms.data.taxPercent / 100)
);
console.log(invoice);
console.log('Read:', lines.data.items, terms.data); // three items, { discountPercent: 10, taxPercent: 8.5 }
console.log('Result:', { subtotal, total }); // { subtotal: 285.83, total: 279.11 }
