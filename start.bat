@echo off
title Jane v1.7.5 — Visrodeck
cd /d "%~dp0"
echo Starting Jane...
cd modules\jane-ui
if not exist node_modules (
  echo Installing dependencies...
  npm install
)
npm run dev
