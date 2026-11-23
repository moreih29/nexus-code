import type { I18N_DEFAULT_NS, resources } from "./index";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof I18N_DEFAULT_NS;
    resources: (typeof resources)["en"];
  }
}
