#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Jane..."
cd modules/jane-ui
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi
npm run dev
