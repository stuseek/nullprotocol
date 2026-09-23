#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const readmePath = path.join(__dirname, '..', 'README.md');

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = packageJson.version;

let readme = fs.readFileSync(readmePath, 'utf8');

// Update version in README
readme = readme.replace(
  /- \*\*Version\*\*: [0-9.]+/g,
  `- **Version**: ${version}`
);

// Update version in npm install examples if present
readme = readme.replace(
  /nullprotocol@[0-9.]+/g,
  `nullprotocol@${version}`
);

fs.writeFileSync(readmePath, readme);

console.log(`✅ Synced version ${version} to README.md`);
