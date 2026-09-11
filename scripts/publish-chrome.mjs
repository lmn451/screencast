#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_REPOSITORY = 'lmn451/screencast';
const DEFAULT_PUBLISHER_ID = '05ed331a-3c06-4e14-a198-e8aa53c73cd7';
const DEFAULT_EXTENSION_ID = 'higbocdfimfmcjckomeggbbigcglpdje';
const GITHUB_API_BASE = 'https://api.github.com';
const CHROME_WEBSTORE_API_BASE = 'https://chromewebstore.googleapis.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const UPLOAD_IN_PROGRESS_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const UPLOAD_SUCCESS_STATES = new Set(['SUCCEEDED', 'SUCCESS']);
const UPLOAD_FAILURE_STATES = new Set(['FAILED', 'NOT_FOUND']);
const PUBLISH_SUCCESS_STATES = new Set(['PENDING_REVIEW', 'PUBLISHED', 'STAGED']);

class PublishError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PublishError';
    this.retryable = options.retryable === true;
    this.unknownOutcome = options.unknownOutcome === true;
  }
}

class HttpError extends PublishError {
  constructor(label, status, statusText) {
    super(`${label} returned HTTP ${status}${statusText ? ` ${statusText}` : ''}`, {
      retryable: TRANSIENT_HTTP_STATUSES.has(status),
      // A server or proxy can report an error after committing a POST. Uploads
      // must reconcile that outcome before considering another store write.
      unknownOutcome: TRANSIENT_HTTP_STATUSES.has(status),
    });
    this.status = status;
  }
}

function usage() {
  return `Usage: node scripts/publish-chrome.mjs --tag vX.Y.Z [options]

Publishes the Chromium ZIP attached to an existing, published GitHub release.
Credentials are read only from GITHUB_TOKEN and CWS_ACCESS_TOKEN.

Options:
  --tag TAG                 Existing published release tag (required)
  --repo OWNER/REPOSITORY   GitHub repository (default: GITHUB_REPOSITORY)
  --publisher-id ID         Chrome Web Store publisher ID
  --extension-id ID         Chrome Web Store item ID
  --max-retries N           Retries for transient HTTP/network errors (default: 3)
  --poll-interval-ms N      Delay between async upload status checks (default: 5000)
  --poll-timeout-ms N       Maximum async upload wait (default: 120000)
  --help                    Show this help
`;
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new PublishError(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, option, { min, max }) {
  if (!/^[0-9]+$/.test(value)) {
    throw new PublishError(`${option} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new PublishError(`${option} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    tag: null,
    repository: env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    publisherId: DEFAULT_PUBLISHER_ID,
    extensionId: DEFAULT_EXTENSION_ID,
    maxRetries: DEFAULT_MAX_RETRIES,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new PublishError(`Unknown option: ${argument}`);
    }
    const [inlineOption, inlineValue] = argument.split('=', 2);
    let value = inlineValue;
    if (value === undefined) {
      value = requireOptionValue(argv, index, argument);
      index += 1;
    }

    switch (inlineOption) {
      case '--tag':
        options.tag = value;
        break;
      case '--repo':
        options.repository = value;
        break;
      case '--publisher-id':
        options.publisherId = value;
        break;
      case '--extension-id':
        options.extensionId = value;
        break;
      case '--max-retries':
        options.maxRetries = parsePositiveInteger(value, '--max-retries', { min: 0, max: 5 });
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = parsePositiveInteger(value, '--poll-interval-ms', {
          min: 100,
          max: 60_000,
        });
        break;
      case '--poll-timeout-ms':
        options.pollTimeoutMs = parsePositiveInteger(value, '--poll-timeout-ms', {
          min: 1_000,
          max: 600_000,
        });
        break;
      default:
        throw new PublishError(`Unknown option: ${argument}`);
    }
  }

  if (options.help) return options;
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (!options.tag) {
    throw new PublishError('A release tag is required; pass --tag vX.Y.Z');
  }

  if (!/^v?\d+\.\d+\.\d+$/.test(options.tag)) {
    throw new PublishError('Release tag must be a semantic version such as v0.2.3');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) {
    throw new PublishError('Repository must have the form OWNER/REPOSITORY');
  }
  if (!/^[a-z0-9]{32}$/.test(options.extensionId)) {
    throw new PublishError('Chrome Web Store extension ID is invalid');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.publisherId
    )
  ) {
    throw new PublishError('Chrome Web Store publisher ID is invalid');
  }
}

function releaseVersion(tag) {
  return tag.replace(/^v/, '');
}

function joinApiUrl(base, pathname) {
  return new URL(pathname.replace(/^\//, ''), `${base.replace(/\/$/, '')}/`).toString();
}

function itemPath(publisherId, extensionId) {
  return `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;
}

function transientError(error) {
  return error?.retryable === true || error?.name === 'AbortError';
}

async function withRetries(label, operation, maxRetries, { retryUnknown = true } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error?.unknownOutcome === true && !retryUnknown) {
        throw error;
      }
      if (!transientError(error) || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = Math.min(1_000 * 2 ** attempt, 10_000);
      console.warn(`${label} failed transiently; retrying (${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
    }
  }
  throw new PublishError(`${label} exhausted its retry budget`);
}

async function fetchWithTimeout(url, init, consumeResponse) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new PublishError('Network request failed', {
        cause: error,
        retryable: true,
        unknownOutcome: true,
      });
    }
    return await consumeResponse(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestJson(url, { label, token, method = 'GET', body, contentType } = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';

  return fetchWithTimeout(
    url,
    {
      method,
      headers,
      body,
    },
    async (response) => {
      if (!response.ok) {
        throw new HttpError(label, response.status, response.statusText);
      }

      try {
        return await response.json();
      } catch (error) {
        // A response body that cannot be consumed leaves a POST's outcome
        // unknown: the store may have accepted the request before the stream
        // failed. Keep it retryable so publishPackage can verify fetchStatus
        // before retrying or reporting failure.
        throw new PublishError(`${label} returned invalid JSON`, {
          cause: error,
          retryable: true,
          unknownOutcome: true,
        });
      }
    }
  );
}

async function requestBytes(url, { label, token, maxBytes }) {
  return fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
      },
    },
    async (response) => {
      if (!response.ok) {
        throw new HttpError(label, response.status, response.statusText);
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new PublishError(`${label} exceeds the ${maxBytes} byte limit`);
      }

      if (!response.body) {
        throw new PublishError(`${label} returned an empty response body`);
      }

      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (done) continue;
          const value = result.value;
          const chunk = Buffer.from(value);
          total += chunk.length;
          if (total > maxBytes) {
            throw new PublishError(`${label} exceeds the ${maxBytes} byte limit`);
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, total);
    }
  );
}

function githubUrl(pathname) {
  return joinApiUrl(GITHUB_API_BASE, pathname);
}

function chromeWebstoreUrl(pathname) {
  return joinApiUrl(CHROME_WEBSTORE_API_BASE, pathname);
}

async function githubJson(options, pathname, token) {
  const label = `GitHub ${pathname.split('?')[0]}`;
  return withRetries(
    label,
    () => requestJson(githubUrl(pathname), { label, token }),
    options.maxRetries
  );
}

function validateAsset(asset, repository, expectedHost) {
  if (!asset || asset.state !== 'uploaded' || typeof asset.url !== 'string') {
    throw new PublishError('Release asset is missing or was not uploaded successfully');
  }
  let parsed;
  try {
    parsed = new URL(asset.url);
  } catch {
    throw new PublishError('Release asset URL is invalid');
  }
  const expectedPathPrefix = `/repos/${repository}/releases/assets/`;
  const assetId = parsed.pathname.slice(expectedPathPrefix.length);
  if (
    parsed.protocol !== 'https:' ||
    parsed.host !== expectedHost ||
    !parsed.pathname.startsWith(expectedPathPrefix) ||
    !/^\d+$/.test(assetId) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PublishError('Release asset URL is outside the expected GitHub API');
  }
}

function selectReleaseAssets(release, tag) {
  const version = releaseVersion(tag);
  const expectedZipName = `screensilo-mv3-${version}.zip`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zipAssets = assets.filter((asset) => asset.name === expectedZipName);
  const checksumAssets = assets.filter((asset) => asset.name === 'SHA256SUMS');
  if (zipAssets.length !== 1) {
    throw new PublishError(`Published release must contain exactly one ${expectedZipName} asset`);
  }
  if (checksumAssets.length !== 1) {
    throw new PublishError('Published release must contain exactly one SHA256SUMS asset');
  }
  return { zipAsset: zipAssets[0], checksumAsset: checksumAssets[0], expectedZipName };
}

function resolveCommitObject(response, label) {
  if (!response?.object?.sha || !['commit', 'tag'].includes(response.object.type)) {
    throw new PublishError(`${label} does not resolve to a commit or annotated tag`);
  }
  if (!/^[0-9a-f]{40}$/i.test(response.object.sha)) {
    throw new PublishError(`${label} returned an invalid object SHA`);
  }
  return response.object;
}

async function resolveReleaseCommit(options, tag, token) {
  const ref = await githubJson(
    options,
    `/repos/${options.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    token
  );
  let object = resolveCommitObject(ref, `Tag ${tag}`);
  if (object.type === 'tag') {
    const annotatedTag = await githubJson(
      options,
      `/repos/${options.repository}/git/tags/${encodeURIComponent(object.sha)}`,
      token
    );
    object = resolveCommitObject(annotatedTag, `Annotated tag ${tag}`);
    if (object.type !== 'commit') {
      throw new PublishError(`Tag ${tag} is nested beyond one annotated tag`);
    }
  }
  return object.sha;
}

async function verifyMasterAncestry(options, releaseSha, token) {
  const masterRef = await githubJson(
    options,
    `/repos/${options.repository}/git/ref/heads/master`,
    token
  );
  const masterObject = resolveCommitObject(masterRef, 'master');
  if (masterObject.type !== 'commit') {
    throw new PublishError('master does not resolve directly to a commit');
  }

  const comparison = await githubJson(
    options,
    `/repos/${options.repository}/compare/${releaseSha}...${masterObject.sha}`,
    token
  );
  if (!['ahead', 'identical'].includes(comparison?.status)) {
    throw new PublishError(
      `Release commit is not an ancestor of master (compare status: ${
        comparison?.status || 'unknown'
      })`
    );
  }
  return masterObject.sha;
}

async function verifyCiProvenance(options, releaseSha, token) {
  const query = new URLSearchParams({
    head_sha: releaseSha,
    event: 'push',
    status: 'completed',
    per_page: '100',
  });
  const runs = await githubJson(
    options,
    `/repos/${options.repository}/actions/workflows/ci.yml/runs?${query.toString()}`,
    token
  );
  const successfulRun = (runs?.workflow_runs || []).find(
    (run) =>
      run?.head_sha === releaseSha &&
      run?.head_branch === 'master' &&
      run?.event === 'push' &&
      run?.status === 'completed' &&
      run?.conclusion === 'success'
  );
  if (!successfulRun) {
    throw new PublishError(
      `No successful CI workflow run was found for release commit ${releaseSha}`
    );
  }
  return successfulRun.id;
}

async function verifyRelease(options, tag, githubToken, selectAssets = selectReleaseAssets) {
  const release = await githubJson(
    options,
    `/repos/${options.repository}/releases/tags/${encodeURIComponent(tag)}`,
    githubToken
  );
  if (
    release?.tag_name !== tag ||
    release?.draft === true ||
    release?.prerelease === true ||
    !release?.published_at
  ) {
    throw new PublishError(`Release ${tag} must be an existing published, non-prerelease release`);
  }

  const releaseSha = await resolveReleaseCommit(options, tag, githubToken);
  const masterSha = await verifyMasterAncestry(options, releaseSha, githubToken);
  const ciRunId = await verifyCiProvenance(options, releaseSha, githubToken);
  const assets = selectAssets(release, tag);
  const expectedHost = new URL(GITHUB_API_BASE).host;
  validateAsset(assets.zipAsset, options.repository, expectedHost);
  validateAsset(assets.checksumAsset, options.repository, expectedHost);
  if (assets.sourceAsset) validateAsset(assets.sourceAsset, options.repository, expectedHost);

  console.log(
    `Verified published release ${tag} at ${releaseSha.slice(0, 12)}; master ${masterSha.slice(
      0,
      12
    )}; CI run ${ciRunId}`
  );
  return { release, releaseSha, ...assets };
}

async function downloadReleaseAssets(options, releaseAssets, githubToken) {
  const [zip, checksumFile] = await Promise.all([
    withRetries(
      `Download ${releaseAssets.zipAsset.name}`,
      () =>
        requestBytes(releaseAssets.zipAsset.url, {
          label: `Download ${releaseAssets.zipAsset.name}`,
          token: githubToken,
          maxBytes: MAX_PACKAGE_BYTES,
        }),
      options.maxRetries
    ),
    withRetries(
      'Download SHA256SUMS',
      () =>
        requestBytes(releaseAssets.checksumAsset.url, {
          label: 'Download SHA256SUMS',
          token: githubToken,
          maxBytes: MAX_CHECKSUM_BYTES,
        }),
      options.maxRetries
    ),
  ]);
  return { zip, checksumFile };
}

function expectedChecksum(checksumFile, expectedFilename) {
  const lines = checksumFile.toString('utf8').split(/\r?\n/);
  const matches = [];
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+(?:\*?)(.+?)\s*$/i);
    if (!match) continue;
    const filename = match[2].trim();
    if (filename === expectedFilename || filename.split('/').pop() === expectedFilename) {
      matches.push(match[1].toLowerCase());
    }
  }
  if (matches.length !== 1) {
    throw new PublishError(`SHA256SUMS must contain exactly one entry for ${expectedFilename}`);
  }
  return matches[0];
}

function verifyChecksum(zip, checksumFile, expectedFilename) {
  const expected = expectedChecksum(checksumFile, expectedFilename);
  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) {
    throw new PublishError(`Checksum mismatch for ${expectedFilename}`);
  }
  console.log(`Verified SHA-256 for ${expectedFilename}`);
}

function readZipManifest(zip) {
  const minimumEndOfCentralDirectorySize = 22;
  const maximumCommentSize = 0xffff;
  if (zip.length < minimumEndOfCentralDirectorySize) {
    throw new PublishError('Chromium package is not a valid ZIP archive');
  }
  const firstEndOfCentralDirectoryOffset = Math.max(
    0,
    zip.length - minimumEndOfCentralDirectorySize - maximumCommentSize
  );
  let endOfCentralDirectoryOffset = -1;
  for (
    let offset = zip.length - minimumEndOfCentralDirectorySize;
    offset >= firstEndOfCentralDirectoryOffset;
    offset -= 1
  ) {
    if (zip.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = zip.readUInt16LE(offset + 20);
    if (offset + minimumEndOfCentralDirectorySize + commentLength <= zip.length) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }
  if (endOfCentralDirectoryOffset < 0) {
    throw new PublishError('Chromium package is not a valid ZIP archive');
  }

  const entryCount = zip.readUInt16LE(endOfCentralDirectoryOffset + 10);
  const centralDirectorySize = zip.readUInt32LE(endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = zip.readUInt32LE(endOfCentralDirectoryOffset + 16);
  if (
    centralDirectoryOffset + centralDirectorySize > endOfCentralDirectoryOffset ||
    entryCount === 0
  ) {
    throw new PublishError('Chromium package has an invalid ZIP central directory');
  }

  let cursor = centralDirectoryOffset;
  let manifestEntry = null;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new PublishError('Chromium package has a malformed ZIP central directory');
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const compressionMethod = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const filenameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localHeaderOffset = zip.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + filenameLength + extraLength + commentLength;
    if (entryEnd > zip.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new PublishError('Chromium package uses an unsupported ZIP64 entry');
    }

    const filename = zip.toString('utf8', cursor + 46, cursor + 46 + filenameLength);
    if (filename === 'manifest.json') {
      if (manifestEntry)
        throw new PublishError('Chromium package contains duplicate manifest.json files');
      manifestEntry = {
        flags,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
    }
    cursor = entryEnd;
  }
  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    throw new PublishError('Chromium package has an inconsistent ZIP central directory');
  }

  if (!manifestEntry) {
    throw new PublishError('Chromium package does not contain a root manifest.json');
  }
  if (manifestEntry.flags & 0x1) {
    throw new PublishError('Chromium package manifest is encrypted');
  }
  if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
    throw new PublishError('Chromium package manifest is unexpectedly large');
  }

  const localHeaderOffset = manifestEntry.localHeaderOffset;
  if (localHeaderOffset + 30 > zip.length || zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new PublishError('Chromium package has a malformed manifest entry');
  }
  const localFilenameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const localFilename = zip.toString(
    'utf8',
    localHeaderOffset + 30,
    localHeaderOffset + 30 + localFilenameLength
  );
  if (localFilename !== 'manifest.json') {
    throw new PublishError('Chromium package manifest entry does not point to manifest.json');
  }
  const dataStart = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
  const dataEnd = dataStart + manifestEntry.compressedSize;
  if (dataStart > zip.length || dataEnd > zip.length) {
    throw new PublishError('Chromium package manifest data is truncated');
  }

  const compressed = zip.subarray(dataStart, dataEnd);
  let manifestBytes;
  try {
    if (manifestEntry.compressionMethod === 0) {
      manifestBytes = compressed;
    } else if (manifestEntry.compressionMethod === 8) {
      manifestBytes = inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
    } else {
      throw new PublishError('Chromium package manifest uses an unsupported compression method');
    }
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError('Chromium package manifest could not be decompressed', { cause: error });
  }
  if (manifestBytes.length !== manifestEntry.uncompressedSize) {
    throw new PublishError('Chromium package manifest size does not match its ZIP entry');
  }

  try {
    return JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new PublishError('Chromium package manifest is not valid JSON', { cause: error });
  }
}

function verifyPackageManifest(zip, expectedVersion) {
  const manifest = readZipManifest(zip);
  if (manifest?.version !== expectedVersion) {
    throw new PublishError(
      `Chromium package manifest version ${
        manifest?.version || 'unknown'
      } does not match ${expectedVersion}`
    );
  }
  console.log(`Verified manifest version ${expectedVersion}`);
}

function revisionVersion(revision) {
  const channels = revision?.distributionChannels;
  if (channels !== undefined && !Array.isArray(channels)) return null;
  const versions = new Set(
    [revision?.crxVersion, ...(channels || []).map((channel) => channel?.crxVersion)].filter(
      (version) => typeof version === 'string'
    )
  );
  return versions.size === 1 ? [...versions][0] : null;
}

function acceptedSubmission(status, expectedVersion) {
  for (const revision of [
    status?.submittedItemRevisionStatus,
    status?.publishedItemRevisionStatus,
  ]) {
    const version = revisionVersion(revision);
    if (version === expectedVersion && PUBLISH_SUCCESS_STATES.has(revision?.state)) {
      return { state: revision.state };
    }
  }
  return null;
}

function verifyUploadedVersion(uploadResult, expectedVersion) {
  if (uploadResult.asynchronous) {
    const reportedVersion = uploadResult.initialResponse?.crxVersion;
    if (reportedVersion !== undefined && reportedVersion !== expectedVersion) {
      throw new PublishError(
        `Chrome Web Store upload version ${
          reportedVersion || 'unknown'
        } does not match ${expectedVersion}`
      );
    }
    console.log(`Verified manifest version ${expectedVersion} after acknowledged async upload`);
    return;
  }

  const actualVersion = uploadResult.status?.crxVersion;
  if (actualVersion !== expectedVersion) {
    throw new PublishError(
      `Chrome Web Store upload version ${
        actualVersion || 'unknown'
      } does not match ${expectedVersion}`
    );
  }
  console.log(`Verified uploaded version ${expectedVersion}`);
}

async function uploadPackage(options, zip, cwsToken, expectedVersion) {
  const path = `/upload/v2/${itemPath(options.publisherId, options.extensionId)}:upload`;
  const label = 'Chrome Web Store upload';
  try {
    const response = await withRetries(
      label,
      () =>
        requestJson(chromeWebstoreUrl(path), {
          label,
          token: cwsToken,
          method: 'POST',
          body: zip,
          contentType: 'application/zip',
        }),
      options.maxRetries,
      { retryUnknown: false }
    );
    const state = response?.uploadState;
    if (!UPLOAD_SUCCESS_STATES.has(state) && !UPLOAD_IN_PROGRESS_STATES.has(state)) {
      throw new PublishError(
        `Chrome Web Store upload did not succeed (state: ${state || 'unknown'})`
      );
    }
    return { response, recoveredSubmission: null };
  } catch (error) {
    if (error?.unknownOutcome !== true) throw error;

    // fetchStatus has no documented uploaded-draft version. It is safe to
    // finish only if the same version is already proven submitted or published;
    // otherwise do not repeat the upload POST after an unknown outcome.
    const recoveredSubmission = await recoverSubmission(options, cwsToken, expectedVersion);
    if (recoveredSubmission) {
      return { response: null, recoveredSubmission };
    }
    throw new PublishError(
      'Chrome Web Store upload response was incomplete; refusing to retry or publish. Confirm the item status in the Developer Dashboard before rerunning.',
      { cause: error, unknownOutcome: true }
    );
  }
}

async function fetchItemStatus(options, cwsToken, label = 'Chrome Web Store item status') {
  const path = `/v2/${itemPath(options.publisherId, options.extensionId)}:fetchStatus`;
  return withRetries(
    label,
    () => requestJson(chromeWebstoreUrl(path), { label, token: cwsToken }),
    options.maxRetries
  );
}

async function waitForUpload(options, initialResponse, cwsToken) {
  let state = initialResponse?.uploadState;
  if (UPLOAD_SUCCESS_STATES.has(state)) {
    return { status: initialResponse, asynchronous: false, initialResponse };
  }
  const deadline = Date.now() + options.pollTimeoutMs;
  while (UPLOAD_IN_PROGRESS_STATES.has(state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new PublishError(
        `Chrome Web Store upload did not finish within ${options.pollTimeoutMs}ms`
      );
    }
    await sleep(Math.min(options.pollIntervalMs, remaining));
    const status = await fetchItemStatus(options, cwsToken, 'Chrome Web Store upload status');
    state = status?.lastAsyncUploadState;
    if (UPLOAD_SUCCESS_STATES.has(state)) {
      return { status, asynchronous: true, initialResponse };
    }
    if (UPLOAD_FAILURE_STATES.has(state)) {
      throw new PublishError(`Chrome Web Store upload failed (state: ${state})`);
    }
    if (!UPLOAD_IN_PROGRESS_STATES.has(state)) {
      throw new PublishError(
        `Chrome Web Store upload returned an unknown state: ${state || 'unknown'}`
      );
    }
  }
  throw new PublishError(
    `Chrome Web Store upload returned an unknown state: ${state || 'unknown'}`
  );
}

async function recoverSubmission(options, cwsToken, expectedVersion) {
  try {
    const status = await fetchItemStatus(options, cwsToken, 'Chrome Web Store submission status');
    const accepted = acceptedSubmission(status, expectedVersion);
    if (accepted) {
      return {
        name: itemPath(options.publisherId, options.extensionId),
        itemId: options.extensionId,
        state: accepted.state,
      };
    }
  } catch {
    // Preserve the original publish error when status verification is unavailable.
  }
  return null;
}

function validatePublishResponse(response) {
  const state = response?.state;
  if (!PUBLISH_SUCCESS_STATES.has(state)) {
    throw new PublishError(
      `Chrome Web Store submission did not succeed (state: ${state || 'unknown'})`
    );
  }
  const warnings = response?.warningInfo?.warnings;
  if (warnings !== undefined && (!Array.isArray(warnings) || warnings.length > 0)) {
    throw new PublishError('Chrome Web Store submission returned warnings');
  }
  return response;
}

async function publishPackage(options, cwsToken, expectedVersion) {
  const path = `/v2/${itemPath(options.publisherId, options.extensionId)}:publish`;
  const label = 'Chrome Web Store publish submission';
  const request = () =>
    requestJson(chromeWebstoreUrl(path), {
      label,
      token: cwsToken,
      method: 'POST',
      body: JSON.stringify({
        publishType: 'DEFAULT_PUBLISH',
        skipReview: false,
        blockOnWarnings: true,
      }),
    });

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return validatePublishResponse(await request());
    } catch (error) {
      const shouldVerifyOutcome = error?.unknownOutcome === true || transientError(error);
      const recovered = shouldVerifyOutcome
        ? await recoverSubmission(options, cwsToken, expectedVersion)
        : null;
      if (recovered) {
        console.warn('Recovered an accepted Chrome Web Store submission after a lost response');
        return recovered;
      }
      if (!transientError(error) || attempt >= options.maxRetries) {
        throw error;
      }
      const waitMs = Math.min(1_000 * 2 ** attempt, 10_000);
      console.warn(`${label} failed transiently; retrying (${attempt + 1}/${options.maxRetries})`);
      await sleep(waitMs);
    }
  }
  throw new PublishError(`${label} exhausted its retry budget`);
}

function requireCiMasterRef(env) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF !== 'refs/heads/master') {
    throw new PublishError(
      'Chrome Web Store publishing is permitted only from the master workflow ref'
    );
  }
}

export async function publishRelease(options, env = process.env) {
  requireCiMasterRef(env);
  const githubToken = env.GITHUB_TOKEN?.trim();
  const cwsToken = env.CWS_ACCESS_TOKEN?.trim();
  if (!githubToken)
    throw new PublishError('GITHUB_TOKEN is required and must be supplied through the environment');
  if (!cwsToken)
    throw new PublishError(
      'CWS_ACCESS_TOKEN is required and must be supplied through the environment'
    );

  const verified = await verifyRelease(options, options.tag, githubToken);
  const { zip, checksumFile } = await downloadReleaseAssets(options, verified, githubToken);
  verifyChecksum(zip, checksumFile, verified.expectedZipName);
  const expectedVersion = releaseVersion(options.tag);
  verifyPackageManifest(zip, expectedVersion);

  console.log('Uploading the verified package to Chrome Web Store…');
  const { response: uploadResponse, recoveredSubmission } = await uploadPackage(
    options,
    zip,
    cwsToken,
    expectedVersion
  );
  if (recoveredSubmission) {
    console.warn(
      'An existing matching Chrome Web Store submission was verified after an incomplete upload response'
    );
    return recoveredSubmission;
  }
  const uploadedResult = await waitForUpload(options, uploadResponse, cwsToken);
  verifyUploadedVersion(uploadedResult, expectedVersion);

  console.log('Submitting the verified upload for review…');
  const publishResponse = await publishPackage(options, cwsToken, expectedVersion);
  console.log(`Chrome Web Store submission accepted (state: ${publishResponse.state})`);
  return publishResponse;
}

export {
  PublishError,
  readZipManifest,
  verifyChecksum,
  verifyPackageManifest,
  verifyRelease,
  requestBytes,
  withRetries,
};

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  await publishRelease(options);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Chrome Web Store publishing failed: ${message}`);
    process.exitCode = 1;
  });
}
