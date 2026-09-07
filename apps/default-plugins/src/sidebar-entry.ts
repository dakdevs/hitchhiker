import { definePlugin } from "@hitchhiker/plugin-sdk";
import { createPresenterPlugin } from "./presenter.ts";
definePlugin(createPresenterPlugin("sidebar"));
