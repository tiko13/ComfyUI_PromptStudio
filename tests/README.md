# Independent and companion checks

Prompt Studio runs without Video Studio. Only Video Studio has a hard dependency
on Prompt Studio. The default Python, JavaScript and browser suites test Prompt
Studio independently, even when a sibling Video Studio checkout exists.

Run `python -B -m unittest discover -s tests`, `npm test`, `npm run check:types`
and `npm run test:browser` from this repository. On the usual Windows installation,
use `C:\EasyDiffusion\ComfyUI\venv\Scripts\python.exe` for Python commands.

Set `STUDIO_TEST_VIDEO=1` to also run companion integration checks against a
sibling `PromptStudio_Video` checkout. This is explicit opt-in, not automatic
file detection: missing or broken companion files fail the integration run.
Video Studio's quality workflow enables this mode and runs both repositories.
Prompt Studio's quality workflow checks out only Prompt Studio.

The browser fixture serves no Video Studio assets or endpoints in independent
mode. Mixed suites retain their Image Studio assertions; only Video-specific
sections and suites are omitted. Node and Python report companion checks as
skipped; the browser runner lists omitted suites separately from passed suites.
