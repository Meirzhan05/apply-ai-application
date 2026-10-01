import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {initialDemoState} from '../src/lib/demo-data';
import {selectApplication} from '../src/lib/workflow';
import {publicState} from '../src/lib/public-state';
import {mkdir} from 'node:fs/promises';
async function main(){
 const state=initialDemoState(); const app=selectApplication(state,state.jobs[0].id,state.profile.id);
 app.status='filling';app.browserProvider='browser-use';app.browserSessionId='test-visible-session';
 app.browserLiveUrl='https://live.browser-use.com/session/synthetic-view';app.browserConnectUrl='wss://private-connection.example';
 app.browserActions=[{at:new Date().toISOString(),label:'Opening the employer form'},...Array.from({length:8},(_,i)=>({at:new Date(Date.now()+i+1).toISOString(),label:`Checked: Test question ${i+1}`})),{at:new Date(Date.now()+10).toISOString(),label:'Uploaded: Resume'}];
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||undefined});await mkdir('.data',{recursive:true});
 try{for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
  const page=await browser.newPage({viewport:{width,height}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://live.browser-use.com/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Synthetic live browser</h1><label>Phone<input aria-label="Phone"></label>'}));
  let fixture=publicState(state);
  await page.route('**/api/state',r=>r.fulfill({json:fixture}));await page.route('**/api/status',r=>r.fulfill({contentType:'text/event-stream',body:`event: state\ndata: ${JSON.stringify(fixture)}\n\n`}));
  await page.goto(process.env.TEST_DASHBOARD_URL||'http://localhost:3000');await page.getByRole('button',{name:'Applications',exact:true}).click();
  const panel=page.getByRole('region',{name:'Agent browser',exact:true});await panel.waitFor();
  assert.equal(await panel.locator('.live-browser-screen').getAttribute('inert'),'');assert.equal(await panel.getByRole('button',{name:'Take control',exact:true}).count(),0);
  assert.ok(await panel.getByText('Uploaded: Resume',{exact:true}).isVisible());
  assert.ok(await panel.getByRole('list',{name:'Agent action history'}).evaluate(el=>el.scrollTop)>0);
  assert.equal(await panel.locator('iframe').getAttribute('src'),app.browserLiveUrl);
  app.status='needs_user_action';fixture=publicState(state);await page.reload();await page.getByRole('button',{name:'Applications',exact:true}).click();
  await panel.getByRole('button',{name:'Take control',exact:true}).click();assert.equal(await panel.locator('.live-browser-screen').getAttribute('inert'),null);
  assert.equal(await panel.locator('iframe').getAttribute('tabindex'),'0');
  await panel.getByRole('button',{name:'Return to watch mode',exact:true}).click();assert.equal(await panel.locator('.live-browser-screen').getAttribute('inert'),'');
  assert.equal(await panel.getByRole('link',{name:'Open browser window'}).getAttribute('href'),app.browserLiveUrl);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await panel.screenshot({path:`.data/live-browser-${name}.png`});
  // Refreshing a mounted review must request a new screenshot even though
  // private storage deliberately reuses the application's screenshot path.
  const captures:string[]=[];
  await page.route('**/api/screenshots/**',r=>{captures.push(r.request().url());return r.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=','base64')});});
  app.status='final_review';app.form={version:1,url:state.jobs[0].applyUrl,fields:[{label:'Phone',kind:'tel',value:'555-0100'}],attachments:[],hash:'before',capturedAt:'2026-09-30T12:00:00.000Z',screenshotPath:`/api/screenshots/${app.id}?phase=form`,readyToSubmit:true};fixture=publicState(state);
  await page.reload();await page.getByRole('button',{name:'Applications',exact:true}).click();
  const shot=page.getByAltText('Filled application form screenshot');await shot.waitFor();
  const before=await shot.getAttribute('src');
  await page.route('**/api/actions',r=>{assert.equal(r.request().postDataJSON().action,'resumeBrowser');app.form={...app.form!,hash:'after',capturedAt:'2026-09-30T12:01:00.000Z',fields:[{label:'Phone',kind:'tel',value:'555-0101'}]};fixture=publicState(state);return r.fulfill({json:{ok:true}});});
  await page.getByRole('button',{name:'Refresh form state',exact:true}).click();
  await page.getByText('555-0101',{exact:true}).waitFor();
  const after=await shot.getAttribute('src');assert.notEqual(after,before);
  await page.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>('.form-shot');return image?.complete && image.naturalWidth>0;});
  assert.ok(captures.some(url=>url.endsWith(before!)));assert.ok(captures.some(url=>url.endsWith(after!)));
  app.status='uncertain';fixture=publicState(state);await page.reload();await page.getByRole('button',{name:'Applications',exact:true}).click();assert.equal(await panel.count(),0);
  console.log(`PASS ${name}: live panel, action history, inert watch mode, paused takeover, refreshed screenshot, terminal viewer hidden, no overflow`);
  app.status='filling';await page.close();
 }}finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
