# Studio browser checks

This harness loads the real Image and Video application modules into Chromium, serves both repositories from an ephemeral loopback fixture server, and mocks ComfyUI/provider endpoints. Browser contexts have isolated storage and all external network requests are blocked. It never connects to the user's ComfyUI runtime or queues real generation.

Install development dependencies with `npm ci`, then `npx playwright install chromium`. Run `npm run test:browser` from Image Studio with Video Studio checked out beside it. Node 24 is used in CI. No development installation is required to run the custom nodes.

An existing Chromium executable can be supplied through `BROWSER_EXECUTABLE`; an existing Playwright package path through `PLAYWRIGHT_MODULE`. Results and screenshots are written to ignored `test-results/browser/`.

Current browser scenarios: dual-studio initialization, repeated New chat retaining one empty session, keyboard modal focus/escape/return, desktop/narrow/reduced-motion rendering, Video save/reload, and real two-client conflict review/retry. Synthetic Node/Python suites separately cover cancellation, immutable snapshots, and protected-content authority. Additional plot/job/replay/popup scenarios are being added as the corresponding audit tasks integrate; this is not a claim of live LLM, GPU, or screen-reader validation.

Both repositories have CI checks. The Image publish workflow depends on its reusable quality workflow. Each CI run checks the exact source under review plus the companion repository's default branch. Coordinated changes must be validated together locally before releasing either repository; the CI companion default is not an implicit paired commit pin.

Development packages do not add runtime startup dependencies. CI uses CPU torch, numpy, Pillow, PyAV and aiohttp to exercise the existing tests on a fresh runner. The Linux hosted workflow itself must still be observed after push; local Windows checks cannot certify hosted execution.
