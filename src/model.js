// One way to call a model, whatever its provider. The provider's own request
// shape stays in this file.

const { Resilience } = require('./resilience');

const PROVIDERS = {
  openai: { keyEnv: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', endpoint: 'https://api.anthropic.com/v1' },
  'openai-compatible': {}
};

// Claude 4.7 and later reject sampling parameters. Only these released
// families accept temperature; any other model gets none.
const SAMPLING_MODELS = /^claude-(3-|haiku-4-5|sonnet-4-(5|6|20)|opus-4-(0|1|5|6|20))/;

// Checks the settings and credentials for one provider and model. A cloud key
// is read only from its own provider's variable, and a cloud provider never
// takes another address.
function modelSettings({ provider, model, apiKey, baseURL }) {
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(
      `Unknown provider ${JSON.stringify(provider)}. Use openai, anthropic or openai-compatible.`
    );
  }
  const spec = PROVIDERS[provider];
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`provider ${provider} needs model, the name of the model to call`);
  }
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) {
    throw new Error('apiKey must be a nonempty string');
  }
  if (spec.keyEnv) {
    if (baseURL !== undefined) {
      throw new Error(
        `baseURL is not used with provider ${provider}. For another server that speaks the OpenAI API, use provider openai-compatible.`
      );
    }
    const key = apiKey ?? process.env[spec.keyEnv];
    if (!key) throw new Error(`provider ${provider} needs apiKey or ${spec.keyEnv}`);
    return { provider, model, apiKey: key, baseURL: spec.endpoint };
  }
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      'provider openai-compatible needs baseURL, the http(s) address of your server, such as http://localhost:11434/v1 for Ollama'
    );
  }
  return { provider, model, apiKey, baseURL: baseURL.replace(/\/+$/, '') };
}

function failed(code, message, status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}

async function post(url, headers, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Reported below with the status.
  }
  if (!response.ok) {
    const detail = json?.error?.message || json?.error || text.slice(0, 200);
    throw failed(
      response.status === 429 ? 'rate_limited' : 'provider_error',
      `The model provider answered ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
      response.status
    );
  }
  if (!json) throw failed('provider_error', 'The model provider did not answer with JSON');
  return json;
}

const count = value => (Number.isSafeInteger(value) ? value : null);

// A refused or cut-off reply is not an answer; the operations are bounded
// single calls, so they reject it instead of returning partial text.
async function openaiTurn(settings, options, system, turns, signal) {
  const hosted = settings.provider === 'openai';
  const temperature = options.temperature ?? (hosted ? undefined : 0.3);
  const reply = await post(
    `${settings.baseURL}/chat/completions`,
    settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    {
      model: settings.model,
      messages: [{ role: 'system', content: system }, ...turns],
      // OpenAI's own API names the limit max_completion_tokens; servers that
      // copy the older API know only max_tokens.
      [hosted ? 'max_completion_tokens' : 'max_tokens']: options.maxTokens ?? 1000,
      ...(temperature === undefined ? {} : { temperature })
    },
    signal
  );
  const choice = reply.choices?.[0];
  if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') {
    throw failed('provider_error', `The model's reply is incomplete: ${choice.finish_reason}`);
  }
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw failed('provider_error', "The model's reply has no text");
  }
  return {
    text,
    inputTokens: count(reply.usage?.prompt_tokens),
    outputTokens: count(reply.usage?.completion_tokens)
  };
}

async function anthropicTurn(settings, options, system, turns, signal) {
  const reply = await post(
    `${settings.baseURL}/messages`,
    { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: settings.model,
      system,
      messages: turns,
      max_tokens: options.maxTokens ?? 1000,
      ...(SAMPLING_MODELS.test(settings.model) ? { temperature: options.temperature ?? 0.3 } : {})
    },
    signal
  );
  if (
    ['refusal', 'max_tokens', 'model_context_window_exceeded', 'pause_turn'].includes(
      reply.stop_reason
    )
  ) {
    throw failed('provider_error', `The model's reply is incomplete: ${reply.stop_reason}`);
  }
  // A reply can open with thinking blocks, so the text blocks are joined.
  const text = (reply.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  if (!text.trim()) throw failed('provider_error', "The model's reply has no text");
  return {
    text,
    inputTokens: count(reply.usage?.input_tokens),
    outputTokens: count(reply.usage?.output_tokens)
  };
}

/**
 * A model to ask: `complete(system, turns)` returns the reply text and its
 * token counts. `given` holds provider, model and that provider's credentials;
 * `options` the call settings: timeout, retry, circuitBreaker, temperature, maxTokens.
 */
function createModel(given, options = {}) {
  const settings = modelSettings(given);
  const resilience = new Resilience({
    maxRetries: options.retry?.maxRetries ?? 2,
    timeout: options.timeout ?? 30000,
    circuitBreakerThreshold: options.circuitBreaker?.threshold ?? 5,
    circuitBreakerResetMs: options.circuitBreaker?.resetAfterMs ?? 60000
  });
  const turn = settings.provider === 'anthropic' ? anthropicTurn : openaiTurn;
  return {
    provider: settings.provider,
    model: settings.model,
    complete: (system, turns) =>
      resilience.execute(signal => turn(settings, options, system, turns, signal))
  };
}

module.exports = { createModel, modelSettings };
