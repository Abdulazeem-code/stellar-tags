'use strict';

/**
 * #685 — Development playground.
 *
 * A self-contained GraphiQL page served from `GET /graphql` when the playground
 * is enabled. It is off unless the environment opts in (and always off in
 * production), because it is an interactive console against live data.
 *
 * The UI is loaded from a CDN, which the global CSP in `src/middleware/security`
 * blocks by default. Rather than weaken CSP globally, `playgroundPolicy()`
 * replaces the header for this one response with a policy that permits only the
 * CDN origins the page actually uses.
 */

const PLAYGROUND_CDN_SOURCES = [
  'https://unpkg.com',
  'https://esm.sh',
  'https://cdn.jsdelivr.net',
];

/**
 * CSP for the playground document. Tighter than it looks: `connect-src` is
 * same-origin only, so the page can still not exfiltrate a query anywhere.
 */
const playgroundPolicy = () => [
  "default-src 'none'",
  `script-src 'self' ${PLAYGROUND_CDN_SOURCES.join(' ')}`,
  `style-src 'self' 'unsafe-inline' ${PLAYGROUND_CDN_SOURCES.join(' ')}`,
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ');

/**
 * @param {string} endpoint - absolute path the fetcher posts to.
 * @returns {string} the playground HTML document.
 */
const playgroundHtml = (endpoint = '/graphql') => `<!doctype html>
<html lang="en">
  <head>
    <title>Stellar Tags — GraphQL</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
    <style>
      body { margin: 0; height: 100vh; }
      #graphiql { height: 100vh; }
    </style>
  </head>
  <body>
    <div id="graphiql">Loading…</div>
    <script type="module">
      import React from 'https://esm.sh/react@18.3.1';
      import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
      import GraphiQL from 'https://unpkg.com/graphiql@3/graphiql.min.js';

      const fetcher = async (graphQLParams) => {
        const response = await fetch(${JSON.stringify(endpoint)}, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(graphQLParams),
        });
        return response.json();
      };

      createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, { fetcher, defaultEditorToolsVisibility: true }),
      );
    </script>
  </body>
</html>
`;

module.exports = { playgroundHtml, playgroundPolicy, PLAYGROUND_CDN_SOURCES };
