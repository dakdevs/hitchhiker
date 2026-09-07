import { definePlugin } from "@hitchhiker/plugin-sdk";

import { createExtensionManagementPlugin } from "./extensions.ts";

definePlugin(createExtensionManagementPlugin());
