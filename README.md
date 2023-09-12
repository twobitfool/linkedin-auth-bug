# LinkedIn API Auth Problem

After creating a new access token, the old token can still be used -- for up to
5 minutes (after the last call made with the old token).

You can run this app to demonstrate the problem, or you can just read the rest
of this README (to avoid all the setup required) 😜

![Visual of the scenario where the auth uses the old token](./public/ghost-token.png)

This makes development difficult. Any time we make a change to the permission
scopes, new tokens may still use the old permission (from a previous token) for
several minutes, making it seem like the change didn't make any difference.

This also creates a problem when migrating from LinkedIn-Version: 202305 to
version 202306. LinkedIn-Version 202306 changed the minimum permission required
for the `/rest/me` endpoint -- from `r_liteprofile` to `r_basicprofile`. When we
have the user reauthorize their LinkedIn account, to get a new access token
(with `r_basicprofile` scope), they could get permission errors from an old
token (with `r_liteprofile`) if it was used in the past 5 minutes.


## Sample Output

Notice how it takes about 5 minutes before the new token starts working...

![Screenshot of test results](./test-results.png)


## Running this Demo Locally

If don't already have one, you will need to [create an app](https://www.linkedin.com/developers/apps/new) in the LinkedIn developer portal, and then:
1. Go to the settings for your LinkedIn app
2. Tap on the **Auth** tab
3. Under **OAuth 2.0 settings**, edit the **Authorized redirect URLs for your app**
4. Add the following redirect URL: `http://localhost:3000/confirm-linkedin`
5. Under **Application credentials**, copy the **Client ID** and **Client Secret** values

On your local dev machine, create a `.env` file (in the root of this app) with the following info:

```bash
# .env
LINKEDIN_API_KEY=[Client ID goes here]
LINKEDIN_API_SECRET=[Client Secret goes here]
ROOT_URL=http://localhost:3000
VERBOSE_LOGGING=true
```

Start the server:

```bash
yarn install
yarn start   # or `yarn dev` (for local development with auto-reloading)

open http://localhost:3000
```
