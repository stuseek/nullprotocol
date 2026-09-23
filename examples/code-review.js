/**
 * Real-World Example: Automated Code Review Assistant
 * Analyzes code changes and provides review feedback
 */

const AIToolkit = require('../src/index');

// Initialize with configuration
const ai = new AIToolkit({
  engines: {
    openai: process.env.OPENAI_API_KEY
  },
  validateOutputs: true // Extra validation for code review
});

/**
 * Review a code change/pull request
 */
async function reviewCode(codeChange) {
  console.log('\n🔍 Automated Code Review\n');

  // Step 1: Extract code change information
  console.log('1️⃣ Analyzing code changes...');
  const analysis = await ai.extract(codeChange, {
    language: {
      type: 'string',
      description: 'programming language'
    },
    change_type: {
      type: 'string',
      description: 'feature, bugfix, refactor, documentation, test'
    },
    files_changed: {
      type: 'array',
      description: 'list of files modified'
    },
    functions_modified: {
      type: 'array',
      description: 'functions or methods changed'
    },
    potential_issues: {
      type: 'array',
      description: 'potential bugs, security issues, or problems'
    },
    dependencies_added: {
      type: 'array',
      description: 'new dependencies or imports'
    },
    test_coverage: {
      type: 'string',
      description: 'are tests included or needed?'
    },
    breaking_changes: {
      type: 'array',
      description: 'any breaking changes identified'
    }
  });

  console.log('Analysis:', analysis.data);

  // Step 2: Validate code quality
  console.log('\n2️⃣ Validating code quality...');
  const qualityCheck = await ai.validate(
    'Does this code change meet production quality standards?',
    analysis.data,
    {
      standards: [
        'no obvious security vulnerabilities',
        'proper error handling',
        'follows naming conventions',
        'includes necessary tests',
        'no hardcoded secrets',
        'efficient algorithms',
        'proper input validation'
      ]
    }
  );

  console.log(`Quality Score: ${(qualityCheck.score * 100).toFixed(1)}%`);
  console.log(`Assessment: ${qualityCheck.reasoning}`);

  // Step 3: Generate review summary
  console.log('\n3️⃣ Generating review summary...');
  const reviewSummary = await ai.summarize(
    {
      changes: analysis.data,
      quality: qualityCheck,
      code: codeChange
    },
    {
      maxLength: 200,
      focus: 'actionable_feedback'
    }
  );

  console.log('Summary:', reviewSummary.summary);

  // Step 4: Decide on review verdict
  console.log('\n4️⃣ Making review decision...');
  const verdict = await ai.decide(
    {
      analysis: analysis.data,
      quality: qualityCheck.score,
      issues: analysis.data.potential_issues
    },
    [
      {
        action: 'approve',
        description: 'Approve and merge'
      },
      {
        action: 'approve_with_suggestions',
        description: 'Approve but suggest improvements'
      },
      {
        action: 'request_changes',
        description: 'Request changes before approval'
      },
      {
        action: 'needs_tests',
        description: 'Requires tests before approval'
      },
      {
        action: 'security_review',
        description: 'Needs security team review'
      }
    ]
  );

  console.log(`\n✅ Review Decision: ${verdict.action.replace(/_/g, ' ').toUpperCase()}`);
  console.log(`Reasoning: ${verdict.reasoning}`);

  // Generate detailed feedback
  const feedback = generateCodeReviewFeedback(analysis.data, qualityCheck, verdict);

  return {
    analysis: analysis.data,
    quality: {
      score: qualityCheck.score,
      passed: qualityCheck.score > 0.7
    },
    verdict: verdict.action,
    feedback,
    checklist: generateReviewChecklist(analysis.data, qualityCheck)
  };
}

/**
 * Generate detailed code review feedback
 */
function generateCodeReviewFeedback(analysis, quality, verdict) {
  const feedback = [];

  // Header based on verdict
  const headers = {
    approve: '✅ **Code Review: APPROVED**\n\nGreat work! This code is ready to merge.',
    approve_with_suggestions:
      '✅ **Code Review: APPROVED with suggestions**\n\nThe code is good to merge, but consider these improvements:',
    request_changes:
      '🔄 **Code Review: CHANGES REQUESTED**\n\nPlease address the following issues:',
    needs_tests:
      '🧪 **Code Review: TESTS REQUIRED**\n\nThe code looks good but needs test coverage:',
    security_review: '🔒 **Code Review: SECURITY REVIEW NEEDED**\n\nSecurity concerns identified:'
  };

  feedback.push(headers[verdict.action] || headers.request_changes);

  // Add specific feedback based on issues
  if (analysis.potential_issues && analysis.potential_issues.length > 0) {
    feedback.push('\n### ⚠️ Potential Issues:');
    analysis.potential_issues.forEach(issue => {
      feedback.push(`- ${issue}`);
    });
  }

  // Add quality feedback
  if (quality.score < 0.7) {
    feedback.push('\n### 📊 Quality Concerns:');
    feedback.push(quality.reasoning);
  }

  // Add positive feedback
  if (quality.score > 0.8) {
    feedback.push('\n### 👍 Good Practices Observed:');
    if (analysis.test_coverage?.includes('included')) {
      feedback.push('- Tests included');
    }
    feedback.push('- Clean code structure');
    feedback.push('- Follows conventions');
  }

  // Add suggestions
  feedback.push('\n### 💡 Suggestions:');
  if (!analysis.test_coverage?.includes('included')) {
    feedback.push('- Consider adding unit tests');
  }
  if (analysis.dependencies_added?.length > 0) {
    feedback.push('- Document why new dependencies are needed');
  }
  if (analysis.breaking_changes?.length > 0) {
    feedback.push('- Update documentation for breaking changes');
    feedback.push('- Consider backward compatibility');
  }

  return feedback.join('\n');
}

/**
 * Generate review checklist
 */
function generateReviewChecklist(analysis, quality) {
  return {
    syntax: '✅ Syntax correct',
    logic: quality.score > 0.5 ? '✅ Logic appears sound' : '⚠️ Logic needs review',
    security: analysis.potential_issues?.some(i => i.includes('security'))
      ? '❌ Security issues found'
      : '✅ No obvious security issues',
    performance: '✅ No obvious performance issues',
    tests: analysis.test_coverage?.includes('included') ? '✅ Tests included' : '❌ Tests missing',
    documentation: '⚠️ Check if docs need update',
    dependencies:
      analysis.dependencies_added?.length > 0
        ? '⚠️ New dependencies added'
        : '✅ No new dependencies'
  };
}

// Example code changes to review
const codeExamples = [
  {
    name: 'Good Feature Addition',
    change: `
// Pull Request: Add user authentication
// Files changed: auth.js, user.model.js, auth.test.js

+ const bcrypt = require('bcrypt');
+ const jwt = require('jsonwebtoken');

+ async function authenticateUser(email, password) {
+   try {
+     const user = await User.findOne({ email });
+     if (!user) {
+       throw new Error('User not found');
+     }
+     
+     const isValid = await bcrypt.compare(password, user.hashedPassword);
+     if (!isValid) {
+       throw new Error('Invalid password');
+     }
+     
+     const token = jwt.sign(
+       { userId: user.id, email: user.email },
+       process.env.JWT_SECRET,
+       { expiresIn: '24h' }
+     );
+     
+     return { user, token };
+   } catch (error) {
+     logger.error('Authentication failed:', error);
+     throw error;
+   }
+ }

+ // Tests
+ describe('authenticateUser', () => {
+   it('should authenticate valid user', async () => {
+     const result = await authenticateUser('test@example.com', 'password123');
+     expect(result.token).toBeDefined();
+   });
+   
+   it('should reject invalid password', async () => {
+     await expect(authenticateUser('test@example.com', 'wrong'))
+       .rejects.toThrow('Invalid password');
+   });
+ });
`
  },

  {
    name: 'Security Issue',
    change: `
// Pull Request: Add database query function
// Files changed: database.js

+ function getUserData(userId) {
+   // Build SQL query
+   const query = "SELECT * FROM users WHERE id = " + userId;
+   
+   return database.query(query);
+ }

+ function searchProducts(searchTerm) {
+   const query = \`SELECT * FROM products WHERE name LIKE '%\${searchTerm}%'\`;
+   return database.query(query);
+ }

+ // No tests included
`
  },

  {
    name: 'Missing Tests',
    change: `
// Pull Request: Refactor payment processing
// Files changed: payment.js

- function processPayment(amount, cardNumber) {
-   // Old implementation
-   return stripe.charge(amount, cardNumber);
- }

+ async function processPayment(amount, paymentMethod, metadata = {}) {
+   try {
+     // Validate inputs
+     if (amount <= 0) {
+       throw new Error('Invalid amount');
+     }
+     
+     // Process with Stripe
+     const charge = await stripe.charges.create({
+       amount: amount * 100, // Convert to cents
+       currency: 'usd',
+       source: paymentMethod,
+       metadata
+     });
+     
+     // Log transaction
+     await logTransaction(charge.id, amount, metadata);
+     
+     return {
+       success: true,
+       transactionId: charge.id
+     };
+   } catch (error) {
+     await logError('Payment failed', error);
+     throw new Error('Payment processing failed');
+   }
+ }

// No test file included
`
  }
];

// Run the examples
async function runExamples() {
  for (const example of codeExamples) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 CODE REVIEW: ${example.name}`);
    console.log('='.repeat(60));

    try {
      const review = await reviewCode(example.change);

      console.log('\n📋 REVIEW FEEDBACK:');
      console.log('------------------');
      console.log(review.feedback);

      console.log('\n✓ Review Checklist:');
      Object.entries(review.checklist).forEach(([_item, status]) => {
        console.log(`  ${status}`);
      });
    } catch (error) {
      console.error('Error reviewing code:', error.message);
    }
  }
}

// Export for use
module.exports = { reviewCode };

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
