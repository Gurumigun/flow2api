import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const attachNativeUpload ='),source.indexOf('const findGenerationApproval ='));

function fixture({attach=true,autoAttach=false}={}) {
  let visible=false,picker,selected,uploaded,search='',opens=0;
  const references=[];
  class Input {
    type='file';
    click() {}
    dispatchEvent(event) {
      if(event.type==='change') {
        uploaded=this.files[0].name;
        visible=false; // Current Flow closes upload picker without attaching.
        if(autoAttach)references.push(uploaded);
      }
    }
  }
  const input=new Input();
  class Transfer {
    files=[];
    items={add:file=>this.files.push(file)};
  }
  const uploadButton={type:'upload',visible:true};
  const addButton={type:'add',visible:true,textContent:'프롬프트에 추가'};
  const option=name=>({type:'asset',name,visible:true,querySelector:()=>({textContent:name})});
  const openAssetPicker=async()=> {
    opens++;visible=true;
    picker={
      get visible(){return visible;},
      querySelector(selector){return selector==='.sidebar-upload-btn'?uploadButton:selector==='input[type="text"]'?{}:null;},
      querySelectorAll(selector){
        if(selector==='button.asset-item[role="option"]')return [option('unrelated.png'),option(uploaded)];
        if(selector==='button')return [addButton];
        if(selector==='img')return [{alt:`${selected||''} 미리보기`}];
        return [];
      },
    };
    return picker;
  };
  const context={
    readyPromptReferences:()=>references,
    openAssetPicker,
    isVisible:e=>Boolean(e?.visible),
    normalizedText:v=>String(v||'').trim(),
    HTMLInputElement:Input,DataTransfer:Transfer,File,Event,atob,
    document:{querySelectorAll:selector=>selector==='input[type="file"]'?[input]:[]},
    setInputValue:(_input,value)=>{search=value;},pause:async()=>{},
    waitFor:async(probe,_timeout,label)=>{for(let i=0;i<3;i++){const r=probe();if(r)return r;}throw new Error(`Timed out waiting for ${label}`);},
    clickElement:element=>{
      if(element.type==='upload')input.click();
      if(element.type==='asset')selected=element.name;
      if(element.type==='add'){visible=false;if(attach)references.push(selected);}
    },
  };
  const run=new Function(...Object.keys(context),`${code};return attachNativeUpload;`)(...Object.values(context));
  return {run, references, state:()=>({selected,uploaded,search,opens})};
}
const upload=name=>({fileName:name,imageBytes:btoa('reference-bytes'),mimeType:'image/png',rightsConfirmed:true});
test('closed upload picker is reopened; exact uploaded reference is explicitly added before success',async()=>{
  const f=fixture();await f.run(upload('master.png'));
  assert.deepEqual(f.references,['master.png']);
  assert.deepEqual(f.state(),{selected:'master.png',uploaded:'master.png',search:'master.png',opens:2});
  await f.run(upload('character.png'));
  assert.deepEqual(f.references,['master.png','character.png']);
});
test('successful upload without a ready prompt reference fails instead of submitting text alone',async()=>{
  const f=fixture({attach:false});
  await assert.rejects(()=>f.run(upload('master.png')),/ready reference in Flow prompt/);
  assert.equal(f.references.length,0);
});
test('an upload actually auto-attached by Flow is not added a second time',async()=>{
  const f=fixture({autoAttach:true});await f.run(upload('master.png'));
  assert.deepEqual(f.references,['master.png']);assert.equal(f.state().opens,1);
});
