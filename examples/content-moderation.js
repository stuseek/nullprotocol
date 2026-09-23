/**
 * Real-World Example: Content Moderation System
 * Analyzes user-generated content for policy violations
 */

const AIToolkit = require('../src/index');

// Initialize with executor for taking action
const ai = new AIToolkit({
  engines: {
    openai: process.env.OPENAI_API_KEY
  },
  withExecutor: true,
  validateOutputs: true
});

// Register moderation actions
ai.registerAction(
  'approve_content',
  async params => {
    console.log(`✅ Content approved: ${params.contentId}`);
    // In production: Update database, publish content
    return { status: 'published', contentId: params.contentId };
  },
  {
    description: 'Approve and publish content',
    parameters: { contentId: 'string' }
  }
);

ai.registerAction(
  'flag_for_review',
  async params => {
    console.log(`🚩 Flagged for human review: ${params.contentId}`);
    console.log(`Reason: ${params.reason}`);
    // In production: Add to review queue, notify moderators
    return { status: 'queued', contentId: params.contentId };
  },
  {
    description: 'Flag content for human review',
    parameters: { contentId: 'string', reason: 'string' }
  }
);

ai.registerAction(
  'auto_reject',
  async params => {
    console.log(`❌ Content rejected: ${params.contentId}`);
    console.log(`Violations: ${params.violations.join(', ')}`);
    // In production: Delete/hide content, notify user
    return { status: 'rejected', contentId: params.contentId };
  },
  {
    description: 'Automatically reject content',
    parameters: { contentId: 'string', violations: 'array' }
  }
);

ai.registerAction(
  'shadow_ban',
  async params => {
    console.log(`👻 Shadow banned: ${params.contentId}`);
    // In production: Hide from others but visible to author
    return { status: 'shadow_banned', contentId: params.contentId };
  },
  {
    description: 'Shadow ban content',
    parameters: { contentId: 'string' }
  }
);

/**
 * Moderate user-generated content
 */
async function moderateContent(content, metadata = {}) {
  console.log('\n🛡️ Content Moderation Analysis\n');
  console.log('Content preview:', `${content.substring(0, 100)}...\n`);

  // Step 1: Extract content characteristics
  console.log('1️⃣ Analyzing content...');
  const analysis = await ai.extract(content, {
    content_type: {
      type: 'string',
      description: 'text, link, image_description, video_transcript'
    },
    topics: {
      type: 'array',
      description: 'main topics discussed'
    },
    sentiment: {
      type: 'string',
      description: 'positive, negative, neutral, aggressive'
    },
    target_audience: {
      type: 'string',
      description: 'general, children, adults'
    },
    contains_personal_info: {
      type: 'boolean',
      description: 'contains PII like phone, email, address'
    },
    promotional_content: {
      type: 'boolean',
      description: 'appears to be spam or advertising'
    },
    controversial_topics: {
      type: 'array',
      description: 'politics, religion, violence, adult content'
    },
    potential_violations: {
      type: 'array',
      description: 'hate_speech, harassment, spam, violence, adult_content, misinformation'
    },
    external_links: {
      type: 'array',
      description: 'any external URLs'
    },
    language_quality: {
      type: 'string',
      description: 'high, medium, low, gibberish'
    }
  });

  console.log('Analysis:', JSON.stringify(analysis.data, null, 2));

  // Step 2: Validate against community guidelines
  console.log('\n2️⃣ Checking community guidelines...');
  const guidelinesCheck = await ai.validate(
    'Does this content comply with community guidelines and is it safe for the platform?',
    analysis.data,
    {
      guidelines: [
        'No hate speech or discrimination',
        'No harassment or bullying',
        'No violence or graphic content',
        'No adult or sexual content',
        'No spam or misleading content',
        'No sharing of personal information',
        'No copyright infringement',
        'No dangerous misinformation',
        'Respectful discourse',
        'Age-appropriate content'
      ]
    }
  );

  console.log(`Compliance Score: ${(guidelinesCheck.score * 100).toFixed(1)}%`);
  console.log(`Assessment: ${guidelinesCheck.reasoning}`);

  // Step 3: Generate moderation summary
  console.log('\n3️⃣ Creating moderation summary...');
  const summary = await ai.summarize(
    {
      content_preview: content.substring(0, 200),
      analysis: analysis.data,
      compliance: guidelinesCheck
    },
    {
      maxLength: 100,
      focus: 'key_concerns_and_violations'
    }
  );

  console.log('Summary:', summary.summary);

  // Step 4: Decide on moderation action
  console.log('\n4️⃣ Determining action...');
  const decision = await ai.decide(
    {
      violations: analysis.data.potential_violations,
      compliance_score: guidelinesCheck.score,
      sentiment: analysis.data.sentiment,
      user_history: metadata.userHistory || 'first_time_poster',
      content_type: analysis.data.content_type
    },
    ai.executor.getAvailableActions()
  );

  console.log(`\n⚡ Action: ${decision.action.replace(/_/g, ' ').toUpperCase()}`);
  console.log(`Reasoning: ${decision.reasoning}`);
  console.log(`Confidence: ${(decision.confidence * 100).toFixed(1)}%`);

  // Step 5: Execute the moderation action
  console.log('\n5️⃣ Executing action...');
  const executionResult = await ai.execute({
    ...decision,
    parameters: {
      contentId: metadata.contentId || `content_${Date.now()}`,
      violations: analysis.data.potential_violations || [],
      reason: guidelinesCheck.reasoning
    }
  });

  console.log('Execution result:', executionResult);

  // Generate detailed report
  return {
    contentId: metadata.contentId,
    analysis: analysis.data,
    compliance: {
      score: guidelinesCheck.score,
      passed: guidelinesCheck.score > 0.7,
      reasoning: guidelinesCheck.reasoning
    },
    action: {
      taken: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      executed: executionResult.success
    },
    summary: summary.summary,
    recommendations: generateRecommendations(analysis.data, guidelinesCheck),
    userFeedback: generateUserFeedback(decision.action, analysis.data)
  };
}

/**
 * Generate recommendations for content improvement
 */
function generateRecommendations(analysis, compliance) {
  const recommendations = [];

  if (analysis.sentiment === 'aggressive') {
    recommendations.push('Consider using more constructive language');
  }

  if (analysis.contains_personal_info) {
    recommendations.push('Remove personal information before posting');
  }

  if (analysis.promotional_content) {
    recommendations.push('Review our guidelines on promotional content');
  }

  if (analysis.language_quality === 'low') {
    recommendations.push('Improve grammar and clarity for better engagement');
  }

  if (compliance.score < 0.5) {
    recommendations.push('Please review our community guidelines');
  }

  return recommendations;
}

/**
 * Generate user-facing feedback message
 */
function generateUserFeedback(action, analysis) {
  const messages = {
    approve_content: 'Your content has been published successfully!',

    flag_for_review: 'Your content is under review. This usually takes 2-4 hours.',

    auto_reject: `Your content violates our community guidelines${
      analysis.potential_violations?.length > 0
        ? `: ${analysis.potential_violations.join(', ')}`
        : ''
    }. Please review our guidelines and try again.`,

    shadow_ban: 'Your content has been posted.'
  };

  return messages[action] || 'Your content is being processed.';
}

// Test cases
const testContent = [
  {
    name: 'Normal Post',
    content: `Just wanted to share my experience with the new iPhone 15. 
    The camera is amazing and the battery life is much better than my old phone. 
    Really happy with the upgrade! Anyone else made the switch? 
    What are your thoughts? #iPhone15 #TechReview`,
    metadata: {
      contentId: 'post_001',
      userHistory: 'trusted_user'
    }
  },

  {
    name: 'Spam/Promotional',
    content: `🔥🔥 AMAZING DEAL!!! 🔥🔥
    
    Click here -> bit.ly/definitely-not-spam
    Make $5000 per week from home!!!
    
    Limited time offer! Only 10 spots left!
    
    Contact me: totallylegit@notascam.com
    WhatsApp: +1-555-SCAMMER
    
    HURRY!!! Don't miss out!!! 💰💰💰`,
    metadata: {
      contentId: 'post_002',
      userHistory: 'new_user'
    }
  },

  {
    name: 'Hate Speech',
    content: `I can't stand people from [specific group]. They're all the same - 
    lazy, dishonest, and ruining our country. We should ban them all.
    They don't deserve the same rights as us normal people.
    
    Anyone who disagrees is an idiot.`,
    metadata: {
      contentId: 'post_003',
      userHistory: 'previously_warned'
    }
  },

  {
    name: 'Borderline Content',
    content: `The government is lying to us about everything. 
    Don't trust what they tell you about vaccines or climate change.
    Do your own research! I found this article that proves everything: 
    [suspicious link]. Wake up people!
    
    Share this before they delete it!`,
    metadata: {
      contentId: 'post_004',
      userHistory: 'frequent_poster'
    }
  }
];

// Run examples
async function runExamples() {
  for (const test of testContent) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 CONTENT: ${test.name}`);
    console.log('='.repeat(60));

    try {
      const result = await moderateContent(test.content, test.metadata);

      console.log('\n📋 MODERATION REPORT:');
      console.log('--------------------');
      console.log(`Content ID: ${result.contentId}`);
      console.log(`Compliance: ${result.compliance.passed ? '✅ Passed' : '❌ Failed'}`);
      console.log(`Action Taken: ${result.action.taken.replace(/_/g, ' ').toUpperCase()}`);
      console.log(`\nUser Message: "${result.userFeedback}"`);

      if (result.recommendations.length > 0) {
        console.log('\nRecommendations:');
        result.recommendations.forEach(rec => {
          console.log(`  • ${rec}`);
        });
      }
    } catch (error) {
      console.error('Error moderating content:', error.message);
    }
  }
}

// Export
module.exports = { moderateContent };

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
