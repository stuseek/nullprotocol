/**
 * v1.1 Features: resilience, tool use, streaming, history, model routing
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... node examples/resilience-and-tools.js
 */

const { AIToolkit, CircuitBreakerError } = require('../src/index');

// --- Setup with all new config options ---

const ai = new AIToolkit({
  engines: { anthropic: process.env.ANTHROPIC_API_KEY },
  defaultEngine: 'anthropic',

  // Model aliases — use 'fast' or 'powerful' instead of full model IDs
  models: {
    anthropic: 'claude-sonnet-4-5-20250929',
    fast: 'claude-haiku-4-5-20251001',
    powerful: 'claude-opus-4-20250514'
  },

  // Resilience
  retry: { maxRetries: 2 },
  timeout: 30000,
  circuitBreaker: { threshold: 5, resetAfterMs: 60000 },

  // Conversation history
  trackHistory: true,
  maxHistoryTokens: 20000
});

// --- 1. Model routing ---

async function modelRoutingDemo() {
  console.log('=== Model Routing ===\n');

  // Use the fast model for quick decisions
  const decision = await ai.decide(
    { cpu: 95, memory: 80, errors: 12 },
    ['scale_up', 'restart', 'alert_only', 'ignore'],
    { model: 'fast' }
  );
  console.log('Fast decision:', decision.action, `(${decision.confidence})`);

  // Use the default model for extraction
  const extracted = await ai.extract(
    'Server us-east-1a is at 95% CPU, 12 errors in the last 5 minutes',
    { region: 'string', cpu: 'number', errorCount: 'number', timeWindow: 'string' }
  );
  console.log('Extracted:', extracted.data);
}

// --- 2. Conversation history ---

async function conversationDemo() {
  console.log('\n=== Conversation History ===\n');

  // trackHistory is on — chat() auto-tracks messages
  await ai.chat('I am investigating a SQL injection on /api/users?id=1');
  const r = await ai.chat('What endpoint am I looking at?');
  console.log('AI remembers:', r.message);

  console.log('History length:', ai.getHistory().length, 'messages');
  ai.clearHistory();
}

// --- 3. Tool use ---

async function toolUseDemo() {
  console.log('\n=== Tool Use ===\n');

  const result = await ai.chat('Look up the CVE for log4shell and tell me the CVSS score', {
    tools: [
      {
        name: 'lookup_cve',
        description: 'Look up a CVE by ID or keyword',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'CVE ID or search term' }
          },
          required: ['query']
        }
      }
    ],
    onToolCall: async (name, params) => {
      console.log(`  [tool called: ${name}(${JSON.stringify(params)})]`);
      // Simulated response
      return {
        id: 'CVE-2021-44228',
        name: 'Log4Shell',
        cvss: 10.0,
        severity: 'CRITICAL',
        description: 'Remote code execution in Apache Log4j2'
      };
    },
    trackHistory: false // one-off, don't track
  });

  console.log('Response:', result.message);
  console.log('Tool calls made:', result.toolCalls?.length || 0);
}

// --- 4. Resilience / circuit breaker ---

async function resilienceDemo() {
  console.log('\n=== Resilience ===\n');

  console.log('Circuit breaker state:', ai.resilience.getStats());

  // The resilience layer handles retries transparently.
  // If you need to catch circuit breaker trips:
  try {
    await ai.chat('ping');
    console.log('Request succeeded');
  } catch (err) {
    if (err instanceof CircuitBreakerError) {
      console.log('Circuit breaker is open:', err.message);
    } else {
      console.log('Other error:', err.message);
    }
  }

  console.log('Stats after request:', ai.resilience.getStats());
}

// --- 5. Streaming ---

async function streamingDemo() {
  console.log('\n=== Streaming ===\n');

  // Collect mode — get a normal result after streaming completes
  const result = await ai.chat('List 3 common web vulnerabilities, one line each', {
    stream: true,
    collect: true,
    trackHistory: false
  });
  console.log(result.message);
}

// --- Run all demos ---

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Set ANTHROPIC_API_KEY to run this demo');
    console.log('  ANTHROPIC_API_KEY=sk-ant-... node examples/resilience-and-tools.js');
    return;
  }

  await modelRoutingDemo();
  await conversationDemo();
  await toolUseDemo();
  await resilienceDemo();
  await streamingDemo();
}

main().catch(console.error);
