import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
const releases = [];
let requests = 0;
let completed = 0;
let fail = false;
let reached = Promise.withResolvers();
const snapshot = {status:'found',name:'Saved LoRA',trigger_words:['saved trigger'],
  description:'Saved author notes',refresh_due:true,update_status:'current',version:{name:'Saved version'}};
try {
  await fixture.context.route('**/prompt-studio/model-metadata**', async route => {
    if (route.request().method() === 'POST') {
      requests++;
      await new Promise(resolve => { releases.push(resolve); reached.resolve(); });
      completed++;
      return route.fulfill({status:fail ? 503 : 200,json:fail ? {error:'Civitai unavailable'} : {...snapshot,trigger_words:['updated trigger'],refresh_due:false}});
    }
    await route.fulfill({json:snapshot});
  });
  const page = await fixture.newPage();
  const check = async name => {
    const before = requests;
    reached = Promise.withResolvers();
    await page.evaluate(async name => {
      const {createModelDetailsButton} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/model-metadata.js');
      const button = createModelDetailsButton({name}); button.id='background-test'; document.body.append(button);
    }, name);
    await page.locator('#background-test').click();
    const dialog = page.getByRole('dialog',{name:'LoRA details',exact:true});
    await dialog.getByRole('button',{name:'saved trigger',exact:true}).waitFor({timeout:2000});
    assert.ok((await dialog.textContent()).includes('Saved author notes'));
    assert.equal(completed, before, 'Saved content must render while remote work is still blocked');
    await dialog.getByRole('button',{name:'Edit trigger words',exact:true}).click();
    const editor = page.getByRole('dialog',{name:'Edit trigger words',exact:true});
    await editor.getByRole('textbox',{name:'Trigger word',exact:true}).fill('unsaved draft');
    await reached.promise;
    assert.ok(releases.length);
    const refreshed = page.waitForResponse(response=>response.url().includes('model-metadata') && response.request().method()==='POST');
    releases.splice(0).forEach(resolve=>resolve());
    await refreshed;
    // A remote response updates the details without replacing an open edit draft.
    assert.equal(await editor.getByRole('textbox',{name:'Trigger word',exact:true}).inputValue(),'unsaved draft');
    await editor.getByRole('button',{name:'Cancel',exact:true}).click();
    await dialog.getByRole('button',{name:'updated trigger',exact:true}).waitFor({timeout:2000});
    fail = true;
    reached = Promise.withResolvers();
    await dialog.getByRole('button',{name:'Check again',exact:true}).click();
    await reached.promise;
    releases.splice(0).forEach(resolve=>resolve());
    await dialog.getByText(/Saved details remain available/).waitFor({timeout:2000});
    assert.equal(await dialog.getByRole('button',{name:'updated trigger',exact:true}).count(),1);
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await page.locator('#background-test').evaluate(node=>node.remove());
    fail = false;
  };
  await check('image-cached.safetensors');
  if (videoEnabled) {await attachVideo(page); await check('video-cached.safetensors');}
  assert.deepEqual(fixture.errors,[]);
  console.log('Saved details render before remote refresh; editing and failure retention passed in both studios.');
} finally {releases.splice(0).forEach(resolve=>resolve()); await fixture.close();}
