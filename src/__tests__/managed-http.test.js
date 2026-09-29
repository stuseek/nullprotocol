const { PlatformTransport, PlatformError } = require('../managed-http');

test('sends the Space key only to the configured HTTPS origin', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(
    new globalThis.Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
  const transport = new PlatformTransport({
    endpoint: 'https://api.example.test',
    key: 'np_space_test',
    fetchImpl
  });
  await expect(
    transport.request('POST', '/v1/space', {
      body: { hello: 'world' },
      headers: { Authorization: 'Bearer attacker', 'Idempotency-Key': 'event-1' }
    })
  ).resolves.toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://api.example.test/v1/space',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ hello: 'world' }),
      headers: expect.any(globalThis.Headers)
    })
  );
  expect(fetchImpl.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer np_space_test');
  expect(fetchImpl.mock.calls[0][1].headers.get('Idempotency-Key')).toBe('event-1');
  await expect(transport.request('GET', '//other.example.test/secret')).rejects.toThrow(
    'Platform path'
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('uses NULLPROTOCOL_API_URL when no endpoint is passed', () => {
  const saved = process.env.NULLPROTOCOL_API_URL;
  try {
    delete process.env.NULLPROTOCOL_API_URL;
    expect(new PlatformTransport({ key: 'np_space_test' }).origin).toBe(
      'https://api.nullprotocol.ai'
    );
    process.env.NULLPROTOCOL_API_URL = 'https://staging.example.test';
    expect(new PlatformTransport({ key: 'np_space_test' }).origin).toBe(
      'https://staging.example.test'
    );
    expect(
      new PlatformTransport({ key: 'np_space_test', endpoint: 'https://api.example.test' }).origin
    ).toBe('https://api.example.test');
  } finally {
    if (saved === undefined) delete process.env.NULLPROTOCOL_API_URL;
    else process.env.NULLPROTOCOL_API_URL = saved;
  }
});

test('rejects insecure endpoint before any request', () => {
  expect(() => new PlatformTransport({ endpoint: 'http://api.example.test', key: 'test' })).toThrow(
    'HTTPS'
  );
  expect(
    () => new PlatformTransport({ endpoint: 'https://api.example.test/path', key: 'test' })
  ).toThrow('origin');
  expect(
    () => new PlatformTransport({ endpoint: 'http://localhost:3000', key: 'test' })
  ).not.toThrow();
});

test('returns a typed platform error without exposing response text or credentials', async () => {
  const transport = new PlatformTransport({
    key: 'np_space_secret',
    fetchImpl: async () =>
      new globalThis.Response(JSON.stringify({ error: 'agent_not_found', private: 'sensitive' }), {
        status: 404
      })
  });
  await expect(
    transport.request('GET', '/v1/spaces/demo/managed-agents/nope')
  ).rejects.toMatchObject({ name: 'PlatformError', code: 'agent_not_found', status: 404 });
  try {
    await transport.request('GET', '/v1/spaces/demo/managed-agents/nope');
  } catch (error) {
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('sensitive');
  }
});

test('bounds response size even without Content-Length', async () => {
  const transport = new PlatformTransport({
    key: 'np_space_test',
    fetchImpl: async () => new globalThis.Response('x'.repeat(1024 * 1024 + 1), { status: 200 })
  });
  await expect(transport.request('GET', '/v1/space')).rejects.toMatchObject({
    code: 'response_too_large'
  });
});

test('does not retry a failed write and maps a network failure', async () => {
  const fetchImpl = jest
    .fn()
    .mockRejectedValue(new Error('provider secret inside transport error'));
  const transport = new PlatformTransport({ key: 'np_space_test', fetchImpl });
  await expect(
    transport.request('POST', '/v1/spaces/demo/templates', { body: { name: 'X' } })
  ).rejects.toMatchObject({ code: 'platform_unavailable', status: 0 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('invalid JSON body fails before sending the request', async () => {
  const fetchImpl = jest.fn();
  const body = {};
  body.self = body;
  const transport = new PlatformTransport({ key: 'np_space_test', fetchImpl });
  await expect(transport.request('POST', '/v1/space', { body })).rejects.toBeInstanceOf(
    PlatformError
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('preserves whitelisted conflict details and retry delay', async () => {
  const transport = new PlatformTransport({
    key: 'np_space_test',
    fetchImpl: async () =>
      new globalThis.Response(
        JSON.stringify({
          error: 'template_version_conflict',
          latestVersion: 4,
          secret: 'do-not-copy'
        }),
        { status: 409, headers: { 'Retry-After': '3' } }
      )
  });
  await expect(
    transport.request('POST', '/v1/spaces/demo/templates/t/versions', { body: {} })
  ).rejects.toMatchObject({
    code: 'template_version_conflict',
    status: 409,
    details: { latestVersion: 4 },
    retryAfter: 3
  });
});

test('preserves typed quota details while discarding unrelated response fields', async () => {
  const transport = new PlatformTransport({
    key: 'np_space_test',
    fetchImpl: async () =>
      new globalThis.Response(
        JSON.stringify({
          error: 'quota_exceeded',
          resource: 'storageBytes',
          limit: 1024,
          used: 1000,
          private: 'not copied'
        }),
        { status: 409 }
      )
  });
  await expect(
    transport.request('POST', '/v1/spaces/demo/managed-agents/a/runs')
  ).rejects.toMatchObject({
    code: 'quota_exceeded',
    details: { resource: 'storageBytes', limit: 1024, used: 1000 }
  });
});

test('reports a platform timeout without retrying the request', async () => {
  const fetchImpl = jest.fn(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('timed out')), {
          once: true
        });
      })
  );
  const transport = new PlatformTransport({ key: 'np_space_test', fetchImpl, timeoutMs: 5 });
  await expect(transport.request('GET', '/v1/space')).rejects.toMatchObject({
    code: 'platform_timeout',
    status: 0
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
