/**
 * Basic Usage Example for ai-toolkit
 */

const AIToolkit = require('../src/index');

async function main() {
  // Initialize the toolkit
  const ai = new AIToolkit({
    engines: {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY
    },
    defaultEngine: 'openai'
  });

  // Example 1: Extract structured data from text
  console.log('=== EXTRACT Example ===');
  const newsArticle = `
    Breaking News: Tech Corp announces new AI product priced at $299.
    The product features advanced machine learning, natural language processing,
    and computer vision capabilities. CEO Jane Doe says this will revolutionize
    the industry. Available starting next month.
  `;

  const extracted = await ai.extract(newsArticle, {
    headline: { type: 'string', required: true },
    price: { type: 'number', required: true },
    features: { type: 'array', required: false },
    availability: { type: 'string', required: false },
    spokesperson: { type: 'string', required: false }
  });

  console.log('Extracted:', extracted.data);
  console.log('Confidence:', extracted.confidence);

  // Example 2: Validate the extracted data
  console.log('\n=== VALIDATE Example ===');
  const validation = await ai.validate(
    'Check if this is a reasonably priced AI product with good features',
    extracted.data
  );

  console.log('Validation Score:', validation.score);
  console.log('Reasoning:', validation.reasoning);
  console.log('Recommendation:', validation.recommendation);

  // Example 3: Summarize the validation results
  console.log('\n=== SUMMARIZE Example ===');
  const summary = await ai.summarize(validation, {
    maxLength: 150,
    focus: 'investment_decision',
    format: 'concise'
  });

  console.log('Summary:', summary.summary);
  console.log('Key Points:', summary.keyPoints);

  // Example 4: Make a decision
  console.log('\n=== DECIDE Example ===');
  const decision = await ai.decide(
    {
      product: extracted.data,
      validation: validation,
      summary: summary
    },
    ['buy_now', 'wait_for_reviews', 'skip', 'research_competitors']
  );

  console.log('Decision:', decision.action);
  console.log('Reasoning:', decision.reasoning);
  console.log('Confidence:', decision.confidence);
  console.log('Alternatives:', decision.alternatives);

  // Example 5: Complete workflow
  console.log('\n=== WORKFLOW Example ===');
  const pipeline = ai.pipeline(
    async input =>
      ai.extract(input, {
        product: 'string',
        price: 'number',
        value_proposition: 'string'
      }),
    async result => ai.validate('Is this a good investment?', result.data),
    async result => ai.summarize(result),
    async result => ai.decide(result, ['invest', 'pass', 'investigate_further'])
  );

  const workflowResult = await pipeline(newsArticle);
  console.log('Final Decision:', workflowResult.action);
  console.log('Reasoning:', workflowResult.reasoning);
}

// Run the examples
main().catch(console.error);
