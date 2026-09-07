import { definePlugin } from "@hitchhiker/plugin-sdk";

import { createDevToolsPlugin } from "./devtools.ts";

definePlugin(createDevToolsPlugin());
