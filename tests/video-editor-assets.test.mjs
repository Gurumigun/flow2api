import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(process.env.FLOW_SOURCE_FILE || new URL('../extension/background.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const currentVideoEditorAssets ='), source.indexOf('const currentMediaAssets ='));
function read(images, includePending = false) {
  const document = { querySelectorAll: () => images };
  const mediaAssetFromUrl = url => url ? { identity: url, url, mediaId: '' } : null;
  return new Function('document', 'normalizedText', 'mediaAssetFromUrl', `${helper}; return currentVideoEditorAssets;`)(document, v => String(v || '').trim(), mediaAssetFromUrl)(includePending);
}
function poster(url, { loaded = true, alt = '생성된 동영상 썸네일', label = '편집기에서 동영상 열기' } = {}) {
  const button = { getAttribute: () => label };
  return { src: url, alt, complete: loaded, naturalWidth: loaded ? 720 : 0, closest: () => button };
}
test('recognizes a completed canvas video card without a video tag', () => {
  const p = poster('new-video'); const assets = read([p]);
  assert.equal(assets.size, 1); assert.equal(assets.get('new-video').editorButton, p.closest());
});
test('records unloaded old posters in baseline and excludes reference images', () => {
  const old = poster('old-video', { loaded: false });
  const reference = poster('reference', { alt: 'Uploaded image' });
  const baseline = new Set(read([old, reference], true).keys());
  old.complete = true; old.naturalWidth = 720;
  const fresh = [...read([old, reference, poster('new-video')]).values()].filter(x => !baseline.has(x.identity));
  assert.deepEqual(fresh.map(x => x.identity), ['new-video']);
});
test('ignores pending posters and cards that do not open a video editor', () => {
  assert.equal(read([poster('pending', { loaded: false }), poster('image', { label: 'Open image in editor' })]).size, 0);
});
