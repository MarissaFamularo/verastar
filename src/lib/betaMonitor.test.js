import { describe, it, expect, vi } from 'vitest'
import { incidentEmail, runMonitor, monitorAuthorized, runDeliveryTest } from '../../supabase/functions/beta-monitor/handler.js'
import { observeSignup, observeDigest } from '../../supabase/functions/_shared/observeSignup.js'
describe('deterministic beta monitoring', () => {
  it('redacts arbitrary payloads from all email fields', () => {
    const mail = incidentEmail({ check:'signup',kind:'incident',observed_at:'2026-10-15T22:30:00Z',email:'private@example.test',npi:'1234567893',error:'secret',payload:{paper:'sensitive'} })
    expect(JSON.stringify(mail)).not.toMatch(/private|1234567893|secret|sensitive/)
    expect(() => incidentEmail({check:'private@example.test',kind:'incident',observed_at:'2026-10-15T22:30:00Z'})).toThrow()
  })
  it('disabled delivery never claims or sends', async () => {
    const rpc=vi.fn(async()=>({})),sendMail=vi.fn()
    expect(await runMonitor({rpc,sendMail})).toEqual({ok:true,delivery:'disabled'})
    expect(rpc).toHaveBeenCalledTimes(1); expect(sendMail).not.toHaveBeenCalled()
  })
  it('failed heartbeat cannot dispatch', async () => {
    const rpc=vi.fn(async()=>({error:'down'})),sendMail=vi.fn()
    expect((await runMonitor({rpc,sendMail,enabled:true})).ok).toBe(false)
    expect(sendMail).not.toHaveBeenCalled()
  })
  it('records failed mail without exposing the provider error', async () => {
    const rpc=vi.fn(async name=>name==='beta_alert_claim'?{data:{id:'id',check:'digest',kind:'incident',observed_at:'2026-10-15T22:30:00Z'}}:{})
    const result=await runMonitor({rpc,enabled:true,sendMail:async()=>{throw new Error('token secret email')}})
    expect(result).toEqual({ok:false,delivery:'failed'})
    expect(rpc).toHaveBeenLastCalledWith('beta_alert_finish',{p_id:'id',p_sent:false})
  })
  it('distinguishes sent from uncertain persistence', async () => {
    const rpc=vi.fn(async name=>name==='beta_alert_claim'?{data:{id:'id',check:'digest',kind:'recovery',observed_at:'2026-10-15T23:00:00Z'}}:name==='beta_alert_finish'?{error:'down'}:{})
    expect((await runMonitor({rpc,enabled:true,sendMail:async()=>{}})).delivery).toBe('uncertain')
  })
  it('observes only terminal digest evidence and tolerates unavailable instrumentation', async () => {
    const rpc=vi.fn().mockRejectedValue(new Error('down'))
    await observeDigest({rpc},{finished:false,failed:false}); expect(rpc).not.toHaveBeenCalled()
    await observeDigest({rpc},{finished:true,failed:false}); expect(rpc).toHaveBeenCalledWith('beta_monitor_record',{p_check:'digest',p_ok:true,p_code:'ok'})
    await expect(observeSignup({rpc},503)).resolves.toBeUndefined()
  })
})

it('formats overdue schedule alerts without participant data', () => {
 expect(incidentEmail({check:'schedule',kind:'incident',observed_at:'2026-10-15T22:30:00Z',user_id:'private',error:'secret'})).toEqual({subject:'Verastar: schedule — Needs attention',text:'Status: schedule — Needs attention\nTime: 2026-10-15T22:30:00.000Z\nDashboard: https://verastar.papertrellis.com/'})
})

it('uses recovery observation time and a fixed dashboard URL only', () => {
 const mail=incidentEmail({check:'digest',kind:'recovery',incident_at:'2020-01-01T00:00Z',observed_at:'2026-10-15T23:00:00Z',url:'https://evil.invalid',logs:'secret'})
 expect(mail).toEqual({subject:'Verastar: digest — Recovered',text:'Status: digest — Recovered\nTime: 2026-10-15T23:00:00.000Z\nDashboard: https://verastar.papertrellis.com/'})
})
it('rejects missing or invalid observation timestamps instead of inventing time', () => {
 for(const observed_at of [undefined,null,'secret',123]) expect(()=>incidentEmail({check:'digest',kind:'incident',observed_at})).toThrow('Invalid observation time')
})

it('requires a configured matching scheduler secret or service bearer',()=>{
 for(const headers of [new Headers(),new Headers({'x-cron-secret':'wrong'}),new Headers({authorization:'Bearer user-token'})]) expect(monitorAuthorized(headers,'service','cron')).toBe(false)
 expect(monitorAuthorized(new Headers({'x-cron-secret':'cron'}),'service','cron')).toBe(true)
 expect(monitorAuthorized(new Headers({authorization:'Bearer service'}),'service','cron')).toBe(true)
 expect(monitorAuthorized(new Headers(),undefined,undefined)).toBe(false)
})
it('test claims once and contains only fixed status time and link',async()=>{
 const sendMail=vi.fn(),rpc=vi.fn(async name=>name==='beta_alert_test_claim'?{data:'2026-10-15T22:00:00Z'}:{})
 expect((await runDeliveryTest({rpc,sendMail})).delivery).toBe('sent')
 expect(sendMail.mock.calls[0][0].text).toBe('Status: Alert delivery test\nTime: 2026-10-15T22:00:00.000Z\nDashboard: https://verastar.papertrellis.com/')
 await runDeliveryTest({rpc:async()=>({data:null}),sendMail})
 expect(sendMail).toHaveBeenCalledTimes(1)
})
it('test never leaks provider errors or retries uncertain sends',async()=>{
 const rpc=vi.fn(async name=>name==='beta_alert_test_claim'?{data:'2026-10-15T22:00:00Z'}:{error:'down'})
 const result=await runDeliveryTest({rpc,sendMail:async()=>{throw new Error('secret')}})
 expect(result.delivery).toBe('uncertain');expect(JSON.stringify(result)).not.toContain('secret')
})
