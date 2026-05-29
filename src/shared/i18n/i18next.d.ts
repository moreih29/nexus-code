/**
 * i18next module augmentation — type-safe t() keys.
 *
 * `CustomTypeOptions` narrows the i18next `t()` function to the exact key
 * structure defined in the English locale files (the canonical reference).
 * TypeScript will error if a key does not exist in any of the declared
 * namespaces, preventing typos from reaching production.
 *
 * Both the main and renderer tsconfig projects include `src/shared/**` via
 * tsconfig.shared.json, so this declaration is picked up everywhere.
 */

import type { resources, I18N_DEFAULT_NS } from "./index";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof I18N_DEFAULT_NS;
    resources: (typeof resources)["en"];
  }
}
