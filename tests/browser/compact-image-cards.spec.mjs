import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {startFixture,root} from './fixture.mjs';
const fixture=await startFixture({contextOptions:{hasTouch:true}});
try {
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+`
      window.imageCardTest={state,appendMessage,renderChatHistory};
      window.cardActions=[];
      requestImageUpscale=async reference=>window.cardActions.push(['upscale',reference]);
      captionImageIntoPrompts=async reference=>window.cardActions.push(['caption',reference]);
      handoffImageToVideoStudio=async reference=>window.cardActions.push(['video',reference]);
      videoHandoffAvailability=()=>({available:true,reason:'Ready'});
    `});
  });
  await fixture.context.route('**/view?*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#304966"/><circle cx="580" cy="130" r="70" fill="#e7b97e"/><path d="M0 500L280 120L650 500M330 500L650 240L800 500" fill="#192c3d"/></svg>'}));
  const page=await fixture.newPage();
  await page.evaluate(()=>{
    const {appendMessage,state}=window.imageCardTest;
    state.apiConnected=true;
    appendMessage('assistant','',{messageId:'compact-result',canonicalPrompt:'Saved landscape',mainPrompt:'Mountains',workflowName:'Saved workflow',
      images:[{filename:'first.png',type:'output',width:800,height:500},{filename:'second.png',type:'output',width:800,height:500}],
      generationSnapshot:{workflow:{nodes:[],links:[]},output:{'1':{class_type:'Sampler',inputs:{seed:42}}}}});
  });
  const message=page.locator('[data-message-id="compact-result"]'), cards=message.locator('.promptstudio-image-card');
  const sheet=page.getByRole('dialog',{name:'Image actions',exact:true});
  await mkdir(resolve(root,'test-results/browser'),{recursive:true});
  for(const width of [390,820,1366,1600,1920]) {
    await page.setViewportSize({width,height:1000});
    await page.waitForFunction(()=>parseFloat(document.querySelector('#promptstudio-prompt-studio').style.getPropertyValue('--studio-viewport-height'))===innerHeight);
    await cards.first().scrollIntoViewIfNeeded();
    assert.equal(await message.evaluate(n=>getComputedStyle(n).paddingTop),'0px');
    assert.equal(await message.evaluate(n=>getComputedStyle(n).paddingRight),'0px');
    assert.equal(await message.locator(':scope > .promptstudio-message-delete').isVisible(),false);
    const image=await cards.first().locator('.promptstudio-image-preview').boundingBox();
    const row=await cards.first().locator('.promptstudio-image-compact-actions').boundingBox();
    assert.ok(row.height>=44 && row.height<=48,JSON.stringify(row));
    assert.ok(Math.abs(row.y-image.y-image.height)<2 && Math.abs(row.width-image.width)<2);
    await cards.first().getByRole('button',{name:'Details',exact:true}).tap();
    const details=page.getByRole('dialog',{name:'Image details',exact:true});
    await details.waitFor();
    assert.match(await details.innerText(),/Saved landscape/);
    assert.equal(await details.evaluate(n=>n.scrollWidth<=n.clientWidth),true);
    assert.equal(await cards.first().locator('.promptstudio-image-preview').evaluate(n=>n.getBoundingClientRect().height),image.height);
    await page.keyboard.press('Escape');await details.waitFor({state:'detached'});
    assert.equal(await cards.first().getByRole('button',{name:'Details',exact:true}).evaluate(n=>n===document.activeElement),true);
    await page.screenshot({path:resolve(root,`test-results/browser/compact-images-${width}.png`)});
  }
  await page.setViewportSize({width:390,height:844});
  for(const [label,action] of [['Caption image','caption'],['Upscale image','upscale'],['Send to Video','video']]) {
    await cards.nth(1).getByRole('button',{name:'More actions for second.png'}).tap();
    await sheet.waitFor();
    assert.equal(await sheet.evaluate(n=>n.scrollWidth<=n.clientWidth),true);
    await sheet.getByRole('button',{name:label,exact:true}).tap();
    await sheet.waitFor({state:'detached'});
    await page.waitForFunction(a=>window.cardActions.at(-1)?.[0]===a,action);
    assert.equal(await page.evaluate(()=>window.cardActions.at(-1)[1].filename),'second.png');
  }
  await cards.nth(1).getByRole('button',{name:'Edit image',exact:true}).tap();
  assert.equal(await page.evaluate(()=>{const s=window.imageCardTest.state;return s.chats.find(c=>c.id===s.activeChatId).selectedSource.filename;}),'second.png');
  await cards.nth(1).getByRole('button',{name:'More actions for second.png'}).tap();
  const audit=await new AxeBuilder({page}).include('.promptstudio-image-sheet').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(audit.violations.map(v=>v.id),[]);
  await sheet.getByRole('button',{name:'Delete message…',exact:true}).tap();
  const confirmation=page.locator('#promptstudio-message-delete-dialog');
  await confirmation.waitFor({state:'visible'});
  assert.equal(await sheet.count(),0,'Sheet dismisses before deletion confirmation');
  await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await message.count(),1,'Cancellation preserves the entire multi-image message');
  await cards.first().getByRole('button',{name:'More actions for first.png'}).tap();
  await page.evaluate(()=>{const {state,renderChatHistory}=window.imageCardTest;state.chats.find(c=>c.id===state.activeChatId).messages=[];renderChatHistory();});
  await sheet.waitFor({state:'detached'});
  await page.evaluate(()=>window.imageCardTest.appendMessage('assistant','',{canonicalPrompt:'Desktop',images:[{filename:'desktop.png',type:'output',width:800,height:500}]}));
  // Switch the emulated input to an actual mouse-only desktop; width alone
  // must not turn a wide touch tablet back into desktop cards.
  const desktopInput=await fixture.context.newCDPSession(page);
  await desktopInput.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.evaluate(()=>matchMedia('(any-pointer: coarse)').matches),false);
  assert.equal(await page.locator('.promptstudio-image-compact-actions').isVisible(),false);
  assert.equal(await page.locator('.promptstudio-image-actions').isVisible(),true);
  assert.equal(await page.locator('.promptstudio-prompt-info > summary').isVisible(),true);
  assert.deepEqual(fixture.errors,[]);
  console.log('Compact image cards: row geometry, phone/tablet details, per-image actions, modal precedence, focus, accessibility, removal and desktop passed.');
}finally{await fixture.close();}
