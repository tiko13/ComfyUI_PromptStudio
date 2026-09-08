// Prompt Studio is independently testable, even with a companion installed.
// Video CI opts in explicitly; missing/broken companion files then fail normally.
export const videoEnabled = process.env.STUDIO_TEST_VIDEO === '1';
export const videoTestOptions = {skip: videoEnabled ? false : 'Video integration is opt-in (STUDIO_TEST_VIDEO=1)'};
