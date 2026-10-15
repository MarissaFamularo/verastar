import { createClient } from '@supabase/supabase-js'
import { runMonitor, monitorAuthorized, runDeliveryTest } from './handler.js'
// Reuse the project's existing SMTP service after its settings and recipient are verified.
// SMTP is reached only for enabled incident delivery or the single approved setup test.
Deno.serve(async (req) => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!key || !monitorAuthorized(req.headers, key, Deno.env.get('DIGEST_CRON_SECRET'))) return new Response('Forbidden', { status: 403 })
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false } })
  const enabled = Deno.env.get('BETA_ALERTS_ENABLED') === 'true'
  const sendMail = async ({ subject, text, id }: { subject: string, text: string, id: string }) => {
    const env = Object.fromEntries(['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM','BETA_ALERT_RECIPIENT'].map(k => [k,Deno.env.get(k)]))
    env.SMTP_PASSWORD ||= Deno.env.get('SMTP_Password')
    if (Object.values(env).some(v => !v) || !['465','587'].includes(env.SMTP_PORT!)) throw new Error('Mail not configured')
    const { default: nodemailer } = await import('npm:nodemailer@7.0.11')
    const transport = nodemailer.createTransport({ host:env.SMTP_HOST,port:Number(env.SMTP_PORT),secure:env.SMTP_PORT==='465',requireTLS:true,
      auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD},connectionTimeout:10000,socketTimeout:15000 })
    try {
      const result = await transport.sendMail({from:env.SMTP_FROM,to:env.BETA_ALERT_RECIPIENT,subject,text,messageId:`<${id}@verastar.papertrellis.com>`})
      if (!result.accepted?.length || result.rejected?.length) throw new Error('Mail not accepted')
    } finally { transport.close() }
  }
  const rpc = (name: string,args?: object)=>admin.rpc(name,args)
  const action = new URL(req.url).searchParams.get('action')
  if (action === 'test') {
    const test = await runDeliveryTest({rpc,sendMail})
    return Response.json(test,{status:test.ok?200:503})
  }
  const result = await runMonitor({ rpc:(name: string,args?: object)=>admin.rpc(name,args),sendMail,enabled })
  return Response.json(result, {status:result.ok?200:503})
})
