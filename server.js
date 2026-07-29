'use strict';

/**
 * Custom CAP bootstrap.
 *
 * Two development conveniences live here: a cache policy for the static files
 * under `app/`, and a way out of a bad sign-in.
 *
 * The cache policy exists because the default is to let the browser keep these
 * files, which during development means a fix can be pulled, deployed and
 * served while the browser still shows the old page - and UI5 is worse than
 * most, because it caches `manifest.json` and the component modules
 * independently of the HTML. Debugging a stale asset looks exactly like
 * debugging a broken one, so in development nothing here is cached. Production
 * keeps normal caching, where the assets are versioned by the deployment.
 */

const cds = require('@sap/cds');

const NO_CACHE_TYPES = /\.(html|json|js|properties|css|xml)$/i;

/** The mock users, for the sign-in page. Never rendered outside development. */
const MOCK_USERS = [
  ['manager', 'Everything: read, work the queues, re-run the engines'],
  ['analyst', 'Read, re-run the engines, replay and measure. Cannot work the queues.'],
  ['viewer', 'Read only'],
];

cds.on('bootstrap', (app) => {
  if (process.env.NODE_ENV === 'production') return;

  /**
   * Force the browser to ask for credentials again.
   *
   * CAP's mocked authentication accepts any user name with any password and
   * gives an unrecognised one no roles at all. So a single mistyped sign-in
   * leaves every screen returning 403 - and because browsers cache basic-auth
   * credentials per realm and only re-prompt on a 401, there is otherwise no
   * way back short of closing every window. Answering 401 here is what makes
   * the prompt reappear.
   */
  app.get('/signout', (request, response) => {
    // Only challenge once per visit. Without this the browser prompts, gets
    // another 401 for the same URL, and loops until the user gives up.
    if (!request.query.done) {
      response.set('WWW-Authenticate', 'Basic realm="Users"');
      response.status(401).send(
        '<meta http-equiv="refresh" content="0; url=/signout?done=1">Signing out...');
      return;
    }
    response.type('html').send(`<!doctype html>
      <meta charset="utf-8">
      <title>Sign in - S.Mart Retail AI</title>
      <link rel="stylesheet" href="/assets/theme.css">
      <main class="app-main" style="max-width:640px">
        <div class="page-head"><h1>Signed out</h1>
        <p>Development uses mocked authentication. Any name is accepted, but only
        these three carry roles - anything else is signed in with no permissions
        and every screen will report a missing role.</p></div>
        <div class="card"><table class="data"><thead><tr><th>User</th><th>Password</th>
        <th>What it can do</th></tr></thead><tbody>
        ${MOCK_USERS.map(([name, can]) =>
          `<tr><td class="strong">${name}</td><td>${name}</td><td>${can}</td></tr>`).join('')}
        </tbody></table></div>
        <p style="margin-top:18px"><a class="btn btn-primary" href="/index.html">Back to the launchpad</a></p>
      </main>`);
  });

  app.use((request, response, next) => {
    if (NO_CACHE_TYPES.test(request.path)) {
      // `no-store` is the one that matters: it forbids keeping a copy at all,
      // so the ETag express.static adds further down the chain never gets a
      // chance to trigger a revalidation against a stale entry.
      response.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      response.set('Pragma', 'no-cache');
      response.set('Expires', '0');
    }
    next();
  });
});

module.exports = cds.server;
