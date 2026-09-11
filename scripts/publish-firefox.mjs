#!/usr/bin/env node

import { createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  PublishError,
  readZipManifest,
  verifyChecksum,
  verifyRelease,
  requestBytes,
  withRetries,
} from './publish-chrome.mjs';

const ADDON_GUID = 'screensilo@subagentura.tech';
const AMO_API = 'https://addons.mozilla.org/api/v5';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function usage() {
  return `Usage: node scripts/publish-firefox.mjs --tag vX.Y.Z [options]

Submit a published GitHub release to the existing ScreenSilo Firefox listing.
Requires GITHUB_TOKEN, AMO_JWT_ISSUER and AMO_JWT_SECRET in the environment.

  --tag TAG                 Published release tag (required)
  --repo OWNER/REPOSITORY   Defaults to GITHUB_REPOSITORY or lmn451/screencast
  --max-retries N           Transient GET retries (default: 3)
  --poll-interval-ms N      Validation polling interval (default: 5000)
  --poll-timeout-ms N       Validation deadline (default: 300000)
  --help                    Show this help
`;
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    tag: null,
    repository: env.GITHUB_REPOSITORY || 'lmn451/screencast',
    addonGuid: ADDON_GUID,
    maxRetries: 3,
    pollIntervalMs: 5000,
    pollTimeoutMs: 300000,
    help: false,
  };
  const fields = {
    '--tag': 'tag',
    '--repo': 'repository',
    '--max-retries': 'maxRetries',
    '--poll-interval-ms': 'pollIntervalMs',
    '--poll-timeout-ms': 'pollTimeoutMs',
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') {
      options.help = true;
      continue;
    }
    const [flag, inlineValue] = argv[index].split('=', 2);
    if (!fields[flag]) throw new PublishError(`Unknown option: ${flag}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new PublishError(`${flag} requires a value`);
    options[fields[flag]] = value;
  }
  if (options.help) return options;
  if (!/^v\d+\.\d+\.\d+(?:\.\d+)?$/.test(options.tag || '')) {
    throw new PublishError('--tag must be a release tag such as v0.2.3');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new PublishError('--repo must have the form OWNER/REPOSITORY');
  }
  for (const [field, min, max] of [
    ['maxRetries', 0, 5],
    ['pollIntervalMs', 1, 60000],
    ['pollTimeoutMs', 1, 600000],
  ]) {
    const value = String(options[field]);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new PublishError(`${field} must be an integer between ${min} and ${max}`);
    }
    options[field] = Number(value);
  }
  return options;
}

export function createAmoJwt(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: issuer,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  })}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function selectFirefoxAssets(release, tag) {
  const version = tag.slice(1);
  const expectedZipName = `screensilo-firefox-mv3-${version}.zip`;
  const expectedSourceName = `screensilo-firefox-source-${version}.zip`;
  const findAsset = (name) => {
    const matches = (release.assets || []).filter((asset) => asset.name === name);
    if (matches.length !== 1) {
      throw new PublishError(`Published release must contain exactly one ${name} asset`);
    }
    return matches[0];
  };
  return {
    zipAsset: findAsset(expectedZipName),
    sourceAsset: findAsset(expectedSourceName),
    checksumAsset: findAsset('SHA256SUMS'),
    expectedZipName,
    expectedSourceName,
  };
}

async function downloadAssets(options, assets, githubToken) {
  const download = (asset, maxBytes) =>
    withRetries(
      `Download ${asset.name}`,
      () =>
        requestBytes(asset.url, { label: `Download ${asset.name}`, token: githubToken, maxBytes }),
      options.maxRetries
    );
  const [zip, source, checksums] = await Promise.all([
    download(assets.zipAsset, MAX_ARCHIVE_BYTES),
    download(assets.sourceAsset, MAX_ARCHIVE_BYTES),
    download(assets.checksumAsset, 1024 * 1024),
  ]);
  verifyChecksum(zip, checksums, assets.expectedZipName);
  verifyChecksum(source, checksums, assets.expectedSourceName);
  return { zip, source };
}

export function verifyFirefoxManifest(zip, version) {
  const manifest = readZipManifest(zip);
  if (manifest?.version !== version)
    throw new PublishError('Firefox manifest version does not match the release tag');
  if (manifest?.browser_specific_settings?.gecko?.id !== ADDON_GUID) {
    throw new PublishError('Firefox manifest GUID does not match the ScreenSilo listing');
  }
  if (manifest.manifest_version !== 3)
    throw new PublishError('Firefox package must use Manifest V3');
  return manifest;
}

async function amoRequest(
  options,
  credentials,
  path,
  { method = 'GET', body, allow404 = false } = {}
) {
  const label = `Mozilla ${method} ${path}`;
  const request = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${AMO_API}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `JWT ${createAmoJwt(credentials.issuer, credentials.secret)}`,
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 404 && allow404) return null;
      if (!response.ok) {
        // Do not log response bodies: they may contain account data or secrets.
        throw new PublishError(`${label} returned HTTP ${response.status}`, {
          retryable: method === 'GET' && TRANSIENT_STATUSES.has(response.status),
        });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new PublishError(`${label} failed or returned an incomplete response`, {
        retryable: method === 'GET',
      });
    } finally {
      clearTimeout(timer);
    }
  };
  // A write can succeed even if its response is lost. Never repeat writes.
  if (method !== 'GET') return request();
  return withRetries(label, request, options.maxRetries);
}

async function waitForValidation(options, credentials, initial, version) {
  const uuid = initial?.uuid;
  if (typeof uuid !== 'string' || !/^[a-f0-9-]{36}$/i.test(uuid)) {
    throw new PublishError(
      'Mozilla upload returned no valid upload UUID; inspect AMO before retrying'
    );
  }
  console.log(`Mozilla upload acknowledged (${uuid}); waiting for validation`);
  const deadline = Date.now() + options.pollTimeoutMs;
  let upload = initial;
  for (;;) {
    if (upload?.uuid !== uuid || upload?.channel !== 'listed' || upload?.submitted === true) {
      throw new PublishError(
        'Mozilla upload identity or channel is unexpected, or upload is already submitted'
      );
    }
    if (upload.processed === true) {
      if (upload.valid !== true || Number(upload.validation?.errors || 0) > 0) {
        throw new PublishError(
          `Mozilla validation failed for upload ${uuid}; inspect its validation report in AMO`
        );
      }
      if (upload.version !== version)
        throw new PublishError('Mozilla uploaded version does not match the release tag');
      return uuid;
    }
    if (Date.now() >= deadline)
      throw new PublishError(
        `Mozilla validation timed out for upload ${uuid}; no version submitted`
      );
    await sleep(Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())));
    upload = await amoRequest(options, credentials, `/addons/upload/${uuid}/`);
  }
}

function verifySubmittedVersion(version, expectedVersion, expectedId) {
  if (
    !Number.isSafeInteger(version?.id) ||
    version.id <= 0 ||
    (expectedId !== undefined && version.id !== expectedId) ||
    version?.version !== expectedVersion ||
    version?.channel !== 'listed' ||
    version?.is_disabled === true ||
    !['public', 'unreviewed'].includes(version?.file?.status) ||
    typeof version?.source !== 'string' ||
    !version.source.startsWith('https://')
  ) {
    throw new PublishError(
      'Mozilla submission could not be verified with its source archive; inspect AMO before retrying'
    );
  }
}

export async function publishRelease(options, env = process.env) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF !== 'refs/heads/master') {
    throw new PublishError('Firefox publishing is permitted only from the master workflow ref');
  }
  const githubToken = env.GITHUB_TOKEN?.trim();
  const credentials = { issuer: env.AMO_JWT_ISSUER?.trim(), secret: env.AMO_JWT_SECRET?.trim() };
  for (const [name, value] of [
    ['GITHUB_TOKEN', githubToken],
    ['AMO_JWT_ISSUER', credentials.issuer],
    ['AMO_JWT_SECRET', credentials.secret],
  ]) {
    if (!value) throw new PublishError(`${name} is required through the environment`);
  }
  if (options.addonGuid !== ADDON_GUID)
    throw new PublishError('Only the existing ScreenSilo Firefox listing is supported');
  const version = options.tag.slice(1);
  const assets = await verifyRelease(options, options.tag, githubToken, selectFirefoxAssets);
  const { zip, source } = await downloadAssets(options, assets, githubToken);
  verifyFirefoxManifest(zip, version);
  if (readZipManifest(source)?.version !== version) {
    throw new PublishError('Source archive manifest version does not match the release tag');
  }
  console.log(`Verified Firefox ${version}, its GUID, and matching source archive`);

  const addonPath = `/addons/addon/${encodeURIComponent(ADDON_GUID)}/`;
  const addon = await amoRequest(options, credentials, addonPath);
  if (addon?.guid !== ADDON_GUID || addon?.is_disabled === true) {
    throw new PublishError(
      'The expected existing ScreenSilo addon is unavailable; no upload performed'
    );
  }
  const existing = await amoRequest(options, credentials, `${addonPath}versions/${version}/`, {
    allow404: true,
  });
  if (existing)
    throw new PublishError(
      `Firefox ${version} already exists; inspect AMO instead of submitting it again`
    );

  const uploadForm = new FormData();
  uploadForm.set('upload', new Blob([zip], { type: 'application/zip' }), assets.expectedZipName);
  uploadForm.set('channel', 'listed');
  let uploaded;
  try {
    uploaded = await amoRequest(options, credentials, '/addons/upload/', {
      method: 'POST',
      body: uploadForm,
    });
  } catch (error) {
    throw new PublishError(
      `${error.message}. Upload was not retried; inspect AMO before running again`
    );
  }
  const uploadId = await waitForValidation(options, credentials, uploaded, version);

  const versionForm = new FormData();
  versionForm.set('upload', uploadId);
  // Multipart version creation attaches the source in the same submission.
  versionForm.set(
    'source',
    new Blob([source], { type: 'application/zip' }),
    assets.expectedSourceName
  );
  let submitted;
  try {
    submitted = await amoRequest(options, credentials, `${addonPath}versions/`, {
      method: 'POST',
      body: versionForm,
    });
  } catch (error) {
    throw new PublishError(
      `${error.message}. Version creation was not retried; inspect AMO before running again`
    );
  }
  verifySubmittedVersion(submitted, version);
  const confirmed = await amoRequest(options, credentials, `${addonPath}versions/${submitted.id}/`);
  verifySubmittedVersion(confirmed, version, submitted.id);
  const result = {
    version,
    versionId: confirmed.id,
    state: confirmed.file.status === 'public' ? 'PUBLISHED' : 'PENDING_REVIEW',
    sourceAttached: true,
  };
  console.log(
    `Firefox ${version} submission accepted with source archive (state: ${result.state}; version ID: ${result.versionId})`
  );
  return result;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const main = async () => {
    const options = parseArgs();
    if (options.help) console.log(usage());
    else await publishRelease(options);
  };
  main().catch((error) => {
    console.error(
      `Firefox publishing failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    process.exitCode = 1;
  });
}
