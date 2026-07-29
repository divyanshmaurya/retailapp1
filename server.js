'use strict';

/**
 * Custom CAP bootstrap.
 *
 * The only thing this adds is a cache policy for the static files under `app/`.
 * The default is to let the browser cache them, which during development means
 * a fix can be pulled, deployed and served and the browser still shows the old
 * page - and UI5 is worse than most, because it caches `manifest.json` and the
 * component modules independently of the HTML. Debugging a stale asset looks
 * exactly like debugging a broken one, so in development nothing here is
 * cached. Production keeps normal caching, where the assets are versioned by
 * the deployment.
 */

const cds = require('@sap/cds');

const NO_CACHE_TYPES = /\.(html|json|js|properties|css|xml)$/i;

/**
 * The Application Router's own configuration, which lives in `app/` alongside
 * the pages it serves. In production the router refuses these itself; here CAP
 * serves `app/` statically and would hand them out, so they are refused to keep
 * both environments behaving the same way.
 */
const NOT_WEB_CONTENT = /^\/(xs-app\.json|package(-lock)?\.json)$/;

cds.on('bootstrap', (app) => {
  app.use((request, response, next) => {
    if (NOT_WEB_CONTENT.test(request.path)) return response.sendStatus(404);
    return next();
  });

  if (process.env.NODE_ENV === 'production') return;

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
