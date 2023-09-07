import crypto from 'crypto'
import ejs from 'ejs'
import fs from 'fs'
import Koa from 'koa'
import { finalizeAuth, generateAuthUrl, getLinkedinOrgs, getLinkedinProfile } from './linkedin.js'


const PORT = process.env.PORT || 3000
const app = new Koa()

app.use(async (ctx) => {

  if (ctx.path === '/') {
    const session = getSession(ctx)

    const data = {session}

    ctx.type = 'html'
    ctx.body = htmlFromFile('./public/index.html', data)
    return
  }


  if (ctx.path === '/auth/linkedin') {
    const session = getSession(ctx)

    let url = ''
    const {accounts} = session
    const firstAccount = accounts.length === 0

    if (firstAccount) {
      url = generateAuthUrl({ scopes: [
        'r_basicprofile',
      ] })
    } else if (accounts.length === 1) {
      url = generateAuthUrl({ scopes: [
        'r_organization_admin',
      ] })
    } else {
      url = '/'
    }

    ctx.redirect(url)
    return
  }


  if (ctx.path === '/confirm-linkedin') {
    const session = getSession(ctx)
    const firstAccount = session.accounts.length === 0

    const acct = await finalizeAuth({code: ctx.query.code})

    acct.version = '202308'
    acct.token = `Token #${session.accounts.length + 1}`
    session.accounts.push(acct)

    if (process.env.VERBOSE_LOGGING) {
      console.log('\n-------------------------------------------------------------')
      console.log(`🔑 Created NEW ACCESS TOKEN at ${new Date().toISOString()}`)
      console.log(JSON.stringify(acct, null, 2))
      console.log('-------------------------------------------------------------\n\n')
    }

    if (firstAccount) {
      try {
        await getLinkedinProfile(acct)
      } catch (err) {
        console.log('Error fetching profile for first account')
        console.error(err)
      }
    } else {
      session.tests = []
      session.status = 'running'
      keepUsingBothTokens()
    }

    ctx.redirect('/')
    return

    async function keepUsingBothTokens() {

      const accounts = session.accounts.slice(0, 2)

      for (let i=0; i<session.testCount; i++) {
        const loopStart = new Date()

        const result = {
          time: new Date().toLocaleString(),
          requests: [],
          status: 'pending',
        }

        for (const acct of accounts) {

          result.requests.push({
            acct: acct,
            url: '/me',
            apiResult: await callApi({ acct, method: getLinkedinProfile })
          })

          result.requests.push({
            acct: acct,
            url: '/organizationAcls',
            apiResult: await callApi({ acct, method: getLinkedinOrgs })
          })

        }
        session.tests.push(result)

        const loopEnd = new Date()
        const loopDuration = loopEnd - loopStart
        const delay = session.testDelay * 1000 - loopDuration

        if (i < session.testCount - 1) {
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }

      session.status = 'done'
    }
  }


  if (ctx.path === '/status') {
    const session = getSession(ctx)

    ctx.type = 'json'
    ctx.body = {
      tests: session.tests,
    }
    return
  }
})


app.listen(PORT)
console.log(`Server is running at http://localhost:${PORT}`)


//------------------------------------------------------------------------------


async function callApi({acct, method}) {

  const result = {}

  let requestFailed = false
  try {
    result.details = await method(acct)
    result.success = true
  } catch (err) {
    requestFailed = true
    try {
      result.details = JSON.parse(err.data)
    } catch (e) {
      // failed to parse json error -- no worries
      result.details = err.data
    }
    result.success = false
    console.error(err)
  }

  return result
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
      testCount: 10,
      testDelay: 60, // seconds between tests
      status: 'pending'
    }
    ctx.cookies.set(SESSION_COOKIE_NAME, sessionId, COOKIE_OPTIONS)
  }

  return SESSIONS[sessionId]
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
