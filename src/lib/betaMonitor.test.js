import { describe, it, expect, vi } from 'vitest'
import { incidentEmail, runMonitor } from '../../supabase/functions/beta-monitor/handler.js'
import { observeSignup, observeDigest } from '../../supabase/functions/_shared/observeSignup.js'
describe('deterministic beta monitoring', () => {
  it('redacts arbitrary payloads from all email fields', () => {
    const mail = incidentEmail({ check:'signup',kind:'incident',email:'private@example.test',npi:'1234567893',error:'secret',payload:{paper:'sensitive'} })
    expect(JSON.stringify(mail)).not.toMatch(/private|1234567893|secret|sensitive/)
    expect(() => incidentEmail({check:'private@example.test',kind:'incident'})).toThrow()
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
    const rpc=vi.fn(async name=>name==='beta_alert_claim'?{data:{id:'id',check:'digest',kind:'incident'}}:{})
    const result=await runMonitor({rpc,enabled:true,sendMail:async()=>{throw new Error('token secret email')}})
    expect(result).toEqual({ok:false,delivery:'failed'})
    expect(rpc).toHaveBeenLastCalledWith('beta_alert_finish',{p_id:'id',p_sent:false})
  })
  it('distinguishes sent from uncertain persistence', async () => {
    const rpc=vi.fn(async name=>name==='beta_alert_claim'?{data:{id:'id',check:'digest',kind:'recovery'}}:name==='beta_alert_finish'?{error:'down'}:{})
    expect((await runMonitor({rpc,enabled:true,sendMail:async()=>{}})).delivery).toBe('uncertain')
  })
  it('observes only terminal digest evidence and tolerates unavailable instrumentation', async () => {
    const rpc=vi.fn().mockRejectedValue(new Error('down'))
    await observeDigest({rpc},{finished:false,failed:false}); expect(rpc).not.toHaveBeenCalled()
    await observeDigest({rpc},{finished:true,failed:false}); expect(rpc).toHaveBeenCalledWith('beta_monitor_record',{p_check:'digest',p_ok:true,p_code:'ok'})
    await expect(observeSignup({rpc},503)).resolves.toBeUndefined()
  })
})
