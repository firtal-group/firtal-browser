const {
  rewriteCdpJson,
  renderRemoteIndex,
  buildRemoteCdpUrl,
  buildRemoteDevtoolsUrl
} = require('../../src/authProxy');

function request(headers = {}) {
  return {
    headers: {
      host: 'remote.example.test',
      'x-forwarded-proto': 'https',
      ...headers
    }
  };
}

describe('auth proxy remote CDP URLs', () => {
  test('rewrites websocket debugger URLs to the remote tunnel host with token', () => {
    const rewritten = buildRemoteCdpUrl(
      request(),
      'ws://localhost:9332/devtools/page/ABC',
      'secret'
    );

    expect(rewritten).toBe('wss://remote.example.test/devtools/page/ABC?token=secret');
  });

  test('rewrites devtools frontend URLs to use a remote-compatible ws target', () => {
    const rewritten = buildRemoteDevtoolsUrl(request(), { id: 'ABC' }, 'secret');

    expect(rewritten).toBe('/devtools/inspector.html?ws=remote.example.test%2Fdevtools%2Fpage%2FABC%3Ftoken%3Dsecret');
  });

  test('rewrites json/list targets for remote devices', () => {
    const payload = [
      {
        id: 'ABC',
        type: 'page',
        title: 'Example',
        webSocketDebuggerUrl: 'ws://localhost:9332/devtools/page/ABC',
        devtoolsFrontendUrl: '/devtools/inspector.html?ws=localhost:9332/devtools/page/ABC'
      }
    ];

    const rewritten = rewriteCdpJson(request(), payload, 'secret');

    expect(rewritten[0].webSocketDebuggerUrl).toBe('wss://remote.example.test/devtools/page/ABC?token=secret');
    expect(rewritten[0].devtoolsFrontendUrl).toContain('remote.example.test');
    expect(rewritten[0].devtoolsFrontendUrl).toContain('token%3Dsecret');
  });

  test('remote index links to interactive page targets', () => {
    const html = renderRemoteIndex({
      token: 'secret',
      targets: rewriteCdpJson(request(), [
        {
          id: 'ABC',
          type: 'page',
          title: 'Login',
          url: 'https://example.com/login',
          webSocketDebuggerUrl: 'ws://localhost:9332/devtools/page/ABC'
        }
      ], 'secret')
    });

    expect(html).toContain('Firtal Browser Remote');
    expect(html).toContain('Login');
    expect(html).toContain('/devtools/inspector.html');
  });
});
