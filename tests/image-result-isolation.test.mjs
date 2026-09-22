import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const asset = (id) => ({ identity: id, mediaId: id, url: `https://flow-content.google/image/${id}` });

test('baseline captures pending images; previously mounted gallery nodes cannot reappear as generation results', () => {
  const old = { complete: true, naturalWidth: 900, src: 'old', closest:()=>null };
  const pending = { complete: false, naturalWidth: 0, src: 'pending', closest:()=>null };
  const fresh = { complete: true, naturalWidth: 900, src: 'fresh', alt:'Option 1', closest:(selector)=>selector.startsWith('button')?{getAttribute:()=> '편집기에서 이미지 열기'}:null };
  const images = [old,pending];
  const window = { __FLOW2API_IMAGE_SUBMISSION__: { nodes: new WeakSet(images) } };
  const snippet = source.slice(source.indexOf('const currentMediaAssets ='), source.indexOf('// Read actual generation cards'));
  const read = new Function('isVideo','document','window','normalizedText','mediaAssetFromUrl',`${snippet}; return currentMediaAssets;`)(false,{querySelectorAll:()=>images},window,value=>String(value||'').trim(),asset);
  assert.deepEqual([...read(true).keys()], ['old','pending']);
  pending.complete = true; pending.naturalWidth = 900; pending.src = 'later-loaded-url'; images.push(fresh);
  assert.deepEqual([...read().keys()], ['fresh']);
  const lazy = { complete:false, naturalWidth:0, src:'new-lazy', alt:'Option 1', loading:'lazy', closest:()=>null };
  images.push(lazy);
  assert.deepEqual([...read().keys()], ['fresh']);
  assert.equal(lazy.loading,'eager');
  assert.equal(pending.loading,undefined);
  lazy.complete=true; lazy.naturalWidth=900;
  assert.deepEqual([...read().keys()], ['fresh','new-lazy']);
});

const loop = source.slice(source.indexOf('const uiTimeoutMs ='), source.indexOf('\n                };\n\n                const parsedRequestUrl'));
async function runLoop(active, hasFreshAsset = () => true) {
  let time = 0, polls = 0;
  const submission = { observed: false, nodes: new WeakSet() };
  const context = { isVideo:false, timeoutMs:180000, Date:{now:()=>time}, submission, document:{querySelectorAll:()=>[]},
    pause:async()=>{time+=1000;polls++;},
    currentMediaAssets:()=>hasFreshAsset(polls) ? new Map([['fresh',asset('fresh')]]) : new Map(),
    imageGenerationIsActive:()=>active(polls), reportProgress(){}, findGenerationApproval:()=>null,
    baselineIds:new Set(), baselineFailureCount:0, countFailureSignals:()=>0, nextImageFailurePollCount:()=>0,
    prompt:'new image', imageRequest:{}, browserFingerprint:()=>({}) };
  const result = await new Function(...Object.keys(context), `return (async()=>{${loop}})();`)(...Object.values(context));
  return { result, polls };
}
test('page yields to worker after observed generation; never returns gallery as result', async () => {
  const { result, polls } = await runLoop((n)=>n>=4 && n<=10, n=>n>=4);
  assert.equal(polls,4);
  assert.equal(result.flow2apiImagePolling,true);
  await assert.rejects(()=>runLoop(()=>false,()=>false),/Timed out/);
  assert.equal((await runLoop(()=>true)).result.flow2apiImagePolling,true);
});

test('a fresh completed option proves submission even when Flow never exposes a stop control', async () => {
  const { result, polls } = await runLoop(() => false, n => n >= 3);
  assert.equal(result.flow2apiImagePolling, true);
  assert(polls >= 4);
});

const validation = source.slice(source.indexOf('async function validateCurrentFlowImages('),source.indexOf('async function readCurrentFlowImageCandidates('));
const validate = new Function(`${validation}; return validateCurrentFlowImages;`)();
const response = (ids) => JSON.stringify({flow2apiTransport:'flow_google_ui',media:ids.map(id=>({image:{generatedImage:{flow2apiIdentity:id,fifeUrl:asset(id).url}}}))});
test('multiple non-reference candidates fail instead of returning an arbitrary old image', async () => {
  const validator = { check: async ({identity}) => ({ status:identity==='reference'?'reference':'accepted' }) };
  await assert.rejects(()=>validate(response(['old-gallery','new-result']),validator),/ambiguous/);
  const accepted = JSON.parse(await validate(response(['reference','new-result']),validator));
  assert.equal(accepted.media.length,1);
  assert.equal(accepted.media[0].image.generatedImage.fifeUrl,asset('new-result').url);
});

test('worker waits for completion and ignores old assets using short page probes', async () => {
  const snippet = source.slice(source.indexOf('async function waitForValidatedFlowImage('),source.indexOf('async function handleGetSessionCookie('));
  let polls=0;
  const context={Date, cancelledFlowSubmitRequestIds:new Set(),
    readCurrentFlowImageCandidates:async()=>({generationActive:++polls<6,assets:[asset('old'),asset('fresh')]}),
    sendFlowSubmitProgress(){},sleep:async()=>{},validateCurrentFlowImages:validate};
  const wait=new Function(...Object.keys(context),`${snippet};return waitForValidatedFlowImage;`)(...Object.values(context));
  const result=JSON.parse(await wait(1,response(['metadata']),{check:async()=>({status:'accepted'})},{req_id:'test'},null,['old']));
  assert(polls>=6);
  assert.equal(result.media.length,1);
  assert.equal(result.media[0].name,'fresh');
});

test('validation can run again after worker polling without losing image identity', async () => {
  const validator={check:async ({identity})=>identity ? {status:'accepted'} : {status:'error',reason:'invalid_asset'}};
  const once=await validate(response(['fresh']),validator);
  const twice=await validate(once,validator);
  assert.equal(JSON.parse(twice).media[0].image.generatedImage.flow2apiIdentity,'fresh');
  const snippet=source.slice(source.indexOf('async function embedCurrentFlowImages('),source.indexOf('async function validateCurrentFlowImages('));
  const embed=new Function(`${snippet};return embedCurrentFlowImages;`)();
  const images=new Map([[asset('fresh').url,{url:asset('fresh').url,encodedImage:'image-bytes',mimeType:'image/png'}]]);
  const final=JSON.parse(await embed(twice,images));
  assert.equal(final.media[0].image.generatedImage.flow2apiIdentity,undefined);
  assert.equal(final.media[0].image.generatedImage.encodedImage,'image-bytes');
});
