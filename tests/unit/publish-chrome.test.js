import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  parseArgs,
  publishRelease,
  readZipManifest,
  verifyPackageManifest,
} from '../../scripts/publish-chrome.mjs';

const RELEASE_TAG = 'v0.2.3';
const VERSION = '0.2.3';
const RELEASE_SHA = '1111111111111111111111111111111111111111';
const MASTER_SHA = '2222222222222222222222222222222222222222';
const ASSET_BASE = 'https://api.github.com/repos/lmn451/screencast/releases/assets';

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

function options() {
  return parseArgs(['--tag', RELEASE_TAG], { GITHUB_REPOSITORY: 'lmn451/screencast' });
}

function githubResponses(zip, checksum) {
  return {
    release: {
      tag_name: RELEASE_TAG,
      draft: false,
      prerelease: false,
      published_at: '2026-09-01T00:00:00Z',
      assets: [
        {
          name: `screensilo-mv3-${VERSION}.zip`,
          state: 'uploaded',
          url: `${ASSET_BASE}/1`,
        },
        { name: 'SHA256SUMS', state: 'uploaded', url: `${ASSET_BASE}/2` },
      ],
    },
    tagRef: { object: { type: 'commit', sha: RELEASE_SHA } },
    masterRef: { object: { type: 'commit', sha: MASTER_SHA } },
    compare: { status: 'ahead' },
    runs: {
      workflow_runs: [
        {
          id: 123,
          head_sha: RELEASE_SHA,
          head_branch: 'master',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
    zip,
    checksum,
  };
}

function githubPath(url) {
  return new URL(url).pathname;
}

describe('publish-chrome script', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('parses a release tag and refuses unapproved API endpoint overrides', () => {
    expect(options()).toMatchObject({
      tag: RELEASE_TAG,
      repository: 'lmn451/screencast',
      publisherId: '05ed331a-3c06-4e14-a198-e8aa53c73cd7',
      extensionId: 'higbocdfimfmcjckomeggbbigcglpdje',
    });
    expect(() =>
      parseArgs(['--tag', RELEASE_TAG, '--github-api-base', 'https://evil.test'])
    ).toThrow('Unknown option');
    expect(() => parseArgs(['--tag', 'release-latest'])).toThrow('semantic version');
  });

  it('reads and validates the root manifest version from a ZIP', () => {
    const zip = makeStoredZip(
      'manifest.json',
      JSON.stringify({ manifest_version: 3, version: VERSION })
    );
    expect(readZipManifest(zip)).toEqual({ manifest_version: 3, version: VERSION });
    expect(() => verifyPackageManifest(zip, VERSION)).not.toThrow();
    expect(() => verifyPackageManifest(zip, '0.2.4')).toThrow('does not match 0.2.4');
  });

  it('verifies release provenance and submits only after a successful upload', async () => {
    const zip = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = Buffer.from(
      `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
    );
    const responseData = githubResponses(zip, checksum);
    const calls = [];
    global.fetch = jest.fn(async (url, init = {}) => {
      calls.push({ url, init });
      const path = githubPath(url);
      if (path.endsWith(`/releases/tags/${RELEASE_TAG}`)) return jsonResponse(responseData.release);
      if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
      if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
      if (path.includes('/compare/')) return jsonResponse(responseData.compare);
      if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
      if (path.endsWith('/releases/assets/1')) return bytesResponse(zip);
      if (path.endsWith('/releases/assets/2')) return bytesResponse(checksum);
      if (url.includes('chromewebstore.googleapis.com/upload/')) {
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/zip');
        return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: VERSION });
      }
      if (url.includes('chromewebstore.googleapis.com/v2/') && url.endsWith(':publish')) {
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toMatchObject({
          publishType: 'DEFAULT_PUBLISH',
          blockOnWarnings: true,
        });
        return jsonResponse({ state: 'PENDING_REVIEW' });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(
      publishRelease(options(), {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/master',
        GITHUB_TOKEN: 'github-secret',
        CWS_ACCESS_TOKEN: 'cws-secret',
      })
    ).resolves.toMatchObject({ state: 'PENDING_REVIEW' });

    const uploadCall = calls.find(({ url }) => url.includes('/upload/'));
    expect(uploadCall.init.headers.Authorization).toBe('Bearer cws-secret');
    const publishCall = calls.find(({ url }) => url.endsWith(':publish'));
    expect(publishCall.init.headers.Authorization).toBe('Bearer cws-secret');
  });

  it('does not publish when the upload reports failure', async () => {
    const zip = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = Buffer.from(
      `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
    );
    const responseData = githubResponses(zip, checksum);
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(url);
      const path = githubPath(url);
      if (path.endsWith(`/releases/tags/${RELEASE_TAG}`)) return jsonResponse(responseData.release);
      if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
      if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
      if (path.includes('/compare/')) return jsonResponse(responseData.compare);
      if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
      if (path.endsWith('/releases/assets/1')) return bytesResponse(zip);
      if (path.endsWith('/releases/assets/2')) return bytesResponse(checksum);
      if (url.includes('chromewebstore.googleapis.com/upload/')) {
        return jsonResponse({ uploadState: 'FAILED' });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(
      publishRelease(options(), {
        GITHUB_TOKEN: 'github-secret',
        CWS_ACCESS_TOKEN: 'cws-secret',
      })
    ).rejects.toThrow('did not succeed');
    expect(urls.some((url) => url.endsWith(':publish'))).toBe(false);
  });

  it('polls an acknowledged async upload and publishes after documented success', async () => {
    const zip = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = Buffer.from(
      `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
    );
    const responseData = githubResponses(zip, checksum);
    const asyncOptions = parseArgs(['--tag', RELEASE_TAG, '--poll-interval-ms', '100'], {
      GITHUB_REPOSITORY: 'lmn451/screencast',
    });
    let statusCalls = 0;
    let publishCalls = 0;
    global.fetch = jest.fn(async (url) => {
      const path = githubPath(url);
      if (path.endsWith(`/releases/tags/${RELEASE_TAG}`)) return jsonResponse(responseData.release);
      if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
      if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
      if (path.includes('/compare/')) return jsonResponse(responseData.compare);
      if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
      if (path.endsWith('/releases/assets/1')) return bytesResponse(zip);
      if (path.endsWith('/releases/assets/2')) return bytesResponse(checksum);
      if (url.includes('chromewebstore.googleapis.com/upload/')) {
        return jsonResponse({ uploadState: 'UPLOAD_IN_PROGRESS' });
      }
      if (url.endsWith(':fetchStatus')) {
        statusCalls += 1;
        return jsonResponse({
          lastAsyncUploadState: statusCalls === 1 ? 'UPLOAD_IN_PROGRESS' : 'SUCCEEDED',
        });
      }
      if (url.endsWith(':publish')) {
        publishCalls += 1;
        return jsonResponse({ state: 'PENDING_REVIEW' });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(
      publishRelease(asyncOptions, {
        GITHUB_TOKEN: 'github-secret',
        CWS_ACCESS_TOKEN: 'cws-secret',
      })
    ).resolves.toMatchObject({ state: 'PENDING_REVIEW' });
    expect(statusCalls).toBe(2);
    expect(publishCalls).toBe(1);
  });

  it.each([
    [
      'incomplete response body',
      () => jsonFailureResponse(new TypeError('upload response body terminated')),
    ],
    ['transient HTTP response', () => jsonResponse({}, 503)],
  ])(
    'does not repeat an upload or publish after an unknown upload outcome: %s',
    async (_name, uploadResponse) => {
      const zip = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
      const checksum = Buffer.from(
        `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
      );
      const responseData = githubResponses(zip, checksum);
      let uploadAttempts = 0;
      let statusCalls = 0;
      let publishCalls = 0;
      global.fetch = jest.fn(async (url) => {
        const path = githubPath(url);
        if (path.endsWith(`/releases/tags/${RELEASE_TAG}`))
          return jsonResponse(responseData.release);
        if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
        if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
        if (path.includes('/compare/')) return jsonResponse(responseData.compare);
        if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
        if (path.endsWith('/releases/assets/1')) return bytesResponse(zip);
        if (path.endsWith('/releases/assets/2')) return bytesResponse(checksum);
        if (url.includes('chromewebstore.googleapis.com/upload/')) {
          uploadAttempts += 1;
          return uploadResponse();
        }
        if (url.endsWith(':fetchStatus')) {
          statusCalls += 1;
          return jsonResponse({});
        }
        if (url.endsWith(':publish')) {
          publishCalls += 1;
          return jsonResponse({ state: 'PENDING_REVIEW' });
        }
        throw new Error(`Unexpected request ${url}`);
      });

      await expect(
        publishRelease(options(), {
          GITHUB_TOKEN: 'github-secret',
          CWS_ACCESS_TOKEN: 'cws-secret',
        })
      ).rejects.toThrow('response was incomplete');
      expect(uploadAttempts).toBe(1);
      expect(statusCalls).toBe(1);
      expect(publishCalls).toBe(0);
    }
  );

  it.each([
    {
      name: 'successful master CI is missing',
      expectedError: 'No successful CI workflow run',
      prepare(responseData) {
        responseData.runs.workflow_runs = [];
      },
    },
    {
      name: 'the package checksum is wrong',
      expectedError: 'Checksum mismatch',
      prepare(responseData) {
        responseData.checksum = Buffer.from(`${'0'.repeat(64)}  screensilo-mv3-${VERSION}.zip\n`);
      },
    },
    {
      name: 'the package manifest version differs from the tag',
      expectedError: 'does not match 0.2.3',
      packageZip: () => makeStoredZip('manifest.json', JSON.stringify({ version: '0.2.4' })),
    },
  ])(
    'rejects when $name before any Chrome Web Store write',
    async ({ expectedError, prepare, packageZip }) => {
      const zip = packageZip
        ? packageZip()
        : makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
      const checksum = Buffer.from(
        `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
      );
      const responseData = githubResponses(zip, checksum);
      prepare?.(responseData);
      const chromeCalls = [];
      global.fetch = jest.fn(async (url) => {
        const path = githubPath(url);
        if (path.endsWith(`/releases/tags/${RELEASE_TAG}`))
          return jsonResponse(responseData.release);
        if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
        if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
        if (path.includes('/compare/')) return jsonResponse(responseData.compare);
        if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
        if (path.endsWith('/releases/assets/1')) return bytesResponse(responseData.zip);
        if (path.endsWith('/releases/assets/2')) return bytesResponse(responseData.checksum);
        if (url.includes('chromewebstore.googleapis.com/')) {
          chromeCalls.push(url);
          throw new Error(`Unexpected Chrome Web Store request ${url}`);
        }
        throw new Error(`Unexpected request ${url}`);
      });

      await expect(
        publishRelease(options(), {
          GITHUB_TOKEN: 'github-secret',
          CWS_ACCESS_TOKEN: 'cws-secret',
        })
      ).rejects.toThrow(expectedError);
      expect(chromeCalls).toHaveLength(0);
    }
  );

  it('recovers a publish response lost after the store accepted the submission', async () => {
    const zip = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = Buffer.from(
      `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
    );
    const responseData = githubResponses(zip, checksum);
    let publishAttempts = 0;
    global.fetch = jest.fn(async (url) => {
      const path = githubPath(url);
      if (path.endsWith(`/releases/tags/${RELEASE_TAG}`)) return jsonResponse(responseData.release);
      if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
      if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
      if (path.includes('/compare/')) return jsonResponse(responseData.compare);
      if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
      if (path.endsWith('/releases/assets/1')) return bytesResponse(zip);
      if (path.endsWith('/releases/assets/2')) return bytesResponse(checksum);
      if (url.includes('chromewebstore.googleapis.com/upload/')) {
        return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: VERSION });
      }
      if (url.endsWith(':publish')) {
        publishAttempts += 1;
        throw new TypeError('socket closed after request was accepted');
      }
      if (url.endsWith(':fetchStatus')) {
        return jsonResponse({
          submittedItemRevisionStatus: {
            state: 'PENDING_REVIEW',
            distributionChannels: [{ crxVersion: VERSION }],
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(
      publishRelease(options(), {
        GITHUB_TOKEN: 'github-secret',
        CWS_ACCESS_TOKEN: 'cws-secret',
      })
    ).resolves.toMatchObject({ state: 'PENDING_REVIEW' });
    expect(publishAttempts).toBe(1);
  });

  it('recovers when publish headers arrive but the response body fails', async () => {
    const zip = makeStoredZip('manifest.json', JSON.stringify({ version: VERSION }));
    const checksum = Buffer.from(
      `${createHash('sha256').update(zip).digest('hex')}  screensilo-mv3-${VERSION}.zip\n`
    );
    const responseData = githubResponses(zip, checksum);
    let publishAttempts = 0;
    let statusAttempts = 0;
    global.fetch = jest.fn(async (url) => {
      const path = githubPath(url);
      if (path.endsWith(`/releases/tags/${RELEASE_TAG}`)) return jsonResponse(responseData.release);
      if (path.endsWith('/git/ref/tags/v0.2.3')) return jsonResponse(responseData.tagRef);
      if (path.endsWith('/git/ref/heads/master')) return jsonResponse(responseData.masterRef);
      if (path.includes('/compare/')) return jsonResponse(responseData.compare);
      if (path.endsWith('/actions/workflows/ci.yml/runs')) return jsonResponse(responseData.runs);
      if (path.endsWith('/releases/assets/1')) return bytesResponse(zip);
      if (path.endsWith('/releases/assets/2')) return bytesResponse(checksum);
      if (url.includes('chromewebstore.googleapis.com/upload/')) {
        return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: VERSION });
      }
      if (url.endsWith(':publish')) {
        publishAttempts += 1;
        return jsonFailureResponse(new TypeError('response body terminated'));
      }
      if (url.endsWith(':fetchStatus')) {
        statusAttempts += 1;
        return jsonResponse({
          submittedItemRevisionStatus: {
            state: 'PENDING_REVIEW',
            distributionChannels: [{ crxVersion: VERSION }],
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(
      publishRelease(options(), {
        GITHUB_TOKEN: 'github-secret',
        CWS_ACCESS_TOKEN: 'cws-secret',
      })
    ).resolves.toMatchObject({ state: 'PENDING_REVIEW' });
    expect(publishAttempts).toBe(1);
    expect(statusAttempts).toBe(1);
  });
});
