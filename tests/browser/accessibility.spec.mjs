import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {startFixture,attachVideo,root} from './fixture.mjs';
const fixture=await startFixture();
const reports=[];
try {
 const page=await fixture.newPage();
 const scan=async(label,scope)=>{
  const result=await new AxeBuilder({page}).include(scope).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  reports.push({label,violations:result.violations,incomplete:result.incomplete});
  console.log(label,JSON.stringify(result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))));
 };
 await scan('image','#promptstudio-prompt-studio');
 const reorder = page.locator('details[data-promptstudio-sidebar-group] > summary').first();
 const group = await reorder.evaluate(el=>el.parentElement.dataset.promptstudioSidebarGroup);
 await reorder.focus();
 await page.keyboard.press('Alt+ArrowDown');
 assert.equal(await page.locator('details[data-promptstudio-sidebar-group]').nth(1).getAttribute('data-promptstudio-sidebar-group'),group);
 await page.keyboard.press('Alt+ArrowUp');
 await page.locator('#promptstudio-toggle-studio-settings').click();
 await page.locator('#promptstudio-open-backend-settings').click();
 await scan('backend dialog','#promptstudio-backend-settings-dialog');
 for(const key of ['Tab','Shift+Tab']) for(let i=0;i<30;i++) {
  await page.keyboard.press(key);
  assert.equal(await page.locator('#promptstudio-backend-settings-dialog').evaluate(el=>el.contains(document.activeElement)),true);
 }
 await page.keyboard.press('Escape');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('[aria-modal="true"]:visible').count(),0);
 await attachVideo(page);
 await page.locator('#psvstudio-new-project').click();
 await scan('video','.psvstudio-app');
 await page.getByRole('button',{name:'Edit shot',exact:true}).click();
 await page.locator('dialog[open]').waitFor();
 await scan('shot dialog','dialog[open]');
 for(const key of ['Tab','Shift+Tab']) for(let i=0;i<30;i++) {
  await page.keyboard.press(key);
  assert.equal(await page.locator('dialog[open]').evaluate(el=>el.contains(document.activeElement)),true);
 }
 await page.keyboard.press('Escape');
 await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
 assert.equal(await page.locator('dialog[open]').count(),0);
 assert.equal(await page.locator('#psvstudio-status').getAttribute('aria-live'),'polite');
 await scan('forced colors','.psvstudio-app');
 assert.deepEqual(fixture.errors,[]);
 await mkdir(resolve(root,'test-results/browser'),{recursive:true});
 await page.screenshot({path:resolve(root,'test-results/browser/forced-colors.png')});
 await writeFile(resolve(root,'test-results/browser/accessibility.json'),JSON.stringify(reports,null,2));
 assert.equal(reports.reduce((count,report)=>count+report.violations.length,0),0,'Accessibility findings require repair');
} finally {await fixture.close();}
