import assert from 'node:assert/strict';
import { startFixture, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
const calls = [];
const words = ['phrase, with comma', 'literal [name]', 'Case', 'case'];
const local = {status:'found', source:'LoRA Studio', name:'Local synthetic LoRA',
  author:'Local author', license:'Example license', recommended_strength:0,
  description:'<img src=x onerror="window.metadataXss=true">', trigger_words:words,
  training:{train:{steps:1200,lr:0.0001},dataset:{resolution:[1024]},sample:{width:1024,height:1024}},
  legacy:{training_info:{step:250,epoch:0}}};
const records = new Map();
try {
  await fixture.context.route('**/prompt-studio/model-metadata**', async route => {
    const req = route.request();
    const body = req.method() === 'GET' ? Object.fromEntries(new URL(req.url()).searchParams) : req.postDataJSON();
    calls.push({method:req.method(),...body});
    if (req.method() === 'PUT') {
      records.set(body.name,{...records.get(body.name),trigger_words:body.trigger_words,trigger_words_edited:true,trigger_words_source:'Your local edits'});
    } else if (body.local_only) {
      records.set(body.name, records.get(body.name) || {status:'unchecked',refresh_due:false,local_metadata:local,
        trigger_words:words,trigger_words_source:'LoRA Studio',size_bytes:4096});
    } else if (req.method() === 'POST') {
      return route.fulfill({status:503,json:{error:'Offline Civitai fixture'}});
    }
    await route.fulfill({json:records.get(body.name) || {status:'unchecked',refresh_due:true}});
  });
  const page = await fixture.newPage();
  for (const studio of videoEnabled ? ['image','video'] : ['image']) {
    await page.evaluate(async studio => {
      const host = document.createElement('div'); host.id='local-test'; document.body.append(host);
      if (studio === 'video') {
        const {createVideoAdapterControls} = await import('/extensions/PromptStudio_Video/js/video-adapter-controls.js');
        host.append(createVideoAdapterControls({project:{document:{content_loras:[{name:'local-video.safetensors',strength:.65}],reference_adapters:[]}},
          workflow:{snapshot:{output:{}}},catalog:{adapters:[{category:'loras',name:'local-video.safetensors',kind:'lora'}]},onChange:()=>{},onRefresh:()=>{}}));
      } else {
        const {createModelDetailsButton} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/model-metadata.js');
        host.append(createModelDetailsButton({name:'local-image.safetensors'}));
      }
    }, studio);
    await page.locator('#local-test .promptstudio-model-info').click();
    const dialog = page.getByRole('dialog',{name:'LoRA details',exact:true});
    await dialog.getByRole('button',{name:words[0],exact:true}).waitFor();
    for (const phrase of words) assert.equal(await dialog.getByRole('button',{name:phrase,exact:true}).count(),1);
    assert.equal(await dialog.locator('img').count(),0);
    const strengthRow=dialog.locator('.promptstudio-metadata-field').filter({hasText:'Recommended strength'});
    assert.equal(await strengthRow.locator('span').textContent(),'0');
    assert.equal(await dialog.locator('.promptstudio-metadata-field').filter({hasText:'Checkpoint step'}).locator('span').textContent(),'250');
    await dialog.getByText('Training settings',{exact:true}).click();
    assert.ok((await dialog.locator('pre').textContent()).includes('1200'));
    assert.ok((await dialog.textContent()).includes('No Civitai listing is required'));
    const triggers = await page.evaluate(async name => {
      const {loadLoraTriggerWords}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/model-metadata.js');
      return loadLoraTriggerWords(name);
    }, `local-${studio}.safetensors`);
    assert.deepEqual(triggers,words,'The shared picker must get offline triggers');
    assert.equal(calls.filter(call=>call.method==='POST' && !call.local_only).length,studio==='image'?0:1,'Automatic local metadata must not query Civitai');
    if (studio==='video') assert.equal(await page.locator('#local-test input[type=number]').first().inputValue(),'0.65');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await dialog.getByRole('button',{name:'Check again',exact:true}).click();
    await dialog.getByText(/Offline Civitai fixture/).waitFor();
    assert.equal(await dialog.getByRole('button',{name:words[0],exact:true}).count(),1);
    await dialog.getByRole('button',{name:'Edit trigger words',exact:true}).click();
    const editor=page.getByRole('dialog',{name:'Edit trigger words',exact:true});
    for (let n=0;n<words.length;n++) await editor.getByRole('button',{name:/Delete trigger/}).first().click();
    await editor.getByRole('button',{name:'Save trigger words',exact:true}).click();
    await editor.waitFor({state:'detached'});
    await dialog.getByText('No trigger words in your local list.',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(async name => {
      const {loadLoraTriggerWords}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/model-metadata.js');
      return loadLoraTriggerWords(name);
    }, `local-${studio}.safetensors`),[]);
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await page.locator('#local-test').evaluate(node=>node.remove());
    await page.setViewportSize({width:1440,height:1000});
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Local LoRA metadata: offline triggers, zero strength, training details, safe text, mobile, explicit remote failure and local overrides passed.');
} finally {await fixture.close();}
