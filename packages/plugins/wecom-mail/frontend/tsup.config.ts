import { defineFrontendConfig } from '../../../../scripts/tsup-preset.mjs';

// Host externals and the JSX runtime live in one shared preset (see
// `scripts/tsup-preset.mjs`); a per-package copy is what drifted before.
export default defineFrontendConfig();
