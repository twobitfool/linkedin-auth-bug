// Load environment variables from .env file
import dotenv from 'dotenv'
dotenv.config()

import { randomBytes } from 'crypto'
import fetch from 'node-fetch'


const { LINKEDIN_API_KEY, LINKEDIN_API_SECRET, ROOT_URL, VERBOSE_LOGGING } = process.env

const REDIRECT_URL = `${ROOT_URL || 'http://localhost:3000'}/confirm-linkedin`


if (!LINKEDIN_API_KEY || !LINKEDIN_API_SECRET) {
  console.error('Missing LinkedIn API credentials!')
  console.error('Please set the LINKEDIN_API_KEY and LINKEDIN_API_SECRET environment variables.')
  process.exit(1)
}


export function generateAuthUrl ({scopes}) {
  const authToken = randomBytes(16).toString('base64url')

  const authUrl = [
    `https://www.linkedin.com/oauth/v2/authorization`,
    `?response_type=code`,
    `&client_id=${LINKEDIN_API_KEY}`,
    `&redirect_uri=${REDIRECT_URL}`,
    `&scope=${encodeURIComponent(scopes.join(' '))}`,
    `&state=${authToken}`,
  ].join('')

  return authUrl
}


// Use the `code` to get an `accessToken` and `refreshToken`
export async function finalizeAuth ( { code } ) {
  const acct = {}

  await _fetchAccessToken(acct, code)
  acct.authorizedAt = new Date()

  return acct
}


export async function getLinkedinProfile (acct) {
  const data = await _getLinkedinProfile(acct)
  const {id, name} = data
  acct.externalId = id
  acct.name = name || '(No Name)'
  return data
}


export async function getLinkedinOrgs (acct) {
  const results = await _getLinkedinOrgs(acct)
  return results
}


//==============================================================================


async function _fetchAccessToken(acct, code) {
  if (!LINKEDIN_API_KEY || !LINKEDIN_API_SECRET) {
    throw Error(`Can't fetch an access token from LinkedIn without LINKEDIN_API_KEY and LINKEDIN_API_SECRET`)
  }

  const params = {
    client_id:     LINKEDIN_API_KEY,
    client_secret: LINKEDIN_API_SECRET,
    redirect_uri:  REDIRECT_URL,
  }

  // An auth code is used to fetch the accessToken the first time
  if (code) {
    params.grant_type = 'authorization_code'
    params.code       = code
  } else { // We can also get a fresh access token by using the refreshToken
    if (!acct.refreshToken) throw Error (`Can't refresh an access token with a refresh token`)

    const expired = acct.refreshTokenExpiresAt && acct.refreshTokenExpiresAt < Date.now()
    if (expired) throw Error(`Can't refresh an access token with an expired refresh token`)

    params.grant_type    = 'refresh_token'
    params.refresh_token = acct.refreshToken
  }

  const url = `https://www.linkedin.com/oauth/v2/accessToken?` + new URLSearchParams(params).toString()
  const now = Date.now()
  const res = await fetch(url, { method: 'POST' })

  if (!res.ok) {
    let errorMessage = ''
    try {
      const errorData = await res.json()
      errorMessage = errorData.error_description || errorData.error || 'Unknown Error'
    } catch (err) {
      console.log(`Couldn't parse the response`)
    }
    errorMessage = errorMessage || await res.text() || 'Unknown Error'
    throw Error(`Error fetching LinkedIn access_token - ${errorMessage}`)
  }

  const payload = await res.json()
  if (!payload.access_token) {
    throw Error(`LinkedIn response is missing the access_token - ${await res.text()}`)
  }

  acct.accessToken  = payload.access_token
  acct.refreshToken = payload.refresh_token
  acct.scopes       = payload.scope

  acct.accessTokenExpiresAt  = new Date(now + (payload.expires_in               * 1000))
  acct.refreshTokenExpiresAt = new Date(now + (payload.refresh_token_expires_in * 1000))
}


// This function requires the LinkedIn scope: r_basicprofile
async function _getLinkedinProfile (acct) {
  const profile = await apiRequest( acct, `https://api.linkedin.com/rest/me` )

  const { id, localizedFirstName, localizedLastName } = profile
  const name = [ localizedFirstName, localizedLastName ].filter(s => s).join(" ")

  return {id, name}
}


// This function requires the LinkedIn scope: r_organization_admin
async function _getLinkedinOrgs (acct) {

  const orgList = await apiRequest(acct,
    `https://api.linkedin.com/rest/organizationAcls`,
    { params: { q: `roleAssignee`, fields: [`organization`, `role`] } }
  )

  return orgList
}



async function apiRequest(acct, url, { params={}, method='GET', body, headers={} }={}) {
  let queryString = new URLSearchParams(params).toString()

  queryString = queryString.replace(/%2C/g, ',') // LinkedIn doesn't like encoded commas
  if (queryString) url += `?${queryString}`

  // Let the calling code override/inject header values
  headers = { ..._apiRequestHeaders(acct), ...headers }

  const request = {method, headers}
  const isJSON = headers['Content-Type'] === 'application/json'

  if (body) request.body = isJSON ? JSON.stringify(body) : body

  const response = await fetch(url, request)

  let data = null;
  try {
    data = await response.text()
  } catch (err) {
    console.log(`WARNING: Couldn't get text from LinkedIn API response to ${url}`)
  }

  if (VERBOSE_LOGGING) {
    console.log('\n-------------------------------------------------------------')
    console.log(`📞 LinkedIn API Request with ${acct.token} at ${new Date().toISOString()}`)
    console.log('METHOD:   ', method)
    console.log('URL:      ', url)
    console.log('VERSION:  ', acct.version)
    console.log('SCOPES:   ', JSON.stringify(acct.scopes))
    console.log('STATUS:   ', response.status)
    console.log('HEADERS:  ', JSON.stringify(headers))
    let curlCommand = [`curl --location '${url}'`]
    for (const key in headers) {
      curlCommand.push(`--header '${key}: ${headers[key]}'`)
    }
    console.log('CURL:     ', curlCommand.join(` `))
    console.log('RESPONSE: ', JSON.stringify(data))
    console.log('-------------------------------------------------------------\n\n')
  }

  if (!response.ok) {
    console.log('X-LI-UUID Response Header:', response.headers.get('X-LI-UUID'))
    const error = new Error(`LinkedIn request failed ${method} ${url} - ${response.status} ${response.statusText} - ${data}`)
    error.status = response.status
    error.data = data
    throw error
  }

  if (isJSON) {
    try {
      data = JSON.parse(data)
    } catch (err) {
      console.log('~~~~~~~~~~~~~ Error parsing LinkedIn API JSON ~~~~~~~~~~~~~')
      console.log(data)
      console.log(err)
      console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~')
      throw Error(`Couldn't parse LinkedIn API response`)
    }
  }

  return data
}


// Version header docs are at: https://bit.ly/3H6WJuq and https://bit.ly/3H52okU
function _apiRequestHeaders (acct) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${acct.accessToken}`,
    "LinkedIn-Version": acct.version,
    "X-Restli-Protocol-Version": "2.0.0",
  }
}
