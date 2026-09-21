import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const guard=source.slice(source.indexOf('function isCurrentFlowImageUrl('),source.indexOf('async function fetchCurrentFlowImage('));
const allowed=new Function(`${guard};return isCurrentFlowImageUrl;`)();
const parseSource=source.slice(source.indexOf('const mediaAssetFromUrl ='),source.indexOf('// Canvas-backed videos'));
const parser=(isVideo)=>new Function('isVideo','location',`${parseSource};return mediaAssetFromUrl;`)(isVideo,{href:'https://flow.google.com/project/test',origin:'https://flow.google.com'});
test('signed Google conversation images do not require legacy gallery URL paths',()=>{
 const signed='https://lh3.googleusercontent.com/gg-dl/current-result=s1024';
 assert(allowed(signed)); assert.equal(parser(false)(signed).url,signed);
 assert.equal(parser(true)(signed),null,'new image paths are not video results');
 for(const url of ['https://unrelated.test/image.png','https://googleusercontent.com.evil.test/asb/image','http://lh3.googleusercontent.com/image','data:image/png;base64,eA==']) assert.equal(allowed(url),false);
});
test('same-origin Flow blob images are accepted only for the mapped Flow page',()=>{
 const localBlob='blob:https://flow.google.com/8f962f8e-2035-42b7-aec8-67a4bc61a4f6';
 assert(allowed(localBlob));
 assert.equal(parser(false)(localBlob).url,localBlob);
 assert.equal(allowed('blob:https://unrelated.test/8f962f8e-2035-42b7-aec8-67a4bc61a4f6'),false);
});
