import crypto from 'crypto'
import ejs from 'ejs'
import fs from 'fs'
import Koa from 'koa'
import { finalizeAuth, generateAuthUrl, getLinkedinProfile } from './linkedin.js'


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
      url = generateAuthUrl({ scopes: ['r_liteprofile'] })
    } else if (accounts.length === 1) {
      url = generateAuthUrl({ scopes: ['r_basicprofile'] })
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

    acct.version = firstAccount ? '202305' : '202306'
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
    }

    ctx.redirect('/')
    return
  }


  if (ctx.path === '/begin-tests') {
    const session = getSession(ctx)

    session.tests = []

    fetchProfileRepeatedly(session.accounts[1])

    ctx.redirect('/')
    return

    async function fetchProfileRepeatedly(acct) {

      for (let i=0; i<100; i++) {
        const result = {
          name: acct.name,
          token: acct.token,
          time: new Date().toLocaleString(),
          status: 'pending',
        }

        session.tests.push(result)

        try {
          await getLinkedinProfile(acct)
          result.status = 'success'
          break
        } catch (err) {
          // This will happen for about 5 minutes after the old token was created
          console.log('Error fetching profile for second account')
          console.error(err)

          result.status = 'failed'
          result.details = err.data
        }

        await new Promise(resolve => setTimeout(resolve, 5000))
      }
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
