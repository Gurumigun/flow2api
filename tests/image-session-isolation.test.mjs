import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const start=source.slice(source.indexOf('// Each API request gets a clean conversation.'),source.indexOf('// The current flow.google.com editor keeps image defaults in'));
test('new session is required and its old results must disappear before a request is sent',async()=>{
 for(const scenario of ['success','missing-button','old-session']){
  let clicked=false;
  const button={getAttribute:()=> '새로운 세션 시작'};
  const document={querySelectorAll:(selector)=>selector.startsWith('button')||selector.includes('[role="button"]')?(scenario==='missing-button'?[]:[button]):selector==='img'?(!clicked||scenario==='old-session'?[{alt:'Option 1'}]:[]):[{textContent:clicked&&scenario!=='old-session'?'제목 없는 세션':'기존 대화'}]};
  const context={isVideo:false,document,isVisible:()=>true,normalizedText:v=>String(v||'').trim(),clickElement:()=>{clicked=true;},waitFor:async(probe,_ms,label)=>{const result=probe();if(!result)throw Error(label);return result;},pause:async()=>{},reportProgress:()=>{}};
  const run=()=>new Function(...Object.keys(context),`return (async()=>{${start}})()`)(...Object.values(context));
  if(scenario==='success')await run();else await assert.rejects(run,/Flow/);
 }
});
test('session reset also accepts Flow title-based English controls', async()=>{
 let clicked = false;
 const button = {getAttribute: name => name === 'title' ? 'New conversation' : '', textContent: ''};
 const document = {
   querySelectorAll: selector => selector.startsWith('button') || selector.includes('[role="button"]') ? [button]
   : selector === 'img' ? (clicked ? [] : [{alt:'Option 1'}])
   : [{textContent: clicked ? 'New conversation' : 'Existing conversation'}],
 };
 const context = {
  isVideo:false, document, isVisible:()=>true, normalizedText:v=>String(v||'').trim(),
  clickElement:()=>{clicked=true;},
  waitFor:async probe=>{const result=probe();if(!result)throw Error('reset not detected');return result;},
  pause:async()=>{},
  reportProgress:()=>{},
 };
 await new Function(...Object.keys(context),`return (async()=>{${start}})()`)(...Object.values(context));
 assert.equal(clicked, true);
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
