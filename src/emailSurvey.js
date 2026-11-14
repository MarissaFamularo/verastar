import './digestStatus.css'
import './emailSurvey.css'
import { surveyParams, surveyBody, answersComplete, emailSurveyMessage, postSurvey, DAY30_QUESTIONS } from './lib/emailSurvey.js'

// The day-30 survey page linked from the digest email (lib/emailSurvey.js). Deliberately
// does not mount App or sign in: the signed link is the only credential.
const env = import.meta.env || {}
const functionsBase = env.VITE_SUPABASE_URL ? `${env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1` : ''

const $ = (id) => document.getElementById(id)
const title = $('survey-title')
const status = $('survey-status')
const form = $('survey-form')
const openLink = $('survey-open')

function show(result) {
  const m = emailSurveyMessage(result)
  title.textContent = m.title
  status.textContent = m.body
  form.hidden = !m.form
  openLink.hidden = !m.open && !!m.form
}

function buildForm() {
  form.replaceChildren()
  for (const q of DAY30_QUESTIONS) {
    const set = document.createElement('fieldset')
    const legend = document.createElement('legend')
    legend.textContent = q.prompt
    set.append(legend)
    if (q.scale) {
      const hint = document.createElement('p')
      hint.className = 'scale-hint'
      hint.textContent = `1 = ${q.scale.minLabel}, 5 = ${q.scale.maxLabel}`
      set.append(hint)
    }
    const row = document.createElement('div')
    row.className = q.scale ? 'options scale' : 'options'
    for (const [code, label] of q.options) {
      const lab = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = q.key
      input.value = code
      lab.append(input, document.createTextNode(` ${label}`))
      row.append(lab)
    }
    set.append(row)
    form.append(set)
  }
  const send = document.createElement('button')
  send.type = 'submit'
  send.className = 'button'
  send.textContent = 'Send'
  form.append(send)
}

const params = surveyParams(window.location.search)
if (!params) show('invalid')
else if (!functionsBase) show('unconfigured')
else {
  buildForm()
  postSurvey(functionsBase, surveyBody(params, { check: true })).then(({ result }) => show(result === 'retry' ? 'open' : result))
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const answers = Object.fromEntries(new FormData(form).entries())
    if (!answersComplete(answers)) return show('incomplete')
    const send = form.querySelector('button[type="submit"]')
    send.disabled = true
    const { result } = await postSurvey(functionsBase, surveyBody(params, { answers }))
    send.disabled = false
    show(result)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
}
