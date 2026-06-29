const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'server.js');
let code = fs.readFileSync(targetFile, 'utf8');

const injection = `
// ========================================================
// #54 — Explicit Dual Routing Interception Layer
// ========================================================
const express = require('express');
const originalExpress = express;

function MockExpress() {
  const app = originalExpress();
  const apiRouter = originalExpress.Router();
  
  const wrapMethod = (method) => {
    const original = app[method].bind(app);
    app[method] = function(p, ...handlers) {
      if (typeof p === 'string' && p.startsWith('/') && !p.startsWith('/api/v1')) {
        apiRouter[method](p, ...handlers);
      }
      return original(p, ...handlers);
    };
  };

  ['get', 'post', 'put', 'delete', 'patch'].forEach(wrapMethod);

  const originalListen = app.listen.bind(app);
  app.listen = function(...args) {
    app.use('/api/v1', apiRouter);
    return originalListen(...args);
  };

  return app;
}

Object.assign(MockExpress, originalExpress);
require.cache[require.resolve('express')] = {
  exports: MockExpress
};
// ========================================================
`;

fs.writeFileSync(targetFile, injection + code, 'utf8');
console.log('Successfully applied structural API routes reflection matrix!');
