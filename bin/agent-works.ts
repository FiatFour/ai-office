#!/usr/bin/env node
import { run } from '../server/cli.ts';

process.exitCode = await run(process.argv.slice(2), process.env);
