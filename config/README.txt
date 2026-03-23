VISRODECK VRE — Configuration

public.pem:
  This file must contain the RSA public key from the Visrodeck Auth Server.
  Steps:
  1. Set up visrodeck-auth-server (run: node admin.js setup)
  2. Run: node admin.js pubkey
  3. Copy the output and replace this file's contents with it.
  4. Without the correct public key, license verification will fail.

vre.config.json:
  VRE kernel configuration (port, Ollama settings).
  Set VRE_AUTH_SERVER env var to point Jane at your auth server.
  Default: https://auth.visrodeck.com (must be set to your server URL)
