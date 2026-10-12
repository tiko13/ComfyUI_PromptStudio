import assert from 'node:assert/strict';
import { startFixture, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
const calls = [];
const records = new Map();
let failure = false;
const found = name => ({status:'found', file_name:name, name:'Synthetic Portrait LoRA', category:'loras',
  sha256:'a'.repeat(64), size_bytes:1048576, creator:'Fixture author', type:'LORA',
  source_host:'civitai.red', site:'auto', trigger_words:['exact_TRIGGER', 'two words'],
  description:'<img src=x onerror="window.metadataXss=true"> Author notes remain plain text.',
  version_description:'Use a strength of 0.7.',
  version:{id:10,name:'v1',base_model:'Example Base',url:'https://civitai.red/models/2?modelVersionId=10'},
  latest_version:{id:11,name:'v2',base_model:'Example Base',url:'https://civitai.red/models/2?modelVersionId=11'},
  update_status:'available', checked_at:1800000000, refresh_due:false});
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {buildLoraNodeControls,buildModelNodeControls};'});
  });
  await fixture.context.route('**/prompt-studio/model-metadata**', async route => {
    const request = route.request();
    const data = request.method() === 'POST' ? request.postDataJSON() : Object.fromEntries(new URL(request.url()).searchParams);
    calls.push({method:request.method(),...data});
    if (request.method() === 'POST') {
      const result = found(data.name);
      result.site = data.site;
      if (failure) { result.error = 'Civitai is offline'; result.stale = true; }
      records.set(data.name,result);
    }
    await route.fulfill({json:records.get(data.name) || {status:'unchecked',refresh_due:true}});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const {buildLoraNodeControls,buildModelNodeControls} = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    window.renderMetadataControls = () => {
      const card = document.querySelector('#promptstudio-lora-details'); card.hidden=false; card.open=true;
      const group=buildLoraNodeControls({id:'metadata-test'},{id:'901',loraType:'Style'},[{name:'Style/portrait.safetensors',label:'Portrait'}]);
      group.id='metadata-test'; card.querySelector('#promptstudio-lora-groups').replaceChildren(group);
      const models=buildModelNodeControls({id:'metadata-test'},{id:'902',modelType:'Base'},[
        {name:'Base/first.safetensors',label:'First model'}, {name:'Base/second.safetensors',label:'Second model'}]);
      models.id='metadata-models'; card.append(models);
    };
    window.renderMetadataControls();
  });
  const group=page.locator('#metadata-test');
  await group.getByRole('combobox').fill('Portrait');
  await group.getByRole('option',{name:'Portrait',exact:true}).click();
  await page.evaluate(()=>{document.querySelector('#metadata-models').remove();window.renderMetadataControls();});
  const info=group.locator('.promptstudio-model-info');
  await info.waitFor();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#metadata-models .promptstudio-model-selection')).display==='grid');
  const aligned=await page.evaluate(()=>{
    const info=document.querySelector('#metadata-test .promptstudio-model-info').getBoundingClientRect();
    const remove=document.querySelector('#metadata-test .promptstudio-lora-remove').getBoundingClientRect();
    const select=document.querySelector('#metadata-models select').getBoundingClientRect();
    const modelInfo=document.querySelector('#metadata-models .promptstudio-model-info').getBoundingClientRect();
    return {info:{width:info.width,height:info.height,y:info.y},remove:{width:remove.width,height:remove.height,y:remove.y},
      modelWidth:modelInfo.width,modelHeight:modelInfo.height,modelCentered:Math.abs(select.y+select.height/2-modelInfo.y-modelInfo.height/2)<1,
      modelOneLine:modelInfo.x>=select.right};
  });
  assert.deepEqual(aligned.info,aligned.remove,'LoRA details must match Remove size and alignment');
  assert.equal(aligned.modelWidth,aligned.remove.width);
  assert.equal(aligned.modelHeight,aligned.remove.height);
  assert.equal(aligned.modelCentered && aligned.modelOneLine,true,'Model selector and details must share one row');
  assert.equal(await group.locator('.promptstudio-lora-row').evaluate(row=>row.children[row.children.length-2].classList.contains('promptstudio-model-info')),true);
  await page.waitForFunction(()=>document.querySelector('#metadata-test .promptstudio-model-info').dataset.updateAvailable==='true');
  assert.ok(calls.some(call=>call.method==='POST' && call.name==='Style/portrait.safetensors'),'LoRA details must populate without opening the popup');
  assert.ok(calls.some(call=>call.method==='POST' && call.category==='diffusion_models'),'Model details must populate without opening the popup');
  const strength=group.getByRole('spinbutton');
  await strength.fill('0.65'); await strength.press('Tab');
  await info.click();
  // Keep matching the closed element until the close handler removes it.
  const dialog=page.locator('dialog[aria-label="LoRA details"]');
  await dialog.getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
  assert.equal(await info.textContent(),'↑');
  assert.equal(await dialog.locator('img').count(),0,'Author HTML must remain inert text');
  assert.equal(await page.evaluate(()=>window.metadataXss),undefined);
  assert.ok((await dialog.textContent()).includes('New version available: v2'));
  assert.equal(await dialog.getByRole('link',{name:'View newer version on Civitai'}).getAttribute('href'),'https://civitai.red/models/2?modelVersionId=11');
  await dialog.screenshot({path:'test-results/model-metadata-desktop.png'});
  await page.evaluate(()=>{window.copiedTrigger='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedTrigger=text;}}});});
  await dialog.getByRole('button',{name:'exact_TRIGGER',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copiedTrigger),'exact_TRIGGER');
  for (const site of ['civitai.com','civitai.green','civitai.red']) {
    await dialog.getByRole('combobox',{name:'Civitai site'}).selectOption(site);
    await page.waitForFunction(()=>!document.querySelector('.promptstudio-model-metadata select').disabled);
    assert.equal(calls.at(-1).site,site);
  }
  await page.setViewportSize({width:390,height:844});
  const bounds=await dialog.boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390);
  assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true,'No horizontal overflow on mobile');
  await dialog.screenshot({path:'test-results/model-metadata-mobile.png'});
  await dialog.getByRole('button',{name:'Close',exact:true}).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(node=>node.contains(document.activeElement)),true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await page.locator('.promptstudio-model-metadata').count(),0);
  assert.equal(await info.evaluate(node=>node===document.activeElement),true);
  assert.equal(await strength.inputValue(),'0.65','Details must preserve LoRA strength');
  const before=calls.filter(call=>call.method==='POST').length;
  await info.click();
  await dialog.getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
  assert.equal(calls.filter(call=>call.method==='POST').length,before,'Reopening fresh details must not query Civitai');
  failure=true;
  await dialog.getByRole('button',{name:'Check again',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.promptstudio-metadata-status').textContent.includes('Civitai is offline'));
  assert.equal(await dialog.getByRole('button',{name:'exact_TRIGGER',exact:true}).count(),1,'Cached triggers survive a failed check');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});
  const models=page.locator('#metadata-models');
  await models.locator('select').selectOption('Base/second.safetensors');
  await models.locator('.promptstudio-model-info').click();
  await page.getByRole('dialog',{name:'Model details'}).getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
  assert.equal(calls.at(-1).category,'diffusion_models');
  assert.equal(calls.at(-1).name,'Base/second.safetensors');
  await page.keyboard.press('Escape');
  if (videoEnabled) {
    await page.evaluate(async()=>{
      const {createVideoAdapterControls}=await import('/extensions/PromptStudio_Video/js/video-adapter-controls.js');
      const control=createVideoAdapterControls({project:{document:{content_loras:[{name:'MiniMax3/video.safetensors',strength:0.8}],reference_adapters:[]}},
        workflow:{snapshot:{output:{'1':{class_type:'UNETLoader',inputs:{unet_name:'MiniMax3/model.safetensors'}}}}},
        catalog:{adapters:[{category:'loras',name:'MiniMax3/video.safetensors',kind:'lora'}]},onChange:()=>{},onRefresh:()=>{}});
      control.id='video-metadata-test'; document.body.append(control);
    });
    const video=page.locator('#video-metadata-test');
    await video.locator('.promptstudio-lora-row .promptstudio-model-info').click();
    await dialog.getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
    assert.ok(calls.some(call=>call.method==='POST' && call.name==='MiniMax3/video.safetensors'));
    assert.equal(await dialog.locator('.promptstudio-metadata-filename').textContent(),'MiniMax3/video.safetensors');
    await page.keyboard.press('Escape');
    await video.getByText('Workflow model details',{exact:true}).click();
    await video.locator('.psvstudio-workflow-models .promptstudio-model-info').click();
    await page.getByRole('dialog',{name:'Model details'}).getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
    assert.ok(calls.some(call=>call.method==='POST' && call.name==='MiniMax3/model.safetensors'));
    assert.equal(await page.getByRole('dialog',{name:'Model details'}).locator('.promptstudio-metadata-filename').textContent(),'MiniMax3/model.safetensors');
    await page.keyboard.press('Escape');
  }
  // The real standalone host adopts controls created in another document.
  // Styles must be available there before clicking, and dialogs must open there.
  await page.evaluate(async()=>{
    const frame=document.createElement('iframe'); frame.id='metadata-popout';
    Object.assign(frame.style,{position:'fixed',inset:'0',width:'520px',height:'850px',zIndex:100000});
    document.body.append(frame);
    const target=frame.contentDocument;
    const css=target.createElement('link'); css.rel='stylesheet';
    css.href='/extensions/ComfyUI_PromptStudio/css/prompt_studio.css';
    const loaded=new Promise((resolve,reject)=>{css.onload=resolve;css.onerror=reject;});
    target.head.append(css); await loaded;
    const root=target.createElement('div'); root.id='promptstudio-prompt-studio';
    Object.assign(root.style,{position:'static',display:'block',width:'480px',padding:'8px'});
    target.body.style.background='#151923'; target.body.append(root);
    root.append(target.adoptNode(document.querySelector('#metadata-test')),target.adoptNode(document.querySelector('#metadata-models')));
  });
  const popout=page.frameLocator('#metadata-popout');
  assert.equal(await popout.locator('.promptstudio-model-selection').evaluate(node=>getComputedStyle(node).display),'grid');
  await popout.locator('#metadata-test .promptstudio-model-info').click();
  await popout.getByRole('dialog',{name:'LoRA details'}).getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
  assert.equal(await page.locator('.promptstudio-model-metadata[open]').count(),0,'Popup must not open in the original document');
  await popout.getByRole('button',{name:'Close',exact:true}).click();
  await popout.getByRole('dialog').waitFor({state:'detached'});
  await popout.locator('#metadata-models .promptstudio-model-info').click();
  await popout.getByRole('dialog',{name:'Model details'}).getByRole('button',{name:'exact_TRIGGER',exact:true}).waitFor();
  await popout.getByRole('button',{name:'Close',exact:true}).click();
  await popout.getByRole('dialog').waitFor({state:'detached'});
  await page.locator('#metadata-popout').screenshot({path:'test-results/model-metadata-popout-controls.png'});
  assert.deepEqual(fixture.errors,[]);
  console.log(`Model metadata UI passed (${videoEnabled?'Image + Video':'Image'}): hash lookup wiring, domains, update badge, cache, errors, copy, focus, mobile, model selection.`);
} finally {await fixture.close();}
