import { z } from "zod";

// Run before schemas load so Zod skips the eval probe blocked by the renderer's CSP.
z.config({ jitless: true });
