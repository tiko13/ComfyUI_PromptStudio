import assert from 'node:assert/strict';
import {startFixture,attachVideo,config} from './fixture.mjs';
const fixture=await startFixture();
try {
 const projects=Array.from({length:65},(_,i)=>({id:`p${i}`,name:`Session ${i}`,document:structuredClone(config.default_document),generations:[],created_at:1000-i,updated_at:1000-i,workflow_id:'',additional_input_selections:{}}));
 fixture.projects={revision:1,projects,active_project_id:'p0',deletedProjectIds:[]};
 const page=await fixture.newPage();
 await attachVideo(page);
 assert.equal(await page.locator('.psvstudio-project-row').count(),20);
 await page.locator('#psvstudio-project-title').fill('Only this session changed');
 await page.waitForFunction(()=>document.querySelector('#psvstudio-save-state')?.textContent==='Saved');
 const save=fixture.requests.filter(request=>request.path.endsWith('/projects')&&request.method==='PUT').at(-1);
 assert.deepEqual(save.projectIds,['p0']);
 assert.equal(fixture.projects.projects.length,65);
 await page.getByRole('button',{name:'Load older projects',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.psvstudio-project-row').length===40);
 assert.equal(fixture.projects.projects.length,65);
 await page.reload();
 await page.waitForFunction(()=>window.studioReady);
 await attachVideo(page);
 assert.equal(await page.locator('#psvstudio-project-title').inputValue(),'Only this session changed');
 assert.equal(await page.locator('.psvstudio-project-row').count(),20);
 assert.deepEqual(fixture.errors,[]);
 console.log('History paging, one-record saves, retained unloaded sessions and reload passed.');
} finally {await fixture.close();}
