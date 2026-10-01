import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const record = {id:'fixture', version:1, userId:'owner', runId:'saved-run', applicationId:'app', jobId:'job', provider:'openai', model:'gpt-6-sol', operation:'essay-generation', startedAt:'2026-10-01T04:00:00Z', completedAt:'2026-10-01T04:00:10Z', status:'reported', responseId:'response', requestId:null, providerStatus:'completed', serviceTier:'default', tokens:{input:1000,cachedInput:200,cacheWrite:0,output:100,reasoningOutput:60}, rate:{version:'openai-standard-2026-10-01',source:'https://developers.openai.com/api/docs/pricing',checkedAt:'2026-10-01',unit:'USD per million tokens',context:'short',input:2,cachedInput:.2,cacheWrite:2.5,output:10}, estimatedUsd:.00264,reconciledUsd:null,failure:null, applicationStatus:'cancelled',applicationTitle:'Software Engineering Internship'};
const report={records:[record,{...record,id:'failed',responseId:null,status:'failed',operation:'matching',applicationId:null,applicationTitle:null,applicationStatus:null,backgroundJobId:'matching:job',providerStatus:null,tokens:{input:null,cachedInput:null,cacheWrite:null,output:null,reasoningOutput:null},rate:null,estimatedUsd:null,failure:'provider_error'}],measuredCalls:1,unknownCalls:1,estimatedUsd:.00264,incompleteCostCalls:1,reconciledUsd:null,projectedReservations:[{applicationId:'app',runId:'saved-run',kind:'draft',projectedUsd:.2}]};
async function main() {
await mkdir(".data", { recursive: true });
const browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined});
try {
 const page=await browser.newPage();
 await page.route('**/api/usage', route=>route.fulfill({json:report}));
 for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const) {
  await page.setViewportSize({width,height}); await page.goto(`${process.env.TEST_USAGE_URL || 'http://localhost:3000'}/usage`);
  await page.getByRole('heading',{name:'Model calls'}).waitFor();
  assert(await page.getByText('cancelled',{exact:true}).isVisible());
  assert(await page.getByText('Failed / unmeasured',{exact:true}).isVisible());
  assert(await page.getByText('Projected scheduling reservations',{exact:true}).isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page must not overflow viewport');
  await page.screenshot({path:`.data/usage-${name}.png`,fullPage:true});
  console.log(`PASS ${name}: usage, unknown cost, cancelled work, reservations and bounded overflow`);
 }
 await page.route('**/api/usage',route=>route.fulfill({json:{...report,records:[],measuredCalls:0,unknownCalls:0,estimatedUsd:0,incompleteCostCalls:0,projectedReservations:[]}}));
 await page.getByRole('button',{name:'Refresh usage'}).click();
 await page.getByRole('heading',{name:'No model usage recorded yet'}).waitFor();
 await page.route('**/api/usage',route=>route.fulfill({status:503,json:{error:'Usage could not be loaded. Try again.'}}));
 await page.getByRole('button',{name:'Refresh usage'}).click();
 await page.getByRole('alert').waitFor();
 console.log('PASS empty records and recoverable error states');
} finally {await browser.close();}

}
main().catch(error => { console.error(error); process.exit(1); });
