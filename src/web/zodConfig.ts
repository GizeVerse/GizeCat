// Imported first by main.ts, before any schema exists (src/shared builds its zod schemas when it is
// evaluated). zod's JIT probes `new Function` once; the page's CSP has no 'unsafe-eval', so the
// probe is refused and the browser reports a securitypolicyviolation, even though zod catches the
// throw and falls back. `jitless` skips the probe and the JIT: same results, no violation (M5).
import { z } from 'zod';

z.config({ jitless: true });
