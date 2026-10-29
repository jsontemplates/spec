#!/bin/sh
# Checks the schemas, validates every example against them and checks the
# conformance fixtures. Requires Node.js. It can be run from any directory.
set -e
cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund --silent
npm test
