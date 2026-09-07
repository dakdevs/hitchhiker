import { definePlugin } from "@hitchhiker/plugin-sdk";
import { createLayoutPlugin } from "./layout.ts";
definePlugin(createLayoutPlugin());
