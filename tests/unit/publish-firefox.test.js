/** @jest-environment node */

import { createHash, createHmac } from 'node:crypto';
import { jest } from '@jest/globals';
import { createAmoJwt, parseArgs, publishRelease } from '../../scripts/publish-firefox.mjs';

const RELEASE_TAG = 'v0.2.3';
const VERSION = '0.2.3';
const ADDON_GUID = 'screensilo@subagentura.tech';
const ADDON_SLUG = 'screensilo';
const RELEASE_SHA = '1111111111111111111111111111111111111111';
const MASTER_SHA = '2222222222222222222222222222222222222222';
const ASSET_BASE = 'https://api.github.com/repos/lmn451/screencast/releases/assets';
const AMO_BASE = 'https://addons.mozilla.org/api/v5';
const AMO_SECRET = 'amo-test-secret';
const AMO_ISSUER = 'user:18664816:23';

function makeStoredZip(filename, content) {
  const filenameBytes = Buffer.from(filename);
  const contentBytes = Buffer.from(content);
  const local = Buffer.alloc(30 + filenameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(contentBytes.length, 18);
  local.writeUInt32LE(contentBytes.length, 22);
  local.writeUInt16LE(filenameBytes.length, 26);
  filenameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + filenameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(contentBytes.length, 20);
  central.writeUInt32LE(contentBytes.length, 24);
  central.writeUInt16LE(filenameBytes.length, 28);
  filenameBytes.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + contentBytes.length, 16);
  return Buffer.concat([local, contentBytes, central, end]);
}

function streamBody(bytes) {
  let consumed = false;
  return {
    getReader() {
      return {
        async read() {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: new Uint8Array(bytes) };
        },
        releaseLock() {},
      };
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    async json() {
      return body;
    },
  };
}

function jsonFailureResponse(error) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      throw error;
    },
  };
}

function bytesResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => String(bytes.length) },
    body: streamBody(bytes),
  };
}

function options(extraArgs = []) {
  return parseArgs(['--tag', RELEASE_TAG, '--max-retries', '0', ...extraArgs], {
    GITHUB_REPOSITORY: 'lmn451/screencast',
  });
}

function manifestZip(guid = ADDON_GUID, version = VERSION) {
  return makeStoredZip(
    'manifest.json',
    JSON.stringify({
      manifest_version: 3,
      name: 'ScreenSilo',
      version,
      browser_specific_settings: { gecko: { id: guid } },
    })
  );
}

function assetChecksums(zip, source) {
  return Buffer.from(
    createHash('sha256').update(zip).digest('hex') +
      '  screensilo-firefox-mv3-' +
      VERSION +
      '.zip\n' +
      createHash('sha256').update(source).digest('hex') +
      '  screensilo-firefox-source-' +
      VERSION +
      '.zip\n'
  );
}

function githubResponses(zip, source, checksum) {
  return {
    release: {
      tag_name: RELEASE_TAG,
      draft: false,
      prerelease: false,
      published_at: '2026-09-01T00:00:00Z',
      assets: [
        {
          name: 'screensilo-firefox-mv3-' + VERSION + '.zip',
          state: 'uploaded',
          url: ASSET_BASE + '/1',
        },
        {
          name: 'screensilo-firefox-source-' + VERSION + '.zip',
          state: 'uploaded',
          url: ASSET_BASE + '/2',
        },
        { name: 'SHA256SUMS', state: 'uploaded', url: ASSET_BASE + '/3' },
      ],
    },
    tagRef: { object: { type: 'commit', sha: RELEASE_SHA } },
    masterRef: { object: { type: 'commit', sha: MASTER_SHA } },
    compare: { status: 'ahead' },
    runs: {
      workflow_runs: [
        {
          id: 34588677228,
          head_sha: RELEASE_SHA,
          head_branch: 'master',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
    zip,
    source,
    checksum,
  };
}

function githubReply(url, data) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith('/releases/tags/' + RELEASE_TAG)) return jsonResponse(data.release);
  if (path.endsWith('/git/ref/tags/' + RELEASE_TAG)) return jsonResponse(data.tagRef);
  if (path.endsWith('/git/ref/heads/master')) return jsonResponse(data.masterRef);
  if (path.includes('/compare/')) return jsonResponse(data.compare);
  if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(data.runs);
  if (path.endsWith('/releases/assets/1')) return bytesResponse(data.zip);
  if (path.endsWith('/releases/assets/2')) return bytesResponse(data.source);
  if (path.endsWith('/releases/assets/3')) return bytesResponse(data.checksum);
  return null;
}

function addonPath() {
  return '/addons/addon/' + ADDON_GUID;
}

function versionDetail(packageBytes, { id = 777, source = true, status = 'unreviewed' } = {}) {
  const detail = {
    id,
    version: VERSION,
    channel: 'listed',
    status,
    file: {
      hash: 'sha256:' + createHash('sha256').update(packageBytes).digest('hex'),
      status,
    },
  };
  if (source) detail.source = AMO_BASE + '/source/' + id;
  return detail;
}

function existingAddon() {
  return {
    id: 3054016,
    slug: ADDON_SLUG,
    guid: ADDON_GUID,
    status: 'public',
    version: {
      version: '0.2.2',
      file: { status: 'public' },
    },
  };
}

function amoPath(url) {
  return decodeURIComponent(new URL(url).pathname)
    .replace(/^\/api\/v5/, '')
    .replace(/\/+$/, '');
}

function makeFetch(data, amoHandler, calls) {
  return jest.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const github = githubReply(url, data);
    if (github) return github;
    return amoHandler(url, init);
  });
}

function baseEnvironment() {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/master',
    GITHUB_TOKEN: 'github-secret',
    AMO_JWT_ISSUER: AMO_ISSUER,
    AMO_JWT_SECRET: AMO_SECRET,
  };
}

describe('publish-firefox script', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses the fixed add-on target and rejects unknown endpoint options', () => {
    expect(options()).toMatchObject({
      tag: RELEASE_TAG,
      repository: 'lmn451/screencast',
      addonGuid: ADDON_GUID,
    });
    expect(() => parseArgs(['--tag', RELEASE_TAG, '--amo-base-url', 'https://evil.test'])).toThrow(
      'Unknown option'
    );
    expect(() => parseArgs(['--tag', 'release-latest'])).toThrow('release tag');
  });

  it('creates an HS256 JWT with bounded expiry and a verifiable signature', () => {
    const issuedAt = 1_700_000_000;
    const token = createAmoJwt(AMO_ISSUER, AMO_SECRET, issuedAt);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload).toMatchObject({ iss: AMO_ISSUER, iat: issuedAt });
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.exp).toBeGreaterThan(issuedAt);
    expect(payload.exp).toBeLessThanOrEqual(issuedAt + 300);

    const signature = createHmac('sha256', AMO_SECRET)
      .update(parts[0] + '.' + parts[1])
      .digest('base64url');
    expect(parts[2]).toBe(signature);
  });

  it('verifies the release, updates the existing listing, and attaches source atomically', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = assetChecksums(zip, source);
    const data = githubResponses(zip, source, checksum);
    const calls = [];
    let uploadPolls = 0;
    let finalPosts = 0;

    global.fetch = makeFetch(
      data,
      async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = amoPath(url);
        expect(init.redirect).toBe('error');
        if (method === 'GET' && path === addonPath()) return jsonResponse(existingAddon());
        if (method === 'GET' && path === addonPath() + '/versions/' + VERSION) {
          return jsonResponse({}, 404);
        }
        if (method === 'POST' && path === '/addons/upload') {
          expect(init.headers.Authorization).toMatch(/^JWT /);
          expect(init.body).toBeInstanceOf(FormData);
          expect(init.body.get('channel')).toBe('listed');
          const upload = init.body.get('upload');
          expect(upload.name).toBe('screensilo-firefox-mv3-' + VERSION + '.zip');
          await expect(upload.arrayBuffer()).resolves.toEqual(
            zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)
          );
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174000',
            channel: 'listed',
            processed: false,
          });
        }
        if (method === 'GET' && path === '/addons/upload/123e4567-e89b-12d3-a456-426614174000') {
          uploadPolls += 1;
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174000',
            channel: 'listed',
            processed: true,
            valid: true,
            submitted: false,
            version: VERSION,
          });
        }
        if (method === 'POST' && path === addonPath() + '/versions') {
          finalPosts += 1;
          expect(init.headers.Authorization).toMatch(/^JWT /);
          expect(init.body).toBeInstanceOf(FormData);
          expect(init.body.get('upload')).toBe('123e4567-e89b-12d3-a456-426614174000');
          const sourceFile = init.body.get('source');
          expect(sourceFile.name).toBe('screensilo-firefox-source-' + VERSION + '.zip');
          await expect(sourceFile.arrayBuffer()).resolves.toEqual(
            source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
          );
          return jsonResponse(versionDetail(zip));
        }
        if (method === 'GET' && path === addonPath() + '/versions/777') {
          return jsonResponse(versionDetail(zip));
        }
        throw new Error('Unexpected AMO request ' + method + ' ' + path);
      },
      calls
    );

    await expect(
      publishRelease(options(['--poll-interval-ms', '100']), baseEnvironment())
    ).resolves.toMatchObject({
      version: VERSION,
      versionId: 777,
      state: 'PENDING_REVIEW',
      sourceAttached: true,
    });
    expect(uploadPolls).toBe(1);
    expect(finalPosts).toBe(1);
    expect(calls.filter((call) => call.url.startsWith(AMO_BASE)).length).toBeGreaterThan(0);
    expect(
      calls
        .filter((call) => call.url.startsWith(AMO_BASE))
        .every((call) => {
          return call.init.redirect === 'error';
        })
    ).toBe(true);
  });

  it.each([
    {
      name: 'missing successful master CI',
      prepare(data) {
        data.runs.workflow_runs = [];
      },
      expectedError: 'No successful CI workflow run',
    },
    {
      name: 'package checksum mismatch',
      prepare(_data) {
        _data.checksum = Buffer.from(
          '0'.repeat(64) +
            '  screensilo-firefox-mv3-' +
            VERSION +
            '.zip\n' +
            createHash('sha256').update(_data.source).digest('hex') +
            '  screensilo-firefox-source-' +
            VERSION +
            '.zip\n'
        );
      },
      expectedError: 'Checksum mismatch',
    },
    {
      name: 'source checksum mismatch',
      prepare(_data) {
        _data.checksum = Buffer.from(
          createHash('sha256').update(_data.zip).digest('hex') +
            '  screensilo-firefox-mv3-' +
            VERSION +
            '.zip\n' +
            '0'.repeat(64) +
            '  screensilo-firefox-source-' +
            VERSION +
            '.zip\n'
        );
      },
      expectedError: 'Checksum mismatch',
    },
    {
      name: 'Firefox manifest GUID mismatch',
      packageZip: () => manifestZip('wrong@example.invalid'),
      expectedError: 'does not match the ScreenSilo listing',
    },
    {
      name: 'Firefox manifest version mismatch',
      packageZip: () => manifestZip(ADDON_GUID, '0.2.4'),
      expectedError: 'does not match the release tag',
    },
  ])('rejects $name before any AMO write', async ({ prepare, packageZip, expectedError }) => {
    const zip = packageZip ? packageZip() : manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = assetChecksums(zip, source);
    const data = githubResponses(zip, source, checksum);
    prepare?.(data, zip);
    const calls = [];
    global.fetch = makeFetch(
      data,
      async () => {
        throw new Error('AMO should not be contacted for a pre-store failure');
      },
      calls
    );

    await expect(publishRelease(options(), baseEnvironment())).rejects.toThrow(expectedError);
    expect(calls.some((call) => call.url.startsWith(AMO_BASE))).toBe(false);
  });

  it('fails closed when the expected existing listing is absent', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const data = githubResponses(zip, source, assetChecksums(zip, source));
    const calls = [];
    global.fetch = makeFetch(
      data,
      async (url, init = {}) => {
        expect(init.redirect).toBe('error');
        if ((init.method || 'GET') === 'GET' && amoPath(url) === addonPath()) {
          return jsonResponse({ detail: 'not found' }, 404);
        }
        throw new Error('Unexpected AMO request');
      },
      calls
    );

    await expect(publishRelease(options(), baseEnvironment())).rejects.toThrow('returned HTTP 404');
    expect(
      calls
        .filter((call) => call.url.startsWith(AMO_BASE))
        .every((call) => {
          return (call.init.method || 'GET') === 'GET';
        })
    ).toBe(true);
  });

  it('does not submit after AMO upload validation fails', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const data = githubResponses(zip, source, assetChecksums(zip, source));
    const calls = [];
    let uploadPosts = 0;
    let versionPosts = 0;
    global.fetch = makeFetch(
      data,
      async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = amoPath(url);
        if (method === 'GET' && path === addonPath()) return jsonResponse(existingAddon());
        if (method === 'GET' && path === addonPath() + '/versions/' + VERSION) {
          return jsonResponse({}, 404);
        }
        if (method === 'POST' && path === '/addons/upload') {
          uploadPosts += 1;
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174001',
            channel: 'listed',
            processed: false,
          });
        }
        if (method === 'GET' && path === '/addons/upload/123e4567-e89b-12d3-a456-426614174001') {
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174001',
            channel: 'listed',
            processed: true,
            valid: false,
            submitted: false,
            version: VERSION,
            validation: { errors: [{ message: 'invalid package' }] },
          });
        }
        if (method === 'POST' && path === addonPath() + '/versions') {
          versionPosts += 1;
          return jsonResponse({});
        }
        throw new Error('Unexpected AMO request ' + method + ' ' + path);
      },
      calls
    );

    await expect(
      publishRelease(options(['--poll-interval-ms', '100']), baseEnvironment())
    ).rejects.toThrow('validation failed');
    expect(uploadPosts).toBe(1);
    expect(versionPosts).toBe(0);
  });

  it('stops after the bounded upload validation timeout', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const data = githubResponses(zip, source, assetChecksums(zip, source));
    const calls = [];
    let versionPosts = 0;
    global.fetch = makeFetch(
      data,
      async (url) => {
        const path = amoPath(url);
        const method = calls.at(-1)?.init.method || 'GET';
        if (method === 'GET' && path === addonPath()) return jsonResponse(existingAddon());
        if (method === 'GET' && path === addonPath() + '/versions/' + VERSION) {
          return jsonResponse({}, 404);
        }
        if (method === 'POST' && path === '/addons/upload') {
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174002',
            channel: 'listed',
            processed: false,
          });
        }
        if (method === 'GET' && path === '/addons/upload/123e4567-e89b-12d3-a456-426614174002') {
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174002',
            channel: 'listed',
            processed: false,
          });
        }
        if (method === 'POST' && path === addonPath() + '/versions') {
          versionPosts += 1;
          return jsonResponse({});
        }
        throw new Error('Unexpected AMO request ' + method + ' ' + path);
      },
      calls
    );

    await expect(
      publishRelease(
        options(['--poll-interval-ms', '100', '--poll-timeout-ms', '1000']),
        baseEnvironment()
      )
    ).rejects.toThrow('timed out');
    expect(versionPosts).toBe(0);
  });

  it('does not repeat an ambiguous upload POST', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const data = githubResponses(zip, source, assetChecksums(zip, source));
    const calls = [];
    let uploadPosts = 0;
    let versionPosts = 0;
    global.fetch = makeFetch(
      data,
      async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = amoPath(url);
        if (method === 'GET' && path === addonPath()) return jsonResponse(existingAddon());
        if (method === 'GET' && path === addonPath() + '/versions/' + VERSION) {
          return jsonResponse({}, 404);
        }
        if (method === 'POST' && path === '/addons/upload') {
          uploadPosts += 1;
          return jsonFailureResponse(new TypeError('connection closed after AMO accepted request'));
        }
        if (method === 'POST' && path === addonPath() + '/versions') {
          versionPosts += 1;
          return jsonResponse({});
        }
        throw new Error('Unexpected AMO request ' + method + ' ' + path);
      },
      calls
    );

    await expect(publishRelease(options(), baseEnvironment())).rejects.toThrow(
      'Upload was not retried'
    );
    expect(uploadPosts).toBe(1);
    expect(versionPosts).toBe(0);
  });

  it('does not repeat an ambiguous version POST', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const data = githubResponses(zip, source, assetChecksums(zip, source));
    const calls = [];
    let uploadPosts = 0;
    let versionPosts = 0;
    global.fetch = makeFetch(
      data,
      async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = amoPath(url);
        if (method === 'GET' && path === addonPath()) return jsonResponse(existingAddon());
        if (method === 'GET' && path === addonPath() + '/versions/' + VERSION) {
          return jsonResponse({}, 404);
        }
        if (method === 'POST' && path === '/addons/upload') {
          uploadPosts += 1;
          return jsonResponse({
            uuid: '123e4567-e89b-12d3-a456-426614174003',
            channel: 'listed',
            processed: true,
            valid: true,
            submitted: false,
            version: VERSION,
          });
        }
        if (method === 'POST' && path === addonPath() + '/versions') {
          versionPosts += 1;
          return jsonFailureResponse(new TypeError('connection closed after AMO accepted request'));
        }
        if (method === 'GET' && path.includes('/versions/')) return jsonResponse({}, 404);
        throw new Error('Unexpected AMO request ' + method + ' ' + path);
      },
      calls
    );

    await expect(publishRelease(options(), baseEnvironment())).rejects.toThrow(
      'Version creation was not retried'
    );
    expect(uploadPosts).toBe(1);
    expect(versionPosts).toBe(1);
  });

  it('rejects an already-existing version whose package or source cannot be verified', async () => {
    const zip = manifestZip();
    const source = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const data = githubResponses(zip, source, assetChecksums(zip, source));
    const calls = [];
    let uploadPosts = 0;
    let versionPosts = 0;
    global.fetch = makeFetch(
      data,
      async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = amoPath(url);
        if (method === 'GET' && path === addonPath()) return jsonResponse(existingAddon());
        if (method === 'GET' && path === addonPath() + '/versions/' + VERSION) {
          return jsonResponse(versionDetail(makeStoredZip('other', 'package'), { source: false }));
        }
        if (method === 'POST' && path === '/addons/upload') {
          uploadPosts += 1;
          return jsonResponse({});
        }
        if (method === 'POST' && path === addonPath() + '/versions') {
          versionPosts += 1;
          return jsonResponse({});
        }
        throw new Error('Unexpected AMO request ' + method + ' ' + path);
      },
      calls
    );

    await expect(publishRelease(options(), baseEnvironment())).rejects.toThrow('already exists');
    expect(uploadPosts).toBe(0);
    expect(versionPosts).toBe(0);
  });
});
