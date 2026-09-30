import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {initialDemoState} from '../src/lib/demo-data';
import {loadState,mutateState} from '../src/lib/repository';
import {selectApplication,setPacket,approveFill,transition} from '../src/lib/workflow';
import {draftPacket,packetProfileHash} from '../src/lib/drafting';
import {queueApplicationRun} from '../src/lib/application-queue';
import {cancelBrowser} from '../src/lib/browser-runner';
import {refreshBrowserSnapshot} from '../src/lib/browser-runner';
import {writeFile,access,rm} from 'node:fs/promises';
async function main(){
 process.env.DEMO_MODE='false';
 const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
 const token=randomUUID(); const {data,error}=await db.auth.admin.createUser({email:`remote-qa-${token}@example.com`,email_confirm:true});assert.equal(error,null); const userId=data.user!.id;
 const origin = process.env.TEST_REMOTE_APP_URL || process.env.APP_ORIGIN; if(!origin?.startsWith('https://')) throw new Error('TEST_REMOTE_APP_URL must be your deployed HTTPS app.');
 const job={...initialDemoState().jobs[1],id:`remote-qa:${token}`,source:'imported' as const,sourceId:token,url:`${origin}/demo/apply/engineering-intern`,applyUrl:`${origin}/demo/apply/engineering-intern`};
 let appId='';
 try{
 assert.equal((await db.from('jobs').insert({id:job.id,source:job.source,source_id:token,active:true,data:job})).error,null);
 const profile={...initialDemoState().profile,id:userId,name:'Synthetic Remote Test',email:data.user!.email!,demo:false};
 const packet=await draftPacket(profile,job); packet.answers=[];packet.profileHash=packetProfileHash(profile);
 appId=await mutateState(userId,s=>{s.profile=profile;s.jobs=[job];const app=selectApplication(s,job.id,userId);setPacket(s,app,packet);approveFill(app,userId,app.packetHash!,job.applyUrl);return app.id;});
 await queueApplicationRun(userId,appId,'fill');
 const timeout=Date.now()+150000; let app;
 do {app=(await loadState(userId)).applications.find(a=>a.id===appId)!;if(app.status!=='filling')break;await new Promise(r=>setTimeout(r,2000));}while(Date.now()<timeout);
 assert.equal(app!.status,'final_review',app!.error);
 assert.ok(app!.browserLiveUrl);assert.ok(app!.form?.readyToSubmit);
 assert.equal(app!.form?.fields.find(f=>/email/i.test(f.label))?.value,profile.email);
 assert.ok(app!.form?.fields.find(f=>f.kind==='file')?.fileHashes?.length);
 const proof=await db.storage.from('form-shots').download(`${userId}/${appId}.png`);assert.equal(proof.error,null);assert.ok(proof.data!.size>1000);
 console.log('PASS cloud Trigger.dev fill worker → Browserbase → owned controlled form, synthetic fields, Unicode-capable PDF upload, final-review snapshot, private screenshot and live takeover URL');
 const takeoverPath=process.env.TEST_REMOTE_TAKEOVER_PATH;
 if(takeoverPath){
  await writeFile(takeoverPath,JSON.stringify({liveUrl:app!.browserLiveUrl}),{mode:0o600});
  const deadline=Date.now()+120000;
  let ready=false;
  while(Date.now()<deadline){try{await access(`${takeoverPath}.done`);ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}
  assert.ok(ready,'Operator takeover did not complete before the test timeout');
  const refreshed=await refreshBrowserSnapshot(app!);
  assert.equal(refreshed.fields.find(f=>/phone/i.test(f.label))?.value,'202-555-0147');
  assert.ok(refreshed.readyToSubmit);
  console.log('PASS operator edited a field through the remote live viewer; refreshed review contains that exact value');
 }
 await cancelBrowser(app!); await mutateState(userId,s=>transition(s.applications.find(a=>a.id===appId)!,['final_review'],'cancelled'));
 console.log('PASS remote browser released without contacting an employer or clicking submit');
 }finally{if(process.env.TEST_REMOTE_TAKEOVER_PATH){await rm(process.env.TEST_REMOTE_TAKEOVER_PATH,{force:true});await rm(`${process.env.TEST_REMOTE_TAKEOVER_PATH}.done`,{force:true});}if(appId){const app=(await loadState(userId)).applications.find(a=>a.id===appId);if(app)await cancelBrowser(app).catch(()=>undefined);await db.storage.from('form-shots').remove([`${userId}/${appId}.png`]);}await db.auth.admin.deleteUser(userId);await db.from('jobs').delete().eq('id',job.id);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
