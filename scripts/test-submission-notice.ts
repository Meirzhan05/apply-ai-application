import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {initialDemoState} from '../src/lib/demo-data';
import {draftPacket} from '../src/lib/drafting';
import {selectApplication,setPacket} from '../src/lib/workflow';
import {publicState} from '../src/lib/public-state';
async function main(){
 process.env.DEMO_MODE='true';delete process.env.OPENAI_API_KEY;
 const state=initialDemoState();const app=selectApplication(state,state.jobs[0].id,state.profile.id);
 const packet=await draftPacket(state.profile,state.jobs[0]);packet.answers=[];setPacket(state,app,packet);
 app.status='uncertain';app.submissionStartedAt='2026-09-30T23:09:08Z';app.submissionAttemptedAt='2026-09-30T23:09:21Z';
 app.manualSubmissionReport={source:'owner',outcome:'unconfirmed',reportedAt:'2026-09-30T20:58:00Z',siteMessage:'Previous manual attempt',resolution:{outcome:'not_accepted',reviewedAt:'2026-09-30T21:40:00Z',previousApprovals:[]}};
 app.confirmation=`Submission attempted; confirmation could not be verified at https://employer.example/${'long-application-path-'.repeat(12)}`;
 app.form={version:1,url:state.jobs[0].applyUrl,hash:'previous',capturedAt:'2026-09-30T22:59:48Z',fields:[{label:'First name',kind:'text',value:state.profile.name.split(' ')[0]}],attachments:['resume.pdf'],readyToSubmit:true};
 state.applications=[app];await mkdir('.data',{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||undefined});
 try{for(const scenario of ['blocked','ambiguous'])for(const [label,width,height]of [['desktop',1440,1000],['mobile',390,844]]as const){
  app.submissionReceipt={version:1,url:state.jobs[0].applyUrl,capturedAt:'2026-09-30T23:09:43Z',screenshotPath:`/api/screenshots/${app.id}?phase=confirmation`,text:scenario==='blocked'?"We couldn't submit your application\nYour application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again.":'Processing request'};
  const fixture=publicState(state);const page=await browser.newPage({viewport:{width,height}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/state',route=>route.fulfill({json:fixture}));await page.route('**/api/status',route=>route.fulfill({contentType:'text/event-stream',body:`event: state\ndata: ${JSON.stringify(fixture)}\n\n`}));
  await page.goto(process.env.TEST_DASHBOARD_URL||'http://localhost:3000');await page.getByRole('button',{name:'Applications',exact:true}).click();
  await page.getByText(scenario==='blocked'?'Employer blocked submission':'Submission result uncertain',{exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'View submission screenshot ↗',exact:true}).getAttribute('href'),app.submissionReceipt.screenshotPath);
  assert.equal(await page.getByRole('link',{name:'Open employer application ↗',exact:true}).count(),scenario==='blocked'?1:0);
  assert.equal(await page.getByRole('button',{name:'Return to materials review',exact:true}).count(),0);
  assert.equal(await page.getByText('The previous browser run has stopped.',{exact:false}).count(),0);
  assert.match(await page.locator('.warning-note').innerText(),/Sep 30, 2026.*7:09 PM/);
  assert.match(await page.locator('.warning-note').innerText(),/will not retry automatically/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await page.locator('.warning-note').screenshot({path:`.data/submission-notice-${scenario}-${label}.png`});
  console.log(`PASS ${scenario} ${label}: actual employer response, receipt proof, no stale report or retry, no overflow`);await page.close();
 }}finally{await browser.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
