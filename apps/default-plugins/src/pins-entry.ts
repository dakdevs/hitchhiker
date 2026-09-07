import { definePlugin } from "@hitchhiker/plugin-sdk";
import { createTabPinsPlugin } from "./tab-pins.ts";
definePlugin(createTabPinsPlugin());
