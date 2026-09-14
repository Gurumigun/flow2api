import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function sameFlowImage('), source.indexOf('async function embedCurrentFlowImages('));
const { sameFlowImage, createFlowResultValidator } = new Function(
  'isCurrentFlowImageUrl', `${helpers}; return { sameFlowImage, createFlowResultValidator };`,
)(url => /^https:\/\/flow-content\.google\/image\//.test(url));
const waitHelpers = source.slice(
  source.indexOf('async function validateCurrentFlowImages('),
  source.indexOf('async function handleGetSessionCookie('),
);
const fingerprint = value => ({ aspect: 0.75, pixels: Uint8ClampedArray.from({length: 64 * 64 * 4}, (_, i) => i % 4 === 3 ? 255 : value) });
const reference = fingerprint(100);
const recompressed = fingerprint(101);
const newScene = fingerprint(130);
const asset = id => ({ identity: id, url: `https://flow-content.google/image/${id}` });

test('recompressed reference pixels are rejected while a new scene is distinct', () => {
  assert(sameFlowImage(reference, recompressed));
  assert(!sameFlowImage(reference, newScene));
  assert(!sameFlowImage(reference, {...reference, aspect: 1.5}));
});

test('the validator skips the uploaded cover and retains the generated body payload', async () => {
  const calls = [];
  const validator = createFlowResultValidator([{ imageBytes: 'cover', mimeType: 'image/jpeg' }],
    async url => { calls.push(url); return { encodedImage: url.endsWith('upload') ? 'copy' : 'body', mimeType: 'image/jpeg' }; },
    async encoded => ({ cover: reference, copy: recompressed, body: newScene })[encoded],
  );
  assert.equal((await validator.check(asset('upload'))).status, 'reference');
  assert.equal((await validator.check(asset('body'))).status, 'accepted');
  assert.equal((await validator.check(asset('upload'))).status, 'reference');
  assert.equal(calls.length, 2);
  assert.equal(validator.accepted.get(asset('body').url).encodedImage, 'body');
  assert(!validator.accepted.has(asset('upload').url));
});

test('failed pixel verification or an unsupported destination never succeeds', async () => {
  let calls = 0;
  const validator = createFlowResultValidator([], async () => { calls++; throw new Error('download failed'); }, async () => newScene);
  assert.equal((await validator.check({identity:'x',url:'https://untrusted.test/image'})).status, 'error');
  assert.equal(calls, 0);
  assert.equal((await validator.check(asset('body'))).status, 'error');
  assert.equal(validator.accepted.size, 0);
});

function responseFor(candidate) {
  return JSON.stringify({
    media: [{
      image: {
        generatedImage: {
          fifeUrl: candidate.url,
          flow2apiIdentity: candidate.identity,
        },
      },
    }],
    flow2apiTransport: 'flow_google_ui',
    flow2apiBaselineIdentities: [],
  });
}

function loadWaitHelpers({snapshots = [], cancelled = new Set(), now = () => Date.now()} = {}) {
  let poll = 0;
  const progress = [];
  const chrome = {scripting: {executeScript: async () => [{
    result: snapshots[Math.min(poll++, Math.max(0, snapshots.length - 1))]
      || {generationActive: false, assets: []},
  }]}};
  const loaded = new Function(
    'chrome',
    'cancelledFlowSubmitRequestIds',
    'sendFlowSubmitProgress',
    'sleep',
    'Date',
    `${waitHelpers}; return { validateCurrentFlowImages, waitForValidatedFlowImage };`,
  )(
    chrome,
    cancelled,
    (_data, _socket, phase) => progress.push(phase),
    async () => {},
    {now},
  );
  return {...loaded, progress};
}

test('post-validation waits past the uploaded reference and returns only the generated image', async () => {
  const upload = asset('upload');
  const body = asset('body');
  const snapshots = [
    {generationActive: true, assets: [upload]},
    {generationActive: true, assets: [upload, body]},
    {generationActive: false, assets: [upload, body]},
    {generationActive: false, assets: [upload, body]},
  ];
  const {validateCurrentFlowImages, waitForValidatedFlowImage, progress} = loadWaitHelpers({snapshots});
  const validator = {
    check: async candidate => ({
      ...candidate,
      status: candidate.identity === upload.identity ? 'reference' : 'accepted',
    }),
  };

  let referenceOnly;
  try {
    await validateCurrentFlowImages(responseFor(upload), validator);
  } catch (error) {
    referenceOnly = error;
  }
  assert.equal(referenceOnly?.flow2apiReferenceOnly, true);

  const result = JSON.parse(await waitForValidatedFlowImage(
    1,
    responseFor(upload),
    validator,
    {req_id: 'request-1'},
    {},
    referenceOnly.flow2apiIgnoredIdentities,
  ));
  assert.equal(result.media[0].image.generatedImage.fifeUrl, body.url);
  assert(progress.includes('generation_active'));
  assert(progress.includes('waiting_for_result'));
});

test('post-validation rejects failed verification, cancellation, and missing output', async () => {
  const upload = asset('upload');
  const failed = loadWaitHelpers();
  await assert.rejects(
    failed.validateCurrentFlowImages(responseFor(upload), {check: async () => ({status: 'error', reason: 'decode_failed'})}),
    /could not be verified \(decode_failed\)/,
  );

  const cancelled = new Set(['request-1']);
  const cancelledHelpers = loadWaitHelpers({cancelled});
  await assert.rejects(
    cancelledHelpers.waitForValidatedFlowImage(
      1, responseFor(upload), {check: async () => ({status: 'reference'})},
      {req_id: 'request-1'}, {}, [upload.identity],
    ),
    /cancelled/,
  );

  let clock = 0;
  const timedOut = loadWaitHelpers({now: () => {
    clock += 121000;
    return clock;
  }});
  await assert.rejects(
    timedOut.waitForValidatedFlowImage(
      1, responseFor(upload), {check: async () => ({status: 'reference'})},
      {req_id: 'request-2'}, {}, [upload.identity],
    ),
    /Timed out/,
  );
});
