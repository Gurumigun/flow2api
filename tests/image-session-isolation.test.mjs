import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
test('image generation does not block on Flow session-reset controls',()=>{
 assert.ok(!source.includes('"Flow new session button"'));
 assert.ok(!source.includes('"empty Flow image session"'));
});
test('late gallery tiles cannot be accepted even after a clean session has generated a result',()=>{
 const button={getAttribute:()=> '편집기에서 이미지 열기'};
 const img=(src,alt,hasButton)=>({src,alt,complete:true,naturalWidth:900,closest:s=>s.startsWith('button')&&hasButton?button:null});
 const gallery=img('late-gallery','사용자 이미지를 표시하는 타일',false);
 const result=img('current-result','Option 1',true);
 const reference=img('uploaded','reference',true);
 const snippet=source.slice(source.indexOf('const currentMediaAssets ='),source.indexOf('// Read actual generation cards'));
 const read=new Function('isVideo','document','window','normalizedText','mediaAssetFromUrl',`${snippet};return currentMediaAssets;`)(false,{querySelectorAll:()=>[gallery,result,reference]},{__FLOW2API_IMAGE_SUBMISSION__:{nodes:new WeakSet()}},v=>String(v||'').trim(),s=>({identity:s}));
 assert.deepEqual([...read().keys()],['current-result']);
 assert.equal(read(true).size,3);
});
