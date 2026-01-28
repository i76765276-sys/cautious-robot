# WRLD Device Agent

This agent reports installed apps to the WRLD ENT server.
Browsers cannot read installed programs, so this is the safe method.

## Steps
1) Generate an API key in your dashboard (Dash → API Keys).
2) Edit `apps.json` to list your apps.
3) Run:

node agent.js --base http://localhost:3000 --key YOUR_API_KEY --device "My PC"

The dashboard will show the reported apps.
