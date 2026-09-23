/**
 * Real-World Example: Expense Report Processor
 * Extracts data from receipts, validates expenses, and decides on approval
 */

const { extract, validate, summarize, decide, configure } = require('../src/index');

// Configure
configure({
  engines: {
    openai: process.env.OPENAI_API_KEY
  }
});

/**
 * Process an expense report
 */
async function processExpenseReport(expenseData) {
  console.log('\n💰 Processing Expense Report\n');

  // Step 1: Extract expense information
  console.log('1️⃣ Extracting expense details...');
  const expenses = await extract(expenseData, {
    employee_name: {
      type: 'string',
      required: true
    },
    department: {
      type: 'string'
    },
    expense_items: {
      type: 'array',
      description: 'list of expense items with date, description, amount, category'
    },
    total_amount: {
      type: 'number',
      required: true
    },
    business_purpose: {
      type: 'string',
      description: 'business justification'
    },
    receipts_attached: {
      type: 'boolean'
    },
    travel_dates: {
      type: 'object',
      description: 'start and end dates if travel-related'
    },
    client_related: {
      type: 'string',
      description: 'client name if client-related'
    }
  });

  console.log('Extracted:', JSON.stringify(expenses.data, null, 2));

  // Step 2: Validate against company policy
  console.log('\n2️⃣ Validating against expense policy...');
  const policyCheck = await validate(
    'Does this expense report comply with company expense policy?',
    expenses.data,
    {
      policy_rules: [
        'Individual meals under $100',
        'Hotel stays under $300/night',
        'Requires receipts for items over $25',
        'Business purpose must be clearly stated',
        'Travel must be pre-approved for amounts over $1000',
        'Entertainment expenses need client name',
        'No alcohol expenses over $50'
      ]
    }
  );

  console.log(`Policy Compliance: ${(policyCheck.score * 100).toFixed(1)}%`);
  console.log(`Assessment: ${policyCheck.reasoning}`);

  // Step 3: Summarize for approver
  console.log('\n3️⃣ Creating summary for approver...');
  const reportSummary = await summarize(
    {
      expenses: expenses.data,
      compliance: policyCheck
    },
    {
      maxLength: 150,
      focus: 'key_expenses_and_concerns'
    }
  );

  console.log('Summary:', reportSummary.summary);

  // Step 4: Decide on approval action
  console.log('\n4️⃣ Making approval decision...');
  const approvalDecision = await decide(
    {
      total: expenses.data.total_amount,
      compliance_score: policyCheck.score,
      has_receipts: expenses.data.receipts_attached,
      items: expenses.data.expense_items
    },
    [
      {
        action: 'auto_approve',
        description: 'Automatically approve (under $500, fully compliant)'
      },
      {
        action: 'approve_with_note',
        description: 'Approve but add note about minor issues'
      },
      {
        action: 'manager_review',
        description: 'Requires manager review (over $500)'
      },
      {
        action: 'request_receipts',
        description: 'Request missing receipts before approval'
      },
      {
        action: 'request_clarification',
        description: 'Need more information about business purpose'
      },
      {
        action: 'reject',
        description: 'Reject due to policy violations'
      }
    ]
  );

  console.log(`\n✅ Decision: ${approvalDecision.action.replace(/_/g, ' ').toUpperCase()}`);
  console.log(`Reasoning: ${approvalDecision.reasoning}`);
  console.log(`Confidence: ${(approvalDecision.confidence * 100).toFixed(1)}%`);

  // Generate detailed report
  return {
    employee: expenses.data.employee_name,
    total: expenses.data.total_amount,
    compliance: {
      score: policyCheck.score,
      compliant: policyCheck.score > 0.8,
      issues: policyCheck.weaknesses || []
    },
    decision: approvalDecision.action,
    summary: reportSummary.summary,
    breakdown: generateExpenseBreakdown(expenses.data),
    notifications: generateNotifications(approvalDecision.action, expenses.data)
  };
}

/**
 * Generate expense breakdown by category
 */
function generateExpenseBreakdown(expenseData) {
  if (!expenseData.expense_items) {
    return {};
  }

  const breakdown = {};
  expenseData.expense_items.forEach(item => {
    const category = item.category || 'Other';
    breakdown[category] = (breakdown[category] || 0) + (item.amount || 0);
  });

  return breakdown;
}

/**
 * Generate notifications based on decision
 */
function generateNotifications(decision, expenseData) {
  const notifications = [];

  switch (decision) {
    case 'auto_approve':
      notifications.push({
        to: expenseData.employee_name,
        message: 'Your expense report has been automatically approved'
      });
      break;

    case 'manager_review':
      notifications.push({
        to: 'manager',
        message: `Expense report from ${expenseData.employee_name} needs review ($${expenseData.total_amount})`
      });
      break;

    case 'request_receipts':
      notifications.push({
        to: expenseData.employee_name,
        message: 'Please upload missing receipts for your expense report'
      });
      break;

    case 'reject':
      notifications.push({
        to: expenseData.employee_name,
        message: 'Your expense report has been rejected due to policy violations'
      });
      break;
  }

  return notifications;
}

// Test cases
const expenseReports = [
  {
    name: 'Small Compliant Report',
    data: `
Employee: John Smith
Department: Sales
Date: March 15, 2024

Business Trip to Client Meeting in Boston

Expenses:
- March 14: Flight to Boston - $342.50 (Receipt attached)
- March 14: Taxi to hotel - $45.00 (Receipt attached)
- March 14: Dinner with client (Acme Corp) - $89.50 (Receipt attached)
- March 15: Hotel (1 night) - $189.00 (Receipt attached)
- March 15: Breakfast - $18.50 (Receipt attached)
- March 15: Taxi to airport - $42.00 (Receipt attached)

Total: $726.50
All receipts attached.
Purpose: Quarterly review meeting with Acme Corp to discuss contract renewal.
`
  },

  {
    name: 'Large Report Missing Info',
    data: `
Employee: Sarah Johnson
Department: Marketing

Conference Expenses - Las Vegas Marketing Summit

Expenses:
- Flight: $650
- Hotel (3 nights): $1,200
- Conference registration: $1,500
- Meals: $450
- Entertainment with clients: $380
- Uber rides: $120

Total: $4,300

Some receipts missing for meals and transportation.
`
  },

  {
    name: 'Policy Violation',
    data: `
Employee: Mike Wilson
Department: IT

Team dinner and celebration

Expenses:
- Team dinner at expensive restaurant: $850 (10 people)
- Alcohol: $320
- Uber rides for team: $150

Total: $1,320

Purpose: Celebrating project completion
No client involved, internal team only.
`
  }
];

// Run examples
async function runExamples() {
  for (const report of expenseReports) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📄 EXPENSE REPORT: ${report.name}`);
    console.log('='.repeat(60));

    try {
      const result = await processExpenseReport(report.data);

      console.log('\n📊 PROCESSING RESULT:');
      console.log('--------------------');
      console.log(`Employee: ${result.employee}`);
      console.log(`Total: $${result.total}`);
      console.log(`Compliant: ${result.compliance.compliant ? '✅ Yes' : '❌ No'}`);
      console.log(`Decision: ${result.decision.replace(/_/g, ' ').toUpperCase()}`);

      if (Object.keys(result.breakdown).length > 0) {
        console.log('\nBreakdown by Category:');
        Object.entries(result.breakdown).forEach(([cat, amount]) => {
          console.log(`  ${cat}: $${amount}`);
        });
      }

      if (result.notifications.length > 0) {
        console.log('\nNotifications:');
        result.notifications.forEach(notif => {
          console.log(`  → ${notif.to}: ${notif.message}`);
        });
      }
    } catch (error) {
      console.error('Error processing expense report:', error.message);
    }
  }
}

// Export
module.exports = { processExpenseReport };

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
