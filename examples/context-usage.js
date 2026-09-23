/**
 * Context Usage Example - Stateful vs Stateless
 */

const AIToolkit = require('../src/index');
const { extract, validate, summarize: _summarize, decide: _decide } = require('../src/index');

async function demonstrateContextUsage() {
  // ============================================
  // STATEFUL MODE - Using class instance
  // ============================================
  console.log('=== STATEFUL MODE ===\n');

  const ai = new AIToolkit({
    basePrompt: 'You are analyzing customer data for a SaaS company',
    engines: { openai: process.env.OPENAI_API_KEY }
  });

  // Add persistent context
  ai.addContext('company', { name: 'TechCorp', industry: 'Software' });
  ai.addContext('user', { role: 'analyst', department: 'Customer Success' });

  // All operations will include this context
  const customerData = 'Customer complained about slow response times and wants refund';

  const extracted1 = await ai.extract(customerData, {
    issue: 'string',
    sentiment: 'string',
    request: 'string'
  });
  console.log('Stateful Extract:', extracted1);

  // Add more context for specific analysis
  ai.addContext('customerTier', 'premium');

  const validated1 = await ai.validate('Is this a high-priority issue?', extracted1.data);
  console.log('Stateful Validate:', validated1);

  // Remove context when done
  ai.removeContext('customerTier');

  // ============================================
  // STATELESS MODE - Using functions directly
  // ============================================
  console.log('\n=== STATELESS MODE ===\n');

  // Pass context per operation
  const extracted2 = await extract(
    customerData,
    {
      issue: 'string',
      sentiment: 'string',
      request: 'string'
    },
    {
      additionalContext: {
        company: { name: 'TechCorp', industry: 'Software' },
        user: { role: 'analyst', department: 'Customer Success' }
      }
    }
  );
  console.log('Stateless Extract:', extracted2);

  const validated2 = await validate(
    'Is this a high-priority issue?',
    extracted2.data,
    null, // reference
    {
      additionalContext: {
        company: { name: 'TechCorp', industry: 'Software' },
        user: { role: 'analyst', department: 'Customer Success' },
        customerTier: 'premium'
      }
    }
  );
  console.log('Stateless Validate:', validated2);

  // ============================================
  // MIXED MODE - Stateful with per-operation context
  // ============================================
  console.log('\n=== MIXED MODE ===\n');

  // Use stateful instance but add extra context for specific operation
  const summary = await ai.summarize(
    { issue: extracted1.data, validation: validated1 },
    {
      maxLength: 100,
      focus: 'action_items',
      additionalContext: 'This is for the weekly executive report'
    }
  );
  console.log('Mixed Mode Summary:', summary);

  // ============================================
  // DECISION WITH FULL CONTEXT
  // ============================================
  console.log('\n=== DECISION WITH CONTEXT ===\n');

  const decision = await ai.decide(
    {
      customer: extracted1.data,
      priority: validated1,
      summary: summary
    },
    ['issue_refund', 'offer_credit', 'escalate_to_engineering', 'schedule_call'],
    {
      additionalContext: {
        policy: 'Premium customers get priority support',
        budget: 'Refunds approved up to $500 without manager approval'
      }
    }
  );
  console.log('Decision:', decision);
}

// Show that signatures are identical
console.log('Method Signatures Comparison:\n');
console.log('STATEFUL:  ai.extract(data, schema, options?)');
console.log('STATELESS: extract(data, schema, options?)');
console.log('\nBoth support additionalContext in options!');
console.log('Both return the same response structure!');
console.log('\nThe only difference:');
console.log('- Stateful: Context persists across calls via ai.addContext()');
console.log('- Stateless: Context passed per call via options.additionalContext');

// Run if API key is available
if (process.env.OPENAI_API_KEY) {
  demonstrateContextUsage().catch(console.error);
} else {
  console.log('\n⚠️  Set OPENAI_API_KEY to run the demo');
}
