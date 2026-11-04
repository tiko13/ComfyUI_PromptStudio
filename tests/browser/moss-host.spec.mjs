import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
import {mossCatalog,mossProfile} from '../moss-fixture.mjs';

const fixture=await startFixture();
const profile=await mossProfile(mossCatalog.find(p=>p.id==='moss_sft_controlled'));
try {
  await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.mossHostActions={refreshAdditionalInputsSection,flushChatStore};'});
  });
  await fixture.context.route('**/moss-standalone',route=>route.fulfill({contentType:'text/html',body:
    '<!doctype html><html><body><main id="promptstudio-image-mount"></main><iframe name="moss-host" src="/" style="position:fixed;width:1px;height:1px;opacity:0;pointer-events:none"></iframe></body></html>'}));
  const page=await fixture.context.newPage();await page.goto(fixture.origin+'/moss-standalone');
  const host=page.frame({name:'moss-host'});
  await host.waitForFunction(()=>window.studioReady||window.bootError);
  assert.equal(await host.evaluate(()=>window.bootError),undefined);
  await host.evaluate(async profile=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await window.__promptstudioPromptStudioHost.attach(parent);
    state.workflowProfiles=[profile];
    const select=state.panel.querySelector('#promptstudio-create-workflow');
    select.replaceChildren(new Option(profile.name,profile.id));select.value=profile.id;
    window.mossHostActions.refreshAdditionalInputsSection();
    state.panel.querySelector('#promptstudio-additional-inputs-details').open=true;
  },profile);
  const button=page.getByRole('button',{name:'Layout and control maps',exact:true});await button.click();
  const dialog=page.getByRole('dialog',{name:'Layout and control maps',exact:true});
  assert.equal(await dialog.count(),1,'Standalone dialog belongs to the visible document, not its hidden workflow host');
  assert.equal(await host.locator('.ps-spatial-editor').count(),0);
  assert.equal(await page.locator('link[data-spatial-editor]').count(),1);
  await dialog.getByRole('button',{name:'Add character',exact:true}).click();
  await dialog.getByRole('button',{name:'Apply',exact:true}).click();await dialog.waitFor({state:'detached'});
  await host.evaluate(()=>window.mossHostActions.flushChatStore());
  const chat=fixture.chats.chats.find(c=>c.spatialInputs?.[profile.id]);
  assert.equal(chat.spatialInputs[profile.id].elements[0].type,'character');
  await button.click();await dialog.getByRole('button',{name:'Delete',exact:true}).click();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await button.click();assert.equal(await dialog.locator('.ps-spatial-box').count(),1);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.deepEqual(fixture.errors,[]);
  console.log('MOSS standalone hidden-host dialog: visible ownership, stylesheet, Apply persistence and Cancel passed.');
} finally {await fixture.close();}
