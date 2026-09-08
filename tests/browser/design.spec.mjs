import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startFixture,attachVideo,root} from './fixture.mjs';
const fixture=await startFixture();
try {
 const page=await fixture.newPage();
 await mkdir(resolve(root,'test-results/browser'),{recursive:true});
 const imageTokens=await page.locator('#promptstudio-prompt-studio').evaluate(el=>{
  const style=getComputedStyle(el);return ['--studio-accent','--studio-control-height','--studio-panel'].map(key=>style.getPropertyValue(key).trim());
 });
 await attachVideo(page);
 const videoTokens=await page.locator('.psvstudio-app').evaluate(el=>{
  const style=getComputedStyle(el);return ['--studio-accent','--studio-control-height','--studio-panel'].map(key=>style.getPropertyValue(key).trim());
 });
 assert.deepEqual(videoTokens,imageTokens);
 await page.locator('#psvstudio-new-project').click();
 await page.locator('#psvstudio-project-title').fill('A very long project and model profile name '.repeat(12));
 await page.waitForFunction(()=>document.querySelector('#psvstudio-save-state').textContent==='Saved');
 // Baseline screenshots use committed styles; unrelated pre-existing CSS edits
 // are preserved in the after screenshots and are not attributed to this task.
 const baseline=await fixture.context.newPage();
 const imageBefore=execFileSync('git',['show','HEAD:web/css/prompt_studio.css'],{cwd:root,encoding:'utf8'});
 const videoRoot=resolve(root,'../PromptStudio_Video');
 const videoBefore=execFileSync('git',['-c',`safe.directory=${videoRoot.replaceAll('\\','/')}`,'show','HEAD:web/css/promptstudio_video_studio.css'],{cwd:videoRoot,encoding:'utf8'});
 await baseline.route('**/css/prompt_studio.css*',route=>route.fulfill({contentType:'text/css',body:imageBefore}));
 await baseline.route('**/css/promptstudio_video_studio.css*',route=>route.fulfill({contentType:'text/css',body:videoBefore}));
 await baseline.goto(fixture.origin);
 await baseline.waitForFunction(()=>window.studioReady||window.bootError);
 await baseline.screenshot({path:resolve(root,'test-results/browser/image-design-before.png')});
 await attachVideo(baseline);
 await baseline.screenshot({path:resolve(root,'test-results/browser/video-design-before.png')});
 await baseline.close();
 for(const width of [1440,768,390]) {
  await page.setViewportSize({width,height:1000});
  const bounds=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  assert.equal(bounds.scroll,bounds.client,`Video document overflow at ${width}px: ${JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth && el.getBoundingClientRect().width).slice(0,8).map(el=>({tag:el.tagName,id:el.id,class:el.className,right:el.getBoundingClientRect().right}))))}`);
  await page.screenshot({path:resolve(root,`test-results/browser/video-design-${width}.png`)});
 }
 // A 1440px desktop at 200% browser zoom has a 720px CSS layout viewport.
 // CSS zoom on <html> does not change media-query width and is not equivalent.
 await page.setViewportSize({width:720,height:500});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true,'200% equivalent layout viewport must not overflow document');
 await page.screenshot({path:resolve(root,'test-results/browser/video-design-zoom200.png')});
 // Embedded host controls must not inherit Studio resets or tokens.
 const host=await fixture.context.newPage();
 await host.goto(fixture.origin);
 await host.waitForFunction(()=>window.studioReady||window.bootError);
 await host.evaluate(()=>{document.body.className='';const control=document.createElement('button');control.id='host-probe';control.textContent='Native host';document.body.append(control);});
 assert.equal(await host.locator('#host-probe').evaluate(el=>getComputedStyle(el).getPropertyValue('--studio-accent').trim()),'');
 assert.deepEqual(fixture.errors,[]);
 console.log('Shared tokens, narrow layouts, long labels, 200% equivalent layout viewport and host isolation passed.');
} finally {await fixture.close();}
