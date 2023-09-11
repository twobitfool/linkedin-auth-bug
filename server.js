import crypto from 'crypto'
import ejs from 'ejs'
import fs from 'fs'
import serve from 'koa-static'
import Koa from 'koa'
import { finalizeAuth, generateAuthUrl, apiFetch } from './linkedin.js'


const PORT = process.env.PORT || 3000
const app = new Koa()

let steps = [
  {
    manual: true,
    method:  'note',
    title:   'Begin Test',
    text:    'We are going to create two access tokens, each with a single permission. Token #1 will only have access to /rest/me, and Token #2 will only have access to /rest/organizationAcls.',
  },
  {
    method: 'authorize',
    params: { token: 'Token #1', version: '202308', scopes: ['r_basicprofile' ] }
  },
  {
    method: 'apiFetch',
    params: { token: 'Token #1', url: ['/rest/me', '/rest/organizationAcls'] }
  },
  {
    method:  'authorize',
    params: { token: 'Token #2', version: '202308', scopes: ['r_organization_admin' ] }
  },
  {
    method:  'apiFetch',
    params: { token: '*', url: ['/rest/me', '/rest/organizationAcls'], repeat: 7, delay: 60 }
  },
  {
    method:  'note',
    title:   'Notice how Token #2 acted like Token #1 (for the first 5 minutes)',
    text:    '😳',
  },
  {
    method:  'wait',
    title:   'Wait 5 minutes',
    text:    'to let the API access token caching expire',
    delay:   60 * 5,
  },
  {
    manual: true,
    method: 'reset',
    text:   'if you want to run the demo again',
  },
]

app.use(serve('./public'));

app.use(async (ctx) => {

  if (ctx.path === '/') {
    const session = getSession(ctx)

    const data = {session}

    ctx.type = 'html'
    ctx.body = htmlFromFile('./erb/index.html', data)
    return
  }


  if (ctx.path === '/start-over') {
    const session = getSession(ctx)
    clearSession(session)

    ctx.redirect('/')
    return
  }


  if (ctx.path === '/next-step') {
    const session = getSession(ctx)

    // console.log(`\n\n🔥 Starting next step`)
    await processsCurrentStep(session)

    ctx.redirect('/')
    return
  }


  if (ctx.path === '/confirm-linkedin') {
    const session = getSession(ctx)

    const {steps} = session
    const currentStep = steps.find(step => !step.completedAt)

    if (!currentStep || currentStep.method !== 'authorize') {
      ctx.redirect('/')
      return
    }

    let acct = null
    try {
      acct = await finalizeAuth({code: ctx.query.code})
    } catch {
      clearSession(session)
      ctx.redirect('/auth-error.html')
      return
    }

    acct.version = currentStep.params.version
    acct.token = currentStep.params.token

    session.accounts.push(acct)

    if (process.env.VERBOSE_LOGGING) {
      console.log('\n-------------------------------------------------------------')
      console.log(`🔑 Created NEW ACCESS TOKEN at ${new Date().toISOString()}`)
      console.log(JSON.stringify(acct, null, 2))
      console.log('-------------------------------------------------------------\n\n')
    }

    currentStep.done = true
    await processsCurrentStep(session)

    ctx.redirect('/')
    return
  }

})


app.listen(PORT)
console.log(`Server is running at http://localhost:${PORT}`)


//------------------------------------------------------------------------------


async function callApi({acct, url}) {

  const result = {}
  let params = {}

  // Limit the number of fields coming back form the API

  if (url.startsWith('/rest/organizationAcls')) {
    params = { q: `roleAssignee`, fields: [`organization`, `role`] }
  }

  if (url.startsWith('/rest/me')) {
    params = { fields: [`id`, `localizedFirstName`, `localizedLastName`] }
  }

  try {
    result.details = await apiFetch({acct, url, params})
    result.success = true
  } catch (err) {
    result.success = false
    // Try to parse the error response
    try {
      result.details = JSON.parse(err.data)
    } catch (e) {
      // failed to parse json error -- just use the raw data
      result.details = err.data
    }
    console.error(err)
  }

  return result
}


//------------------------------------------------------------------------------


async function processsCurrentStep(session) {
  const {steps} = session

  const currentStep = steps.find(step => !step.completedAt)
  if (!currentStep) return

  const {method, params} = currentStep

  // console.log(`\n\n🚀 Starting step: ${method} ${params ? JSON.stringify(params, null, 2) : ''}`)

  currentStep.startedAt = new Date()


  // This is a special case, because we need to redirect to LinkedIn
  if (method === 'authorize') {
    const {scopes} = currentStep.params
    currentStep.redirect = generateAuthUrl({ scopes })
    if (!currentStep.done) {
      return // can't mark this step as done until the after the user authorizes
    }
  }

  else if (method === 'wait') {
    await new Promise(resolve => setTimeout(resolve, currentStep.delay * 1000))
  }

  else if (method === 'reset') {
    clearSession(session)
  }

  else if (method === 'note') {
    // Nothing to do here
  }

  else if (method === 'apiFetch') {
    const {token, url, repeat=1, delay=1000} = params
    const urls = Array.isArray(url) ? url : [url]

    let accounts = session.accounts
    if (token !== '*') {
      accounts = accounts.filter(acct => acct.token === token)
    }

    // console.log(` 📝 Accounts: ${accounts.map(acct => acct.token).join(', ')}`)
    currentStep.results = []

    for (let i=0; i<repeat; i++) {
      const result = {
        time: new Date().toLocaleString(),
        requests: [],
      }
      const asyncRequests = []

      for (const acct of accounts) {
        for (const url of urls) {

          // console.log(`📞 Calling ${url} ${repeat} times with ${delay} second delay`)

          asyncRequests.push(new Promise(async (resolve, reject) => {
            // console.log(`📞 Calling ${url} with ${acct.token}`)

            const request = { url, apiResult: {}, token: acct.token }
            result.requests.push(request)
            request.apiResult = await callApi({ acct, url })
            resolve()
          }))
        }
      }

      // console.log(`📞 Waiting for ${asyncRequests.length} requests to finish...`)
      await Promise.all(asyncRequests)

      // console.log(`📝 Results: ${JSON.stringify(result, null, 2)}`)
      currentStep.results.push(result)

      if (i < repeat - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * 1000))
      }
    }
  }

  else {
    throw Error(`Unknown step method: ${method}`)
  }

  currentStep.completedAt = new Date()

  const nextStep = steps.find(step => !step.completedAt)
  if (nextStep && !nextStep.manual) {
    processsCurrentStep(session)
  }
}


//------------------------------------------------------------------------------


const SESSIONS = {}

const SESSION_COOKIE_NAME = 'linkedin_demo_session'

const COOKIE_OPTIONS = {
  httpOnly: true,
  expires:  new Date(9999, 0, 1),
}


function getSession(ctx) {
  let sessionId = ctx.cookies.get(SESSION_COOKIE_NAME)

  if (!sessionId || !SESSIONS[sessionId]) {
    sessionId = crypto.randomBytes(16).toString('hex')
    SESSIONS[sessionId] = {
      id: sessionId,
      accounts: [],
      tests: [],
      steps: JSON.parse(JSON.stringify(steps)),
    }
    ctx.cookies.set(SESSION_COOKIE_NAME, sessionId, COOKIE_OPTIONS)
  }

  return SESSIONS[sessionId]
}


function clearSession(session) {
  delete SESSIONS[session.id]
}


//------------------------------------------------------------------------------


const HTML_TEMPLATE = {}

function htmlFromFile(path, data={}) {
  // Cache the HTML file contents in memory (in production)
  if (!HTML_TEMPLATE[path] || process.env.NODE_ENV === 'development') {
    HTML_TEMPLATE[path] = ejs.compile( fs.readFileSync(path, 'utf8') )
  }

  let template = HTML_TEMPLATE[path]
  let html = template(data)

  return html
}
