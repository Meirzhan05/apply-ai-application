import {describe,it,expect} from 'vitest';
import {graduationSeasonOption} from '@/lib/education-options';
const options=['Winter 2027','Spring 2027','Fall 2027'];
describe('confirmed graduation date options',()=>{
 it('maps an expected May graduation to the unique offered Spring option',()=>expect(graduationSeasonOption('May 2027 (expected)',options)).toBe('Spring 2027'));
 it('supports explicitly supplied seasons',()=>expect(graduationSeasonOption('Spring 2027 (expected)',options)).toBe('Spring 2027'));
 it.each(['2027','Expected 2027','December 2027','May 2026','June 2027','Unknown'])('leaves %s unresolved rather than inventing a season or selecting a different year',value=>expect(graduationSeasonOption(value,options)).toBeUndefined());
 it('refuses duplicate matching options',()=>expect(graduationSeasonOption('May 2027',[...options,'Spring 2027'])).toBeUndefined());
});
