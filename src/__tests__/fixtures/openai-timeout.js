// One connectOpenAI call that runs into the OpenAI client's own timeout, run as a
// plain Node process. Under Jest, openai 7 loses the cross-realm AbortError and
// reports the timeout as a connection error; plain Node preserves it. Prints what
// the caller got, what was recorded and whether the model connection was closed.
const http = require('http');
const https = require('https');
const OpenAI = require('openai');
const { connectOpenAI } = require('../../../openai');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function main() {
  let modelClosed;
  const closed = new Promise(resolve => {
    modelClosed = resolve;
  });
  const model = http.createServer((req, res) => {
    req.resume();
    res.on('close', () => modelClosed(!res.writableEnded));
    setTimeout(() => res.destroyed || res.end('{}'), 300);
  });
  const events = [];
  const collector = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    events.push(...JSON.parse(body).events);
    res.end('{}');
  });
  await Promise.all([listen(model), listen(collector)]);
  // Telemetry requires HTTPS; it goes to the local collector over HTTP instead.
  https.request = (options, onResponse) =>
    http.request({ ...options, hostname: '127.0.0.1', port: collector.address().port }, onResponse);
  try {
    const client = new OpenAI({
      apiKey: 'test',
      baseURL: `http://127.0.0.1:${model.address().port}/v1`,
      timeout: 50,
      maxRetries: 0
    });
    const chat = connectOpenAI(client, {
      agentId: 'support',
      telemetryKey: 'ingest-key',
      telemetryEndpoint: 'https://telemetry.test'
    });
    const error = await chat
      .create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'Where is order 42?' }]
      })
      .catch(caught => caught);
    await chat.close();
    process.stdout.write(
      JSON.stringify({
        error: error?.constructor?.name,
        timeoutError: error instanceof OpenAI.APIConnectionTimeoutError,
        modelClosedEarly: await closed,
        calls: events.map(({ event, data }) => ({
          event,
          success: data.success,
          errorCode: data.errorCode
        }))
      })
    );
  } finally {
    for (const server of [model, collector]) {
      server.close();
      server.closeAllConnections();
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
