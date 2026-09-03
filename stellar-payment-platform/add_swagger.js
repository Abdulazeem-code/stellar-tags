const fs = require('fs');
const path = require('path');

let serverContent = fs.readFileSync('server.js', 'utf8');

// Insert imports
serverContent = serverContent.replace(
  `const express = require('express');`,
  `const express = require('express');\nconst swaggerJsdoc = require('swagger-jsdoc');\nconst swaggerUi = require('swagger-ui-express');`
);

// Insert Swagger setup
const swaggerSetup = `
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Stellar Tags API',
      version: '1.0.0',
      description: 'API for Stellar Tags',
    },
    servers: [
      {
        url: 'http://localhost:5000',
      },
    ],
  },
  apis: ['./server.js', './src/routes/v1/*.js'],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
`;

serverContent = serverContent.replace(
  `const app = express();`,
  `const app = express();\n${swaggerSetup}`
);

// Basic annotation logic for a route
function annotateRoutes(content) {
  return content.replace(/((?:app|router)\.(get|post|put|delete|patch|options))\(\s*['"]([^'"]+)['"]/g, (match, prefix, method, routePath, offset, str) => {
    // Check if there is already a JSDoc comment immediately before
    const beforeStr = str.substring(Math.max(0, offset - 200), offset);
    if (beforeStr.includes('/**') && beforeStr.includes('@openapi')) return match;
    if (beforeStr.includes('/**') && beforeStr.includes('@swagger')) return match;

    const tag = 'v1'; // Generic tag
    const annotation = `
/**
 * @openapi
 * ${routePath}:
 *   ${method}:
 *     tags:
 *       - ${tag}
 *     description: ${method.toUpperCase()} ${routePath}
 *     responses:
 *       200:
 *         description: Success
 */
`;
    return annotation + match;
  });
}

serverContent = annotateRoutes(serverContent);
fs.writeFileSync('server.js', serverContent);

const v1Dir = path.join('src', 'routes', 'v1');
const files = fs.readdirSync(v1Dir);
files.forEach(file => {
  if (!file.endsWith('.js')) return;
  const filePath = path.join(v1Dir, file);
  let fileContent = fs.readFileSync(filePath, 'utf8');
  fileContent = annotateRoutes(fileContent);
  fs.writeFileSync(filePath, fileContent);
});

console.log('Done!');
