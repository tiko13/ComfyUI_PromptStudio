import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,attachVideo,root,videoEnabled} from './fixture.mjs';
const fixture=await startFixture({contextOptions:{hasTouch:true}});
const sizes=[ [320,740], [390,844], [768,1024], [820,1180], [1024,1366], [1194,834], [1366,1024], [1440,1000], [1600,1200], [1920,1080], [844,390], [390,480] ];
try {
  await mkdir(resolve(root,'test-results/browser'),{recursive:true});
  const page=await fixture.newPage();
  await page.locator('#promptstudio-revision').fill('Keep this draft through rotation');
  const fits=async(selector)=> {
    const box=await page.locator(selector).boundingBox();
    const {width,height}=page.viewportSize();
    assert.ok(box && box.width>0 && box.x>=-1 && box.y>=-1 && box.x+box.width<=width+1 && box.y+box.height<=height+1, `${selector} outside ${width}x${height}: ${JSON.stringify(box)}`);
  };
  const drawerCheck=async(trigger,drawer,close)=>{
    assert.equal(await page.locator(drawer).evaluate(n=>n.inert),true,'Closed drawer is excluded from focus');
    await page.locator(trigger).tap();
    await page.waitForFunction(s=>document.querySelector(s).contains(document.activeElement),drawer);
    await fits(drawer);
    const drawerBox=await page.locator(drawer).boundingBox();
    await page.locator(drawer).evaluate(n=>{
      const controls=[...n.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest('[inert]'));
      controls.at(-1).focus();
    });
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(drawer).evaluate(n=>n.contains(document.activeElement)),true,'Tab remains in open drawer');
    await page.locator(close).tap();
    await page.waitForFunction(s=>document.querySelector(s).inert,drawer);
    assert.equal(await page.locator(trigger).evaluate(n=>n===document.activeElement),true,'Done restores trigger focus');
    await page.locator(trigger).tap();
    await page.keyboard.press('Escape');
    await page.waitForFunction(s=>document.querySelector(s).inert,drawer);
    assert.equal(await page.locator(trigger).evaluate(n=>n===document.activeElement),true,'Escape restores trigger focus');
    if (drawerBox && drawerBox.width < page.viewportSize().width - 4) {
      await page.locator(trigger).tap();
      const openBox=await page.locator(drawer).boundingBox();
      await page.getByRole('button',{name:'Close open drawer',exact:true}).tap({position:{
        x:openBox.x>1 ? 1 : page.viewportSize().width-1, y:100,
      }});
      await page.waitForFunction(s=>document.querySelector(s).inert,drawer);
      assert.equal(await page.locator(trigger).evaluate(n=>n===document.activeElement),true,'Backdrop restores trigger focus');
    }
  };
  for(const [width,height] of sizes){
    await page.setViewportSize({width,height});
    await page.waitForFunction(() => [...document.querySelectorAll('#promptstudio-prompt-studio, .psvstudio-app')].filter(n=>n.getClientRects().length).every(n=>parseFloat(n.style.getPropertyValue('--studio-viewport-height')) === innerHeight));
    await fits('#promptstudio-prompt-studio');
    await fits('#promptstudio-revision');
    // Scroll the composer if a small keyboard-sized viewport needs it.
    await page.locator('#promptstudio-send').scrollIntoViewIfNeeded();
    await fits('#promptstudio-send');
    assert.equal(await page.locator('#promptstudio-revision').inputValue(),'Keep this draft through rotation');
    const phone=width<=780||(width<=900&&height<=600);
    const tablet=!phone; // Touch devices keep tablet controls at wider/zoomed-out sizes.
    if(phone||tablet){
      await drawerCheck('#promptstudio-mobile-toggle-chats','.promptstudio-chat-sidebar','#promptstudio-close-chats');
      if(phone) await drawerCheck('#promptstudio-mobile-toggle-inspector','.promptstudio-inspector','#promptstudio-close-inspector');
      else {
        await fits('.promptstudio-inspector');
        const main=await page.locator('.promptstudio-main').boundingBox(), inspector=await page.locator('.promptstudio-inspector').boundingBox();
        assert.ok(inspector.x>=main.x+main.width-1,'Tablet controls stay alongside the conversation');
      }
    }
    if([390,820,1366].includes(width)&&height>600)await page.screenshot({path:resolve(root,`test-results/browser/image-touch-${width}.png`)});
  }
  if(videoEnabled){
    await page.setViewportSize({width:1366,height:1024});await attachVideo(page);
    await page.locator('#psvstudio-mobile-projects').click();
    await page.locator('#psvstudio-new-project').click();
    if(await page.locator('#psvstudio-close-projects').isVisible())await page.locator('#psvstudio-close-projects').click();
    await page.locator('#psvstudio-project-title').fill('Tablet project');
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});
      await page.waitForFunction(() => [...document.querySelectorAll('#promptstudio-prompt-studio, .psvstudio-app')].filter(n=>n.getClientRects().length).every(n=>parseFloat(n.style.getPropertyValue('--studio-viewport-height')) === innerHeight));
      await fits('.psvstudio-app');await fits('.psvstudio-main');await fits('.psvstudio-topbar');await fits('#psvstudio-generate');
      assert.equal(await page.locator('#psvstudio-project-title').inputValue(),'Tablet project');
      if(await page.evaluate(()=>matchMedia('(max-width: 1400px), (any-pointer: coarse)').matches)){
        await drawerCheck('#psvstudio-mobile-projects','.psvstudio-sidebar','#psvstudio-close-projects');
        if(width<=780||(width<=900&&height<=600))await drawerCheck('#psvstudio-mobile-inspector','.psvstudio-inspector','#psvstudio-close-inspector');
        else await fits('.psvstudio-inspector');
        await page.locator('.psvstudio-tools-menu > summary').tap();
        await page.locator('#psvstudio-reset').scrollIntoViewIfNeeded();await fits('#psvstudio-reset');
        await page.keyboard.press('Escape');
      }
      if([390,820,1366].includes(width)&&height>600)await page.screenshot({path:resolve(root,`test-results/browser/video-touch-${width}.png`)});
    }
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Phone/tablet/desktop: bounds, drawer focus, reachable actions, scrolling tools, rotation and preserved drafts passed.');
}finally{await fixture.close();}
