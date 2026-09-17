#!/usr/bin/env bun
if (process.env.NODE_ENV == null) process.env.NODE_ENV = 'production'
await import('./server/index.js')
