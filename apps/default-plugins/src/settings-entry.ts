import { definePlugin } from "@hitchhiker/plugin-sdk";

import { createSettingsPlugin } from "./settings.ts";

definePlugin(createSettingsPlugin());
