/**
 * Real-World Example: Customer Support Email Handler
 * Automatically categorizes, prioritizes, and routes support emails
 */

const { extract, validate, summarize, decide, configure } = require('../src/index');

// Configure the toolkit (in production, use environment variables)
configure({
  engines: {
    openai: process.env.OPENAI_API_KEY
  }
});

/**
 * Process a customer support email
 */
async function handleSupportEmail(emailContent) {
  console.log('\n📧 Processing Customer Support Email...\n');
  console.log('Original Email:', `${emailContent.substring(0, 100)}...\n`);

  // Step 1: Extract structured information from the email
  console.log('1️⃣ Extracting information...');
  const extracted = await extract(emailContent, {
    customer_sentiment: {
      type: 'string',
      description: 'angry, frustrated, neutral, happy'
    },
    issue_type: {
      type: 'string',
      description: 'billing, technical, feature_request, complaint, other'
    },
    specific_problems: {
      type: 'array',
      description: 'list of specific issues mentioned'
    },
    requested_actions: {
      type: 'array',
      description: 'what the customer wants done'
    },
    urgency_indicators: {
      type: 'array',
      description: 'words/phrases indicating urgency'
    },
    product_mentioned: {
      type: 'string',
      description: 'product or service mentioned'
    },
    customer_value_indicators: {
      type: 'array',
      description: 'enterprise, long-time customer, subscription tier, etc'
    }
  });

  console.log('Extracted Data:', extracted.data);

  // Step 2: Validate if this is a high-priority ticket
  console.log('\n2️⃣ Validating priority...');
  const priorityValidation = await validate(
    'Is this a high-priority support ticket that needs immediate attention?',
    extracted.data,
    {
      criteria: [
        'angry or frustrated sentiment',
        'mentions legal action or lawyer',
        'enterprise customer',
        'service outage or data loss',
        'payment or billing issue',
        'multiple failed attempts to resolve'
      ]
    }
  );

  console.log(`Priority Score: ${priorityValidation.score} (${priorityValidation.recommendation})`);
  console.log(`Reasoning: ${priorityValidation.reasoning}`);

  // Step 3: Summarize for the support agent
  console.log('\n3️⃣ Creating summary for support agent...');
  const summary = await summarize(
    {
      email: emailContent,
      extracted: extracted.data,
      priority: priorityValidation
    },
    {
      maxLength: 150,
      focus: 'actionable_next_steps'
    }
  );

  console.log('Summary:', summary.summary);
  console.log('Key Points:', summary.keyPoints);

  // Step 4: Decide on routing and action
  console.log('\n4️⃣ Deciding on action...');
  const routingDecision = await decide(
    {
      extracted: extracted.data,
      priority: priorityValidation.score,
      summary: summary.summary
    },
    [
      {
        action: 'escalate_to_manager',
        description: 'Escalate to support manager immediately'
      },
      {
        action: 'assign_to_technical',
        description: 'Assign to technical support team'
      },
      {
        action: 'assign_to_billing',
        description: 'Assign to billing department'
      },
      {
        action: 'send_automated_response',
        description: 'Send automated response with FAQ links'
      },
      {
        action: 'add_to_feature_requests',
        description: 'Log as feature request for product team'
      },
      {
        action: 'assign_to_general_queue',
        description: 'Add to general support queue'
      }
    ]
  );

  console.log(`\n✅ Decision: ${routingDecision.action}`);
  console.log(`Reasoning: ${routingDecision.reasoning}`);
  console.log(`Confidence: ${(routingDecision.confidence * 100).toFixed(1)}%`);

  // Return complete analysis
  return {
    extracted: extracted.data,
    priority: {
      score: priorityValidation.score,
      isHighPriority: priorityValidation.score > 0.7,
      reasoning: priorityValidation.reasoning
    },
    summary: summary.summary,
    keyPoints: summary.keyPoints,
    routing: {
      action: routingDecision.action,
      confidence: routingDecision.confidence,
      reasoning: routingDecision.reasoning
    },
    suggestedResponse: generateSuggestedResponse(extracted.data, routingDecision.action)
  };
}

/**
 * Generate a suggested response based on the analysis
 */
function generateSuggestedResponse(extracted, action) {
  const templates = {
    escalate_to_manager: `Dear [Customer],

I sincerely apologize for the frustration you've experienced. I've immediately escalated your case to our support manager who will contact you within the next 2 hours.

Your case has been marked as high priority and we will ensure it's resolved quickly.

Reference: [TICKET_ID]`,

    assign_to_technical: `Dear [Customer],

Thank you for reporting this technical issue. I've assigned your case to our specialized technical team who will investigate immediately.

You can expect an update within 4 hours with our findings and next steps.

Reference: [TICKET_ID]`,

    assign_to_billing: `Dear [Customer],

I understand your concern regarding the billing issue. I've forwarded your case to our billing department for immediate review.

They will contact you within 24 hours with a resolution.

Reference: [TICKET_ID]`,

    send_automated_response: `Dear [Customer],

Thank you for contacting support. We've received your message and created a ticket for tracking.

In the meantime, you might find these resources helpful: [FAQ_LINKS]

Reference: [TICKET_ID]`
  };

  return templates[action] || templates.send_automated_response;
}

// Example emails to test
const testEmails = [
  {
    name: 'Angry Enterprise Customer',
    content: `Subject: URGENT - System completely down!!!

This is absolutely unacceptable! Our entire company has been unable to access the system for the past 3 hours. We're losing thousands of dollars every minute this is down.

We've been paying for your Enterprise plan for 5 years and this is the 3rd outage this month. If this isn't fixed immediately, we'll be forced to switch providers and pursue legal action for breach of contract.

We need someone to call us NOW at 555-0100.

John Smith
CTO, BigCorp Inc.`
  },

  {
    name: 'Feature Request',
    content: `Subject: Feature suggestion

Hi team,

Love your product! I was wondering if you could add a dark mode option? It would really help when I'm working late at night.

Also, it would be cool if you could export reports as PDF.

Thanks!
Sarah`
  },

  {
    name: 'Billing Question',
    content: `Subject: Incorrect charge on my account

Hello,

I noticed I was charged $299 this month but my plan should only be $199. Can someone look into this? I've attached a screenshot of my billing page.

My account email is user@example.com

Please refund the difference.

Thanks,
Mike`
  }
];

// Run the examples
async function runExamples() {
  for (const email of testEmails) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 TEST CASE: ${email.name}`);
    console.log('='.repeat(60));

    try {
      const result = await handleSupportEmail(email.content);

      console.log('\n📋 COMPLETE ANALYSIS:');
      console.log('-------------------');
      console.log('Priority Level:', result.priority.isHighPriority ? '🔴 HIGH' : '🟢 NORMAL');
      console.log('Route to:', result.routing.action.replace(/_/g, ' ').toUpperCase());
      console.log('\nSuggested Response Template:');
      console.log(result.suggestedResponse);
    } catch (error) {
      console.error('Error processing email:', error.message);
    }
  }
}

// Export for use in other files
module.exports = { handleSupportEmail };

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
