'use strict';

// 语法自检：把 extension/ 下所有 .js 用 vm.Script 解析一遍。
// 只解析、不执行，所以既能查 Node 模块也能查 webview 里的浏览器脚本。
//
// 运行：build\node.cmd build\check-syntax.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'extension');
const targets = [];

(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) targets.push(full);
  });
})(root);

let failed = 0;
targets.forEach((file) => {
  const rel = path.relative(root, file);
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    console.log('OK   ' + rel);
  } catch (error) {
    failed += 1;
    console.log('FAIL ' + rel + ' :: ' + error.message);
  }
});

console.log(failed === 0
  ? '语法检查通过（' + targets.length + ' 个文件）'
  : '语法检查失败：' + failed + ' / ' + targets.length + ' 个文件');
process.exitCode = failed === 0 ? 0 : 1;