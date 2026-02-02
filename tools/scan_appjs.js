const fs = require('fs');

const filePath = process.argv[2] || 'public/app.js';
const startLineArg = process.argv[3] ? Number(process.argv[3]) : null;
const endLineArg = process.argv[4] ? Number(process.argv[4]) : null;

const fullSrc = fs.readFileSync(filePath, 'utf8');
let src = fullSrc;
if (startLineArg || endLineArg) {
  const lines = fullSrc.split(/\r?\n/);
  const start = Math.max(1, startLineArg || 1);
  const end = Math.min(lines.length, endLineArg || lines.length);
  src = lines.slice(start - 1, end).join('\n') + '\n';
}

let line = 1;
let col = 0;

/** @type {Array<{ch:string,line:number,col:number}>} */
const stack = [];

function push(ch) {
  stack.push({ ch, line, col });
}

function pop(expected) {
  const top = stack.pop();
  if (!top || top.ch !== expected) {
    const got = top ? `${top.ch} at ${top.line}:${top.col}` : 'EMPTY';
    throw new Error(`MISMATCH: expected ${expected} at ${line}:${col}, got ${got}`);
  }
}

let i = 0;
let mode = 'code'; // code | lineComment | blockComment | string | template
let quote = '';
let stringStart = null; // { line, col, quote }
let templateStart = null; // { line, col }
let templateExprDepth = 0; // when inside ${...}, we temporarily parse code and count braces

while (i < src.length) {
  const c = src[i];
  const n = src[i + 1];

  col += 1;
  if (c === '\n') {
    line += 1;
    col = 0;
  }

  if (mode === 'lineComment') {
    if (c === '\n') mode = 'code';
    i += 1;
    continue;
  }

  if (mode === 'blockComment') {
    if (c === '*' && n === '/') {
      mode = 'code';
      i += 2;
      col += 1;
      continue;
    }
    i += 1;
    continue;
  }

  if (mode === 'string') {
    if (c === '\\') {
      // escape next char
      i += 2;
      col += 1;
      continue;
    }
    if (c === quote) {
      mode = 'code';
      quote = '';
      stringStart = null;
    }
    i += 1;
    continue;
  }

  if (mode === 'template') {
    if (c === '\\') {
      i += 2;
      col += 1;
      continue;
    }

    if (templateExprDepth > 0) {
      // inside ${ ... } expression: parse like code
      if (c === '/' && n === '/') {
        mode = 'lineComment';
        i += 2;
        col += 1;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'blockComment';
        i += 2;
        col += 1;
        continue;
      }
      if (c === '"' || c === "'") {
        mode = 'string';
        quote = c;
        i += 1;
        continue;
      }
      if (c === '`') {
        // nested template literal
        mode = 'template';
        i += 1;
        continue;
      }

      if (c === '(' || c === '{' || c === '[') push(c);
      else if (c === ')') pop('(');
      else if (c === ']') pop('[');
      else if (c === '}') {
        // first close normal brace, then possibly close template expr
        if (stack.length && stack[stack.length - 1].ch === '{') {
          pop('{');
        } else {
          // this closes the ${...}
          templateExprDepth -= 1;
          if (templateExprDepth < 0) {
            throw new Error(`Template expr depth underflow at ${line}:${col}`);
          }
        }
      }

      i += 1;
      continue;
    }

    // template raw text
    if (c === '`') {
      mode = 'code';
      templateStart = null;
      i += 1;
      continue;
    }
    if (c === '$' && n === '{') {
      templateExprDepth += 1;
      push('{');
      i += 2;
      col += 1;
      continue;
    }

    i += 1;
    continue;
  }

  // mode === 'code'
  if (c === '/' && n === '/') {
    mode = 'lineComment';
    i += 2;
    col += 1;
    continue;
  }
  if (c === '/' && n === '*') {
    mode = 'blockComment';
    i += 2;
    col += 1;
    continue;
  }
  if (c === '"' || c === "'") {
    mode = 'string';
    quote = c;
    stringStart = { line, col, quote: c };
    i += 1;
    continue;
  }
  if (c === '`') {
    mode = 'template';
    templateExprDepth = 0;
    templateStart = { line, col };
    i += 1;
    continue;
  }

  if (c === '(' || c === '{' || c === '[') push(c);
  else if (c === ')') pop('(');
  else if (c === '}') pop('{');
  else if (c === ']') pop('[');

  i += 1;
}

if (mode !== 'code') {
  console.log('END mode:', mode);
  if (mode === 'string' && stringStart) {
    console.log('Unclosed string started at', `${stringStart.line}:${stringStart.col}`, 'quote=', stringStart.quote);
  }
  if (mode === 'template' && templateStart) {
    console.log('Unclosed template started at', `${templateStart.line}:${templateStart.col}`);
  }
}

if (stack.length) {
  console.log('UNBALANCED STACK (tail):');
  console.log(stack.slice(-30));
  process.exit(2);
}

console.log('OK: brackets look balanced for', filePath);
