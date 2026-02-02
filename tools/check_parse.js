const fs = require('fs');
const vm = require('vm');

const filePath = process.argv[2] || 'public/app.js';
const maxLine = process.argv[3] ? Number(process.argv[3]) : null;

const full = fs.readFileSync(filePath, 'utf8');
const src = maxLine ? full.split(/\r?\n/).slice(0, maxLine).join('\n') + '\n' : full;

try {
  // Parse/compile only (do not execute)
  new vm.Script(src, { filename: filePath });
  console.log('PARSE OK', filePath, maxLine ? `(first ${maxLine} lines)` : '(full)');
} catch (e) {
  console.error('PARSE NG', filePath, maxLine ? `(first ${maxLine} lines)` : '(full)');
  console.error(String((e && e.stack) || e));
  process.exit(1);
}
