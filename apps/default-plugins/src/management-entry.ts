import { definePlugin } from "@hitchhiker/plugin-sdk";

import { createPluginManagementPlugin } from "./management.ts";

definePlugin(createPluginManagementPlugin());
