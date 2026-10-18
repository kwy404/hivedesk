#!/usr/bin/env node
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { name: { type: 'string' } } });
if (!values.name) { console.error('usage: tool --name <name>'); process.exit(1); }
console.log(`hello ${values.name}`);
