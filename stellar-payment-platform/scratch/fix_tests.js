const fs = require('fs');
const glob = require('glob'); // Not available? I'll just hardcode file paths or use fs.readdirSync recursively.
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir('c:/Users/USER/Downloads/stellar-tags/stellar-payment-platform', function(filePath) {
  if (filePath.endsWith('.js') && (filePath.includes('test') || filePath.includes('soft-delete'))) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    content = content.replace(/poolGetFn:\s*jest\.fn\(\),?/g, '');
    content = content.replace(/poolRunFn:\s*jest\.fn\(\),?/g, '');
    content = content.replace(/poolAllFn:\s*jest\.fn\(\),?/g, '');
    content = content.replace(/poolGet:\s*jest\.fn\(\),?/g, '');
    content = content.replace(/poolRun:\s*jest\.fn\(\),?/g, '');
    content = content.replace(/poolAll:\s*jest\.fn\(\),?/g, '');

    content = content.replace(/,\s*poolRunFn/g, '');
    content = content.replace(/,\s*poolGetFn/g, '');
    content = content.replace(/,\s*poolAllFn/g, '');

    content = content.replace(/const { poolGet } = require\('\.\.\/src\/db'\);/g, '');
    content = content.replace(/const { poolGet } = require\("\.\/src\/db"\);/g, '');

    if (original !== content) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Fixed', filePath);
    }
  }
});
