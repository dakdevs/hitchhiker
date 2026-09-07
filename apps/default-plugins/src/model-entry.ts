import { definePlugin } from "@hitchhiker/plugin-sdk";
import { createTabModelPlugin } from "./tab-model.ts";
definePlugin(createTabModelPlugin());
