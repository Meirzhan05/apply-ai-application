import {describe, expect, it} from 'vitest';
import {employerSubmissionBlock, canReopenManualAttempt} from '@/lib/form-review';
import type {Application} from '@/lib/types';
function fixture():Application {
 return {id:'application',userId:'owner',jobId:'job',status:'uncertain',createdAt:'2026-09-30T23:09:00Z',updatedAt:'2026-09-30T23:10:00Z',approvals:[],submissionAttemptedAt:'2026-09-30T23:09:21Z',submissionReceipt:{version:1,url:'https://employer.example/application',capturedAt:'2026-09-30T23:09:43Z',text:"We couldn't submit your application\n\nYour application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again."}};
}
describe('recorded employer block notice',()=>{
 it('shows the known block without changing state or enabling another attempt',()=>{const app=fixture();const before=structuredClone(app);expect(employerSubmissionBlock(app)).toMatch(/flagged as possible spam/);expect(app).toEqual(before);expect(canReopenManualAttempt(app)).toBe(false);});
 it('accepts a typographic apostrophe in the employer heading',()=>{const app=fixture();app.submissionReceipt!.text=app.submissionReceipt!.text.replace("couldn't",'couldn’t');expect(employerSubmissionBlock(app)).toBeTruthy();});
 it('leaves conflicting confirmation and rejection evidence uncertain',()=>{const app=fixture();app.submissionReceipt!.text+='\nApplication received';expect(employerSubmissionBlock(app)).toBeUndefined();});
 it.each(['old-receipt','no-attempt','invalid-date','submitted','unrelated-question','unknown-error'])('preserves uncertainty for %s',mode=>{const app=fixture();if(mode==='old-receipt')app.submissionReceipt!.capturedAt='2026-09-30T22:00:00Z';if(mode==='no-attempt')app.submissionAttemptedAt=undefined;if(mode==='invalid-date')app.submissionReceipt!.capturedAt='bad';if(mode==='submitted')app.status='submitted';if(mode==='unrelated-question')app.submissionReceipt!.text='How would you respond if your application submission was flagged as possible spam?';if(mode==='unknown-error')app.submissionReceipt!.text='Processing your application';expect(employerSubmissionBlock(app)).toBeUndefined();});
});
