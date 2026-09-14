import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/video-ui-download.js', import.meta.url), 'utf8');
const project = 'e09d97f5-c71f-4665-8617-a1fb2c017278';
const media = '25d119f8-5836-4d4a-b7ca-4ce23035c409';
function mp4(seconds = 8, version = 0) {
  const mvhd = Buffer.alloc(version ? 40 : 28);
  mvhd.writeUInt32BE(mvhd.length); mvhd.write('mvhd', 4); mvhd[8] = version;
  mvhd.writeUInt32BE(1000, version ? 28 : 20);
  if (version) mvhd.writeBigUInt64BE(BigInt(seconds * 1000), 32);
  else mvhd.writeUInt32BE(seconds * 1000, 24);
  const header = Buffer.alloc(32);
  header.writeUInt32BE(24); header.write('ftyp', 4); header.write('isom', 8);
  header.writeUInt32BE(8 + mvhd.length, 24); header.write('moov', 28);
  return Buffer.concat([header, mvhd]);
}
function harness({ bytes = mp4(), url = 'blob:https://flow.google.com/diagnostic', path, menu = true, httpStatus = 200 } = {}) {
  let now = 0, fetches = 0, nativeClicks = 0, originalChosen = 0, intervals = 0;
  class Anchor { click() { nativeClicks++; } }
  const originalClick = Anchor.prototype.click;
  const button = { getBoundingClientRect: () => ({ width: 20, height: 20 }), getAttribute: () => '미디어 다운로드', click() {} };
  const item = { getBoundingClientRect: button.getBoundingClientRect, getAttribute: () => null, textContent: '720p 원본 크기', click() {
    originalChosen++;
    const a = new Anchor(); a.download = 'demo.mp4'; a.href = url; a.click();
  } };
  const context = vm.createContext({
    URL, Uint8Array, DataView, AbortSignal, btoa, window: {}, HTMLAnchorElement: Anchor,
    location: { origin: 'https://flow.google.com', href: `https://flow.google.com/project/${project}/edit/${media}`, pathname: path || `/project/${project}/edit/${media}` },
    Date: { now: () => now }, setTimeout(fn, ms) { now += ms; queueMicrotask(fn); },
    setInterval() { intervals++; return 1; }, clearInterval() { intervals--; },
    document: { querySelectorAll: selector => selector === 'button' ? [button] : menu ? [item] : [] },
    async fetch() { fetches++; return new Response(bytes, { status: httpStatus }); },
  });
  vm.runInContext(source, context);
  return { run: () => context.downloadFlowVideoFromEditor(project, media, 'r1'),
    check() { assert.equal(Anchor.prototype.click, originalClick); assert.equal(intervals, 0); },
    stats: () => ({ fetches, nativeClicks, originalChosen }) };
}
test('canvas editor yields original MP4 bytes and measured duration without browser download', async () => {
  for (const version of [0, 1]) {
    const bytes = mp4(8, version), h = harness({ bytes });
    const result = await h.run();
    assert.equal(result.mediaId, media); assert.equal(result.duration, '8s');
    assert.deepEqual(Buffer.from(result.encodedVideo, 'base64'), bytes);
    assert.deepEqual(h.stats(), { fetches: 1, nativeClicks: 0, originalChosen: 1 }); h.check();
  }
});
test('never downloads from a different project or video editor', async () => {
  for (const path of [`/project/other/edit/${media}`, `/project/${project}/edit/00000000-0000-0000-0000-000000000000`]) {
    const h = harness({ path }); await assert.rejects(h.run(), /own editor/);
    assert.equal(h.stats().fetches, 0); h.check();
  }
});
test('rejects non-Flow URLs and restores the native download handler', async () => {
  for (const url of ['https://attacker.example/movie.mp4', 'blob:https://attacker.example/id', 'https://user:secret@flow.google.com/asb/movie']) {
    const h = harness({ url }); await assert.rejects(h.run(), /Blocked non-Flow/);
    assert.equal(h.stats().fetches, 0); h.check();
  }
});
test('rejects HTML, oversized MP4, and the wrong duration', async () => {
  for (const bytes of [Buffer.from('<html>Login required</html>'), Buffer.alloc(11 * 1024 * 1024), mp4(3), mp4(29)]) {
    const h = harness({ bytes }); await assert.rejects(h.run(), /MP4|10MB|8-second/); h.check();
  }
});
test('missing original size option and download failure clean up interception', async () => {
  for (const options of [{ menu: false }, { httpStatus: 403 }]) {
    const h = harness(options); await assert.rejects(h.run(), /original video option|download failed/); h.check();
  }
});
